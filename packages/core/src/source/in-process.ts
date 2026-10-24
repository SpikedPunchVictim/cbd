/**
 * Coverage from inside the running process, via `node:inspector`.
 *
 * This is the only source v1 needs: japa runs unit tests in one process, so the
 * code under test and the test runner share a heap and attribution is exact.
 *
 * Two properties matter and both were verified before this was written:
 *
 *   - `takePreciseCoverage` with `callCount: true` RETURNS AND RESETS, so each
 *     take is a genuine per-window delta rather than a running total (spike S1a).
 *   - the session's `post` invokes its callback before returning, so a fully
 *     synchronous `takeSync()` is possible inside a hook the runner never awaits
 *     (spike S1b, load-bearing because of A0 F1).
 */
import inspector from 'node:inspector'
import type { InstrumentScope } from '../instrument-protocol.js'
import { buildLineIndex } from '../line-index.js'
import type { GeneratedScript, ScriptInfo, Source, V8ScriptCoverage } from '../types.js'

interface SessionResult {
  result: V8ScriptCoverage[]
}

interface ScriptSourceResult {
  scriptSource: string
}

export async function inProcessSource(): Promise<Source> {
  const session = new inspector.Session()
  session.connect()

  const scripts = new Map<string, ScriptInfo>()
  /**
   * Scripts whose text the inspector would not give us.
   *
   * A transformed script whose text is missing cannot be converted against the file
   * on disk, so the build must mark its file partial rather than index the wrong
   * bytes — the same signal the socket and inspector sources carry.
   */
  const missingGenerated = new Set<string>()
  let closed = false

  function generatedFor(scriptId: string): GeneratedScript | undefined {
    if (closed) return undefined
    const holder: { done?: boolean; source?: string; error?: Error } = {}
    try {
      session.post('Debugger.getScriptSource', { scriptId }, (err, res) => {
        holder.done = true
        if (err) holder.error = err
        else holder.source = (res as ScriptSourceResult).scriptSource
      })
    } catch {
      return undefined
    }
    if (!holder.done || holder.error !== undefined || holder.source === undefined) return undefined
    const index = buildLineIndex(holder.source)
    return { lineStarts: index.starts, length: index.length }
  }

  session.on('Debugger.scriptParsed', (event) => {
    const params = event.params
    scripts.set(params.scriptId, {
      url: params.url,
      sourceMapURL: params.sourceMapURL,
    })
  })

  const generated = (scriptId: string): GeneratedScript | undefined =>
    scripts.get(scriptId)?.generated

  /**
   * Fetch generated text for the recorded scripts.
   *
   * Called by the recorder's `prepare()` after the last test, never at a window
   * boundary. A synchronous source read in a closing window lengthened that
   * window and broke the boundary-drift measurement (`cbd-x2j`, the straddle
   * e2e); the inspector answers synchronously, so the end of the run is the right
   * place to pay for it.
   */
  function prepare(scriptIds: readonly string[]): void {
    for (const scriptId of scriptIds) {
      if (closed) return
      const info = scripts.get(scriptId)
      if (info === undefined || info.generated !== undefined) continue
      if (!info.url.startsWith('file:') || info.sourceMapURL === undefined) continue
      const value = generatedFor(scriptId)
      // The script has a map, so the file on disk is not the text V8 compiled. An
      // answer the inspector would not produce is a loss the build has to know about.
      if (value !== undefined) info.generated = value
      else missingGenerated.add(scriptId)
    }
  }

  const call = (method: string, params: Record<string, unknown> = {}): Promise<SessionResult> =>
    new Promise((resolve, reject) => {
      session.post(method, params, (err, res) => {
        if (err) reject(err)
        else resolve(res as SessionResult)
      })
    })

  await call('Profiler.enable')
  await call('Debugger.enable')

  // The counters belong to the isolate, not to a session, so two collectors in one
  // process split one stream of execution between them. A suite that starts a
  // service of its own has to carry `NODE_OPTIONS` for the child to be instrumented
  // at all (ADR-0005), which means the injected module is running here too — and
  // its periodic self-snapshot would consume execution this source's next window is
  // drawn from. Measured in that exact shape: a window that ran a function twice
  // reported one call when the other client took between them.
  //
  // So the module stands down when the in-process source is what is collecting:
  // one process, one collector. It remains loaded, and its purpose here — being in
  // the environment a suite's children inherit — is unaffected.
  //
  // **Standing down is a handoff, not a discard.** The module starts at process
  // birth and its snapshots have already taken whatever ran before this source
  // existed — which includes the test runner's static imports. Those counters are
  // reset when taken, so if they are not adopted here they are lost, and a module
  // that only ever executes during import leaves no evidence at all (`cbd-1ci`).
  // They arrive as the first window's prefix, in the `@load` bucket where they
  // belong.
  //
  // The handoff must finish before this session starts its own coverage, so the
  // final take inside `stop()` drains the counters first and everything after it
  // is this source's.
  const instrument = (globalThis as InstrumentScope).__cbdInstrument
  const handed = instrument === undefined ? [] : await instrument.stop()
  let carried: V8ScriptCoverage[] = Array.isArray(handed) ? handed : []
  const carriedOnce = (payload: V8ScriptCoverage[]): V8ScriptCoverage[] => {
    if (carried.length === 0) return payload
    const prefix = carried
    carried = []
    return [...prefix, ...payload]
  }

  await call('Profiler.startPreciseCoverage', { callCount: true, detailed: false })

  const takeSync = (): V8ScriptCoverage[] => {
    // A holder rather than a plain `let`, so TypeScript does not narrow the
    // variable to its initial value across the callback boundary.
    const holder: { done?: boolean; value?: V8ScriptCoverage[]; error?: Error } = {}
    session.post('Profiler.takePreciseCoverage', {}, (err, res) => {
      holder.done = true
      if (err) holder.error = err
      else holder.value = (res as SessionResult).result
    })
    if (!holder.done) {
      throw new Error(
        'inProcessSource.takeSync: the inspector session did not respond synchronously',
      )
    }
    if (holder.error) throw holder.error
    return carriedOnce(holder.value ?? [])
  }

  return {
    kind: 'in-process',
    supportsSync: true,
    takeSync,
    take: async () => carriedOnce((await call('Profiler.takePreciseCoverage')).result),
    scripts: () => scripts,
    generated,
    prepare,
    generatedMissing: () => [...missingGenerated],
    close: () => {
      closed = true
      try {
        session.post('Profiler.stopPreciseCoverage', () => {})
      } catch {
        // the session may already be gone; nothing useful to do
      }
      try {
        session.disconnect()
      } catch {
        // as above
      }
    },
  }
}
