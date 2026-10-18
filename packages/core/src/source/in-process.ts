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
import type { ScriptInfo, Source, V8ScriptCoverage } from '../types.js'

interface SessionResult {
  result: V8ScriptCoverage[]
}

export async function inProcessSource(): Promise<Source> {
  const session = new inspector.Session()
  session.connect()

  const scripts = new Map<string, ScriptInfo>()
  session.on('Debugger.scriptParsed', (event) => {
    const params = event.params
    scripts.set(params.scriptId, {
      url: params.url,
      sourceMapURL: params.sourceMapURL,
    })
  })

  const call = (method: string, params: Record<string, unknown> = {}): Promise<SessionResult> =>
    new Promise((resolve, reject) => {
      session.post(method, params, (err, res) => {
        if (err) reject(err)
        else resolve(res as SessionResult)
      })
    })

  await call('Profiler.enable')
  await call('Debugger.enable')
  await call('Profiler.startPreciseCoverage', { callCount: true, detailed: false })

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
  const instrument = (globalThis as InstrumentScope).__cbdInstrument
  instrument?.stop()

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
    return holder.value ?? []
  }

  return {
    kind: 'in-process',
    supportsSync: true,
    takeSync,
    take: async () => (await call('Profiler.takePreciseCoverage')).result,
    scripts: () => scripts,
    close: () => {
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
