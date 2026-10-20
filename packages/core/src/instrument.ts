/**
 * The injected entry point — `NODE_OPTIONS="--import @spikedpunch/cbd/instrument"`.
 *
 * This file is loaded *into the target process*, next to its own code, so the
 * rules it obeys are different from every other module in the package.
 *
 * **It must never be re-exported from `index.ts`.** Importing `@spikedpunch/cbd`
 * has to stay free of side effects; this module's whole purpose is a side effect.
 * It reaches the world only through the `./instrument` subpath, which nothing but
 * `NODE_OPTIONS` should name.
 *
 * **It is inert unless asked.** Everything is gated on `CBD_SOCKET_DIR`: with that
 * unset the module evaluates two lines of environment lookup and returns. This is
 * not politeness. `NODE_OPTIONS` is inherited by the whole process tree, so this
 * code runs in every Node process a developer starts — including ones that have
 * nothing to do with CBD and ones where an inspector session would be unwelcome
 * (ADR-0005).
 *
 * **It is silent.** No stdout, no stderr, ever. It is a guest in someone else's
 * process, and that process's output is not this module's to write to. The spike
 * this is built from printed a ready line, which was right for a spike and wrong
 * here.
 *
 * **It never takes the host down.** Socket errors, a duplicate import, a stale
 * socket file, an inspector that will not connect — each is swallowed. A coverage
 * tool that crashes the service it is measuring has cost far more than it saved.
 *
 * **It does not exit the process on `close`.** The spike did, which is fine for a
 * spike. A real service is expected to outlive the test run that is reading it.
 * `close` stops coverage, disconnects the session and removes the socket; the
 * service keeps serving.
 *
 * What it serves, and why the script table matters, is in
 * `instrument-protocol.ts`. The short version: `take` returns the coverage delta
 * *and* the scripts parsed since the last take, because `V8ScriptCoverage` carries
 * no `sourceMapURL` and without one a compiled service cannot be mapped back to
 * its sources.
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import inspector from 'node:inspector'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLineIndex } from './line-index.js'
import { sourceMapUrlOf } from './source-maps.js'
import type { GeneratedScript, V8Function, V8Range, V8ScriptCoverage } from './types.js'
import {
  CORRELATION_HEADER_ENV,
  INSTRUMENT_PROTOCOL,
  LineSplitter,
  SOCKET_DIR_ENV,
  encodeMessage,
  nowUs,
  resolveRole,
  snapshotPath,
  type HelloResult,
  type InstrumentRequest,
  type InstrumentResponse,
  type InstrumentScope,
  type RequestWindow,
  type ScriptRow,
  type SnapshotFile,
  type SnapshotWindow,
  type TakeResult,
} from './instrument-protocol.js'

interface SessionReply {
  result: V8ScriptCoverage[]
}

/**
 * Guards against a second import — `--import` naming the module twice, or a
 * loader and a `--import` both pulling it in — and carries the off switch a
 * collector in this same process uses. The properties are namespaced so they
 * cannot collide with the host's own state.
 */
const scope = globalThis as InstrumentScope

/**
 * How stale the on-disk snapshot can be when a process is killed outright.
 *
 * Named rather than chosen by feel (ADR-0007): it is simultaneously the cost every
 * instrumented process pays and the amount of coverage a SIGKILL can take with it.
 *
 * `CBD_SNAPSHOT_MS` overrides it. `0` turns the *periodic* write off and keeps the
 * exit write: a crash then loses the run (its shard has no footer and is refused),
 * which is a measured trade, not a silent one. The knob exists because the write is
 * a full serialization of the un-drained state — on a service handling thousands of
 * requests between two test boundaries that state reached hundreds of MB, and
 * rewriting it every 500 ms put the instrument at ~97% CPU and the suite at 100×
 * its unrecorded time (`cbd-n9t.2`).
 */
const SNAPSHOT_INTERVAL_MS = snapshotInterval(process.env.CBD_SNAPSHOT_MS)

function snapshotInterval(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 500
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 500
}

const socketDir = process.env[SOCKET_DIR_ENV]

if (socketDir !== undefined && socketDir !== '' && scope.__cbdInstrumented !== true) {
  scope.__cbdInstrumented = true
  await start(socketDir)
}

async function start(dir: string): Promise<void> {
  const session = new inspector.Session()
  try {
    session.connect()
  } catch {
    // No inspector available. Nothing to serve, and the host must not care.
    return
  }

  const call = (method: string, params: Record<string, unknown> = {}): Promise<SessionReply> =>
    new Promise((resolve, reject) => {
      session.post(method, params, (error, reply) => {
        if (error) reject(error)
        else resolve(reply as SessionReply)
      })
    })

  /**
   * Two structures, because the two consumers want different lifetimes.
   * `scripts` is the full table, never drained — it is what a client can be
   * handed when it asks. `pending` is the un-sent queue, drained by each take.
   */
  const scripts = new Map<string, ScriptRow>()
  const pending: ScriptRow[] = []

  // -------------------------------------------------------------------------
  // ADR-0007's second mechanism: leave the coverage behind
  // -------------------------------------------------------------------------
  //
  // A process that dies before its reply is read takes the coverage with it, and
  // no boundary can be taken from a process that no longer exists. So this side
  // keeps what it has not been told arrived, and writes it beside its socket.
  //
  // **`unacked`, not `lifetime`.** Coverage handed to a client is dropped as soon
  // as the client says it absorbed it, so the file holds exactly what the map is
  // missing — never the same execution twice. A process nobody ever read keeps
  // everything, which is the grizzly shape.
  //
  // **The interval is a bound on both the cost and the gap.** The file is what
  // survives a SIGKILL, and a SIGKILL runs no handler; so the snapshot has to be
  // written *before* the process dies rather than at exit. 500ms is the longest
  // gap worth having against test windows measured in tens of milliseconds to a
  // few seconds, and the write is small once a client is taking (only the
  // unacknowledged window). The exit handler makes one final, exact write.
  const startedAtUs = nowUs()
  const unacked = new Map<number, SnapshotWindow>()
  /** Taken since the last client take. Never handed to anyone yet. */
  let untaken = new Map<string, V8ScriptCoverage>()
  /** Serializes inspector takes: two `takePreciseCoverage` calls interleaved would split a delta. */
  let taking: Promise<unknown> = Promise.resolve()
  let snapshotTimer: NodeJS.Timeout | null = null

  // -------------------------------------------------------------------------
  // Request-id correlation
  // -------------------------------------------------------------------------
  //
  // The collector names a header with the `correlate` op. From then on every
  // HTTP request that carries it opens a *tagged* window: a take when the request
  // arrives, and another when its response finishes or its socket closes. The two
  // deltas carry the ids that were in flight for their interval, which is what
  // lets the collector credit a request's work to the test that sent it rather
  // than to whichever test's boundary happened to be open when it ran.
  //
  // A request without the header is invisible here. It contributes its execution
  // to whichever window is next taken, exactly as before — usually a test's own
  // boundary, sometimes `@between`. Correlation adds precision; it does not make
  // an uncorrelated request less safe.
  let requestCorrelation: string | null = null
  /**
   * How many open requests carry each id. A counter rather than a set because one
   * test may have two requests in flight, and the id must survive the first one
   * finishing.
   */
  const inflight = new Map<string, number>()
  /** Boundary windows not yet delivered to the collector, in take order. */
  const requestWindows: RequestWindow[] = []
  /** Undoes the `http.Server` hook, or null when correlation is off. */
  let restoreEmit: (() => void) | null = null

  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = taking.then(work, work)
    taking = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function cloneFunction(fn: V8Function): V8Function {
    return {
      functionName: fn.functionName,
      isBlockCoverage: fn.isBlockCoverage,
      ranges: fn.ranges.map((range) => ({ ...range })),
    }
  }

  function cloneScript(script: V8ScriptCoverage): V8ScriptCoverage {
    return {
      scriptId: script.scriptId,
      url: script.url,
      functions: script.functions.map(cloneFunction),
    }
  }

  /** The root range is a function's identity inside one process. */
  function functionKey(fn: V8Function): string {
    const root = fn.ranges[0]
    return root === undefined ? '?' : `${String(root.startOffset)}:${String(root.endOffset)}`
  }

  function rangeKey(range: V8Range): string {
    return `${String(range.startOffset)}:${String(range.endOffset)}`
  }

  /**
   * Folds one function's blocks into another's.
   *
   * Counts are combined with `max`, not summed, and that is deliberate: downstream
   * only ever asks whether a range ran (`normalize.ts`: `count > 0`), and summing
   * would drift on a long run for a number nobody reads.
   */
  function mergeRanges(target: V8Function, incoming: V8Range[]): void {
    const known = new Map(target.ranges.map((range) => [rangeKey(range), range]))
    for (const range of incoming) {
      const seen = known.get(rangeKey(range))
      if (seen === undefined) {
        const copy = { ...range }
        target.ranges.push(copy)
        known.set(rangeKey(copy), copy)
      } else if (range.count > seen.count) {
        seen.count = range.count
      }
    }
  }

  /** Unions `delta` into `into`, one script and one function at a time. */
  function mergeInto(into: Map<string, V8ScriptCoverage>, delta: V8ScriptCoverage[]): void {
    for (const script of delta) {
      const existing = into.get(script.scriptId)
      if (existing === undefined) {
        into.set(script.scriptId, cloneScript(script))
        continue
      }
      const known = new Map(existing.functions.map((fn) => [functionKey(fn), fn]))
      for (const fn of script.functions) {
        const key = functionKey(fn)
        const target = known.get(key)
        if (target === undefined) {
          const copy = cloneFunction(fn)
          existing.functions.push(copy)
          known.set(key, copy)
        } else {
          mergeRanges(target, fn.ranges)
        }
      }
    }
  }

  /** The delta since the previous take, folded into what no client has taken. */
  async function accumulate(): Promise<void> {
    const reply = await call('Profiler.takePreciseCoverage')
    mergeInto(untaken, reply.result)
  }

  /**
   * One take, synchronously — for the one place an await cannot go.
   *
   * `session.post` runs its callback before returning for a session connected to
   * this same process, which is the property `inProcessSource.takeSync` is built
   * on. So the final snapshot can be exact even though `process.on('exit')` is
   * synchronous by contract: measured, three calls made before exit are reported
   * as `count: 3` from inside the handler.
   *
   * ADR-0007 originally recorded this as impossible and left the interval as the
   * only way to have anything to write. The interval is still the bound for a
   * process that is killed outright — no handler runs at all — but it is not the
   * bound for a service that exits normally, and the children this mechanism
   * exists for are exactly the ones too short-lived for a tick: on grizzly, three
   * of the five `standalone-boot` children lived 305–404 ms and left snapshots
   * with no coverage in them.
   */
  function takeSync(): V8ScriptCoverage[] | null {
    const holder: { done?: boolean; value?: V8ScriptCoverage[] } = {}
    try {
      session.post('Profiler.takePreciseCoverage', {}, (error, reply) => {
        holder.done = true
        if (error === null || error === undefined) holder.value = (reply as SessionReply).result
      })
    } catch {
      return null
    }
    return holder.done === true && holder.value !== undefined ? holder.value : null
  }

  /**
   * Takes one delta and files it under the ids in flight for its interval.
   *
   * Unlike a serve take this does not drain `untaken`: the delta `takePreciseCoverage`
   * returns is already exactly the interval since the previous take of any kind,
   * and merging it with older accumulated coverage would credit this request with
   * work that ran before it arrived. It also does not wait for the take before
   * returning — the boundary is the call, the delta is whatever the inspector
   * reports for it — and it never throws into the host.
   */
  function requestBoundary(ids: string[]): void {
    if (closed || ids.length === 0) return
    const tagged = [...ids]
    void exclusive(async () => {
      const reply = await call('Profiler.takePreciseCoverage')
      const coverage = reply.result
      if (coverage.length === 0) return
      requestWindows.push({ ids: tagged, coverage })
    }).then(
      () => {
        // Deliberately no snapshot here. The write is synchronous and was measured
        // pushing collector boundaries milliseconds late on the very fixture that
        // measures drift; the periodic snapshot and the exit handler are the same
        // bound every unacknowledged window already lives under.
      },
      () => {
        // The session is gone. There is no boundary left to record.
      },
    )
  }

  /**
   * The HTTP hook: one correlated request, from `request` to `finish`.
   *
   * Patched onto `http.Server.prototype.emit` rather than onto a framework's
   * middleware chain, because every framework built on Node's HTTP server arrives
   * through that event. That is what makes correlation framework-neutral; the cost
   * is that HTTP/2 servers are not covered, which is named in `correlate.ts`.
   */
  function observeRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const header = requestCorrelation
    if (header === null) return
    const raw = req.headers[header]
    const id = Array.isArray(raw) ? raw[0] : raw
    if (id === undefined || id === '') return

    // Close the previous interval before this request joins the set, so it is not
    // credited with work that ran before it arrived. With nothing else in flight
    // there is nothing to close: the next take carries the untagged interval too,
    // and crediting it here over-selects rather than losing it.
    if (inflight.size > 0) requestBoundary([...inflight.keys()])
    inflight.set(id, (inflight.get(id) ?? 0) + 1)

    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      // Include this request in the ids: the interval it just ended is its work.
      requestBoundary([...inflight.keys()])
      const count = inflight.get(id) ?? 0
      if (count <= 1) inflight.delete(id)
      else inflight.set(id, count - 1)
    }
    res.once('finish', finish)
    res.once('close', finish)
  }

  /** Turns correlation on for `header`, idempotently and without touching the host on failure. */
  function installCorrelation(header: string): void {
    // Node presents `IncomingMessage.headers` lower-cased, so the name has to be
    // normalized whether it arrived through the op or through the environment.
    requestCorrelation = header.trim().toLowerCase()
    if (restoreEmit !== null) return
    const original = http.Server.prototype.emit
    const patched = function (
      this: http.Server,
      event: string | symbol,
      ...args: unknown[]
    ): boolean {
      if (event === 'request') {
        try {
          observeRequest(args[0] as http.IncomingMessage, args[1] as http.ServerResponse)
        } catch {
          // A guest must never turn a request into an exception.
        }
      }
      return original.call(this, event, ...args) as boolean
    }
    try {
      http.Server.prototype.emit = patched as typeof http.Server.prototype.emit
      restoreEmit = () => {
        if (http.Server.prototype.emit === patched) http.Server.prototype.emit = original
        restoreEmit = null
        requestCorrelation = null
      }
    } catch {
      // A frozen prototype, or a host that replaced `http`. Correlation is
      // optional; the time-based attribution is still there.
      requestCorrelation = null
    }
  }

  /**
   * Writes the evidence, atomically, synchronously.
   *
   * The rename is what makes a snapshot usable at all: a SIGKILL in the middle of
   * a write must leave the previous file intact rather than half a JSON document
   * that the harvester would have to distrust.
   */
  function writeSnapshot(endedAtUs?: number, complete = false): void {
    if (closed) return

    // A bounded write carries only what can be recovered by take id. If there is
    // no unacknowledged take and nothing undelivered, it has nothing to say and
    // must not replace the previous file with an empty one.
    if (!complete && unacked.size === 0 && pending.length === 0) return
    if (
      complete &&
      unacked.size === 0 &&
      untaken.size === 0 &&
      scripts.size === 0 &&
      requestWindows.length === 0
    ) {
      return
    }

    // Only the rows the harvester may not have. A row delivered by an
    // acknowledged take is in that take's reply, which the collector absorbed, so
    // repeating it here would rewrite the whole script table after every
    // boundary — 12 MB on a lane server, measured at ~1 ms per boundary
    // (`cbd-3z1`). What is kept is the unacknowledged part, which is the whole
    // table only until the first take is acked.
    const kept = new Map<string, ScriptRow>()
    for (const row of pending) kept.set(row.id, row)
    for (const window of unacked.values()) {
      for (const row of window.scripts ?? []) kept.set(row.id, row)
    }

    // `windows` and `untaken` are disjoint by construction: a take moves the
    // accumulated coverage into a window and resets the accumulator. Keeping them
    // separate is what lets the harvester attribute a lost reply to its own
    // boundary without ever counting the same execution twice.
    const file: SnapshotFile = {
      protocol: INSTRUMENT_PROTOCOL,
      pid: process.pid,
      startedAtUs,
      atUs: nowUs(),
      ...(endedAtUs === undefined ? {} : { endedAtUs }),
      scripts: [...kept.values()],
      windows: [...unacked.values()],
      // The accumulator and the request queue are unbounded between boundaries —
      // thousands of entries and hundreds of MB on a real service — and rewriting
      // them every 500 ms put the instrument at ~97% CPU (`cbd-n9t.2`). Only the
      // exit write needs them, where they are the last chance to leave what no
      // reply carried.
      ...(complete
        ? { untaken: [...untaken.values()], pendingRequests: [...requestWindows] }
        : {}),
    }
    const target = snapshotPath(dir, process.pid)
    const temporary = `${target}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify(file))
      fs.renameSync(temporary, target)
    } catch {
      // A full disk or a directory that went away: the host must not care.
    }
  }

  function removeSnapshot(): void {
    try {
      fs.unlinkSync(snapshotPath(dir, process.pid))
    } catch {
      // Never written, or already gone.
    }
  }

  /**
   * Whether the script's own file declares the map the inspector reported.
   *
   * The map is not sent when the file carries it. The build reads the same bytes,
   * and on real tsc output those inline maps were **35 MB of a 56 MB table** — the
   * bulk of the first reply whose JSON parse stalled the collector for up to
   * 170 ms (`cbd-llm`). A loader-injected map (ts-node on a `.ts` with no comment)
   * is not in the file and still travels; a file that cannot be read keeps it too,
   * because dropping a map the build cannot recover would change resolution.
   */
  const declaresMap = (url: string, reported: string): boolean => {
    if (!url.startsWith('file:')) return false
    let file: string
    try {
      file = fileURLToPath(url)
    } catch {
      return false
    }
    try {
      return sourceMapUrlOf(fs.readFileSync(file, 'utf8')) === reported
    } catch {
      return false
    }
  }

  /**
   * The generated text's line starts, fetched synchronously from the inspector.
   *
   * Only called for a script whose map had to travel — a loader-injected map. That
   * is the case where the file on disk is not the text V8 compiled, so the build
   * cannot convert offsets with the file's line index (`cbd-x2j`). A tsc-built
   * script whose file declares its map needs nothing: the file is the script.
   */
  function generatedFor(scriptId: string): GeneratedScript | undefined {
    const holder: { done?: boolean; source?: string; error?: Error } = {}
    session.post('Debugger.getScriptSource', { scriptId }, (err, res) => {
      holder.done = true
      if (err) holder.error = err
      else holder.source = (res as { scriptSource: string }).scriptSource
    })
    if (!holder.done || holder.error !== undefined || holder.source === undefined) return undefined
    const index = buildLineIndex(holder.source)
    return { lineStarts: index.starts, length: index.length }
  }

  session.on('Debugger.scriptParsed', (event) => {
    const params = event.params
    const row: ScriptRow = { id: params.scriptId, url: params.url }
    if (params.sourceMapURL !== undefined && !declaresMap(params.url, params.sourceMapURL)) {
      row.sourceMapURL = params.sourceMapURL
    }
    scripts.set(params.scriptId, row)
    pending.push(row)
  })

  // A service spawned by a recording test process inherits the header name, so it
  // is correlating from birth rather than from the collector's attach. A service
  // that was already running when the collector arrived has no such inheritance
  // and is configured by the `correlate` op instead.
  const inheritedHeader = process.env[CORRELATION_HEADER_ENV]
  if (inheritedHeader !== undefined && inheritedHeader !== '') installCorrelation(inheritedHeader)

  try {
    await call('Profiler.enable')
    // `Debugger.enable` replays `scriptParsed` for every script already compiled,
    // which is what makes the first take's script table complete rather than
    // starting from whatever happened to load afterwards.
    await call('Debugger.enable')
    await call('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
  } catch {
    disconnect()
    return
  }

  const startedAt = new Date().toISOString()
  const role = resolveRole()

  const socketPath = path.join(dir, `pid-${process.pid}.sock`)
  let closed = false

  function disconnect(): void {
    try {
      session.post('Profiler.stopPreciseCoverage', () => {})
    } catch {
      // already gone
    }
    try {
      session.disconnect()
    } catch {
      // already gone
    }
  }

  const server = net.createServer((connection) => {
    const splitter = new LineSplitter()
    connection.setEncoding('utf8')
    // A client that vanishes mid-take is routine, not exceptional.
    connection.on('error', () => {})

    connection.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) {
        if (line.trim() === '') continue
        void handle(connection, line)
      }
    })
  })

  server.on('error', () => {
    // A stale socket, a permissions problem, an unlucky race with another
    // process reusing the pid. None of it is the host's problem.
  })

  /** One take: accumulate, hand over, keep until acknowledged, leave evidence. */
  async function serveTake(
    connection: net.Socket,
    id: number,
    sentAtUs: number | undefined,
  ): Promise<void> {
    // Read *before* the take, so the number describes when this process arrived at
    // the boundary rather than when it finished serving it. The reset happens
    // inside the call below; measuring after would fold the inspector round-trip
    // into the drift and overstate it.
    const atUs = nowUs()
    // The ids in flight when the boundary was crossed describe the ordinary
    // coverage below: whatever ran while those requests were open belongs to
    // their tests too, even when another test's boundary took it first.
    const ids = [...inflight.keys()]
    // Coverage is accumulated rather than taken and sent, because the periodic
    // self-snapshot also consumes the inspector's counters. Without this a window
    // would silently lose whatever the last snapshot had already read — the same
    // under-selection, arriving one layer down.
    let delivered: ScriptRow[] = []
    // Request-boundary windows are drained with this reply. They are kept with the
    // unacknowledged window until the client says it absorbed them, because a lost
    // reply must not lose the ids that make them attributable.
    //
    // Drained inside the take queue, not before it: a request boundary enqueued
    // just before this take must land in this reply rather than the next one, and
    // that is decided by queue order, not by which event the loop happened to
    // schedule first.
    let deliveredRequests: RequestWindow[] = []
    const coverage = await exclusive(async () => {
      await accumulate()
      const payload = [...untaken.values()]
      untaken = new Map()
      deliveredRequests = requestWindows.splice(0, requestWindows.length)
      // Drained, not copied. `scriptParsed` fires once per script, so a row sent
      // twice would be the same row twice. Drained inside the take queue so two
      // takes cannot split the rows between them.
      delivered = pending.splice(0, pending.length)
      // Kept until the client acknowledges it. The reply below can sit in a socket
      // buffer forever, or die with the process; neither is visible from here, so
      // "we wrote it" is not evidence that it arrived.
      unacked.set(id, {
        takeId: id,
        ...(sentAtUs === undefined ? {} : { sentAtUs }),
        coverage: payload,
        scripts: delivered,
        ids,
        requests: deliveredRequests,
      })
      return payload
    })
    const result: TakeResult = {
      coverage,
      scripts: delivered,
      atUs,
      ids,
      requests: deliveredRequests,
    }
    // The reply goes first and the snapshot immediately after, in the same turn.
    // This window is the one a client is most likely to lose — it is in flight at
    // this very moment — and a process killed before the timer fires must still
    // leave it on disk.
    //
    // The snapshot is written after the reply because it is synchronous: writing it
    // first adds that write to the client's wait for every take. Writing it after
    // can instead stall the reply's own flush in the socket buffer — measured in
    // the own-service fixture, a 400 KB reply reached the collector as 172 KB and
    // then stopped — but that is no longer a lost window: the take has a number,
    // and a reply that never arrives is recovered from this snapshot by that
    // number.
    //
    // Either order blocks this process's loop for the write. What it writes is only
    // what no reply has delivered (see `writeSnapshot`), so after the first
    // acknowledgement it is a window, not a table. Before `cbd-3z1` it was the
    // whole table every time: measured on grizzly, mean drift 1.16 ms against
    // 114 µs without the per-take mechanism, with a tightest boundary gap of
    // 15.6 ms — the one boundary after the first take still pays for the table,
    // and every later one does not.
    reply(connection, { id, op: 'take', ok: true, result })
    writeSnapshot()
  }

  async function handle(connection: net.Socket, line: string): Promise<void> {
    let request: InstrumentRequest
    try {
      request = JSON.parse(line) as InstrumentRequest
    } catch {
      // No id to answer to, so the reply cannot be correlated. Say so plainly.
      reply(connection, { id: -1, op: 'unknown', ok: false, error: 'malformed JSON request' })
      return
    }

    const id = typeof request.id === 'number' ? request.id : -1

    try {
      switch (request.op) {
        case 'hello': {
          const result: HelloResult = {
            protocol: INSTRUMENT_PROTOCOL,
            pid: process.pid,
            role,
            startedAt,
            scriptCount: scripts.size,
            correlating: requestCorrelation !== null,
          }
          reply(connection, { id, op: 'hello', ok: true, result })
          return
        }
        case 'correlate': {
          const header = request.header.trim().toLowerCase()
          if (header === '') throw new Error('correlate needs a non-empty header name')
          installCorrelation(header)
          reply(connection, { id, op: 'correlate', ok: true, result: { header } })
          return
        }
        case 'generated': {
          // This request arrives after the last window, so the source reads it
          // causes cannot lengthen a boundary. It is the only place the module
          // fetches generated text.
          const generated: Record<string, GeneratedScript> = {}
          for (const scriptId of request.ids) {
            if (!scripts.has(scriptId)) continue
            const value = generatedFor(scriptId)
            if (value !== undefined) generated[scriptId] = value
          }
          reply(connection, { id, op: 'generated', ok: true, result: { generated } })
          return
        }
        case 'take': {
          if (closed) throw new Error('instrumented session is closed')
          await serveTake(connection, id, request.sentAtUs)
          return
        }
        case 'ack': {
          // Everything up to and including `ackId` has reached the collector's
          // hands, so it must not be offered twice.
          for (const takeId of [...unacked.keys()]) if (takeId <= request.ackId) unacked.delete(takeId)
          reply(connection, { id, op: 'ack', ok: true, result: { acked: request.ackId } })
          return
        }
        case 'close': {
          // Unlink BEFORE replying, and this ordering is the whole guarantee.
          //
          // The client is a different process. Writing the reply and then
          // unlinking races the scheduler: the server can be descheduled between
          // the two, the client wakes on the reply and stats the path, and finds
          // it still there. Measured at 2 runs in 25 with the reply first. Unlink
          // first and the path cannot be observed by anyone who has the reply,
          // which is the promise a collector actually needs.
          removeSocket()
          // The collector is finished with this process. A snapshot left behind
          // after that is evidence for a run that will never look for it.
          removeSnapshot()
          reply(connection, { id, op: 'close', ok: true, result: { closing: true } })
          shutdown()
          return
        }
        default: {
          const unknown = (request as { op?: unknown }).op
          throw new Error(`unknown op ${JSON.stringify(unknown)}`)
        }
      }
    } catch (error) {
      reply(connection, {
        id,
        op: String(request.op),
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  function reply(connection: net.Socket, message: InstrumentResponse): void {
    try {
      connection.write(encodeMessage(message))
    } catch {
      // The client went away between reading and answering.
    }
  }

  function shutdown(): void {
    if (closed) return
    closed = true
    if (snapshotTimer !== null) {
      clearInterval(snapshotTimer)
      snapshotTimer = null
    }
    restoreEmit?.()
    // The close op has already unlinked, before it replied; this is here for the
    // process-exit path, and is a swallowed ENOENT in the common case.
    removeSocket()
    try {
      server.close()
    } catch {
      // Already closed.
    }
    disconnect()
  }

  function removeSocket(): void {
    try {
      fs.unlinkSync(socketPath)
    } catch {
      // Already gone, or never created.
    }
  }

  /**
   * Stand down for a collector that shares this process.
   *
   * The timer is the taker that matters, not the socket: `takePreciseCoverage`
   * returns and resets the counters for the whole isolate, so this module's 500 ms
   * self-snapshot would consume execution the collector's next window is drawn
   * from. Measured before this existed, in the exact shape cbd-apq creates: a
   * window that ran a function twice reported `count: 1` when another client took
   * between the two calls. The loss is silent and always in the same direction.
   *
   * The socket goes with it, because a collector looking at this directory would
   * otherwise attach to a process that is already being recorded in-process — the
   * doubling the pid filter exists to prevent, arriving from the other side. The
   * snapshot goes because nobody will harvest it.
   *
   * **The inspector session is left connected.** `stopPreciseCoverage` is the
   * isolate's switch, not this session's — measured: after another session stops,
   * the remaining one's next take reports only what ran since, so stopping here
   * would turn off the coverage the collector just started. An idle session is a
   * handle; this module is already a guest in a process that is about to end.
   */
  async function stop(): Promise<V8ScriptCoverage[]> {
    if (closed) return []
    closed = true
    if (snapshotTimer !== null) {
      clearInterval(snapshotTimer)
      snapshotTimer = null
    }
    restoreEmit?.()
    removeSocket()
    removeSnapshot()
    try {
      server.close()
    } catch {
      // Already closed.
    }

    // **The handoff.** Everything this module has consumed from the isolate so
    // far — whatever its self-snapshots took since the process started — belongs
    // to the collector that is about to start its own session. Without it the
    // coverage is gone: the counters were reset when it was taken, no client
    // read the snapshot in this process, and the new session only sees what runs
    // from here. On a test run that is the import phase, which is exactly where
    // the code a suite merely loads executes (`cbd-1ci`).
    //
    // The final take goes through the same queue as the snapshots, so a tick
    // that is already in flight lands first and cannot be lost behind this one.
    // A session that has gone away still leaves the accumulated coverage to hand
    // over, so the failure is a smaller delta rather than none.
    try {
      await exclusive(async () => {
        await accumulate()
      })
    } catch {
      // The inspector is gone; hand over what the snapshots already had.
    }
    const carried = [...untaken.values()]
    untaken = new Map()
    return carried
  }

  try {
    fs.mkdirSync(dir, { recursive: true })
    // A socket left by a previous process that held this pid. Removing it is the
    // only way to bind the path again.
    removeSocket()
    server.listen(socketPath, () => {
      try {
        // Owner-only. Coverage is a description of everything this process ran,
        // and a permissive socket in a shared directory would hand that to anyone
        // who can see the path.
        fs.chmodSync(socketPath, 0o600)
      } catch {
        // A filesystem without POSIX modes. Continue rather than refuse to serve.
      }
    })
    // **The listening socket must not keep the host alive.** A `net.Server` is a
    // referenced handle, so without this the module changes when its host exits:
    // measured, `CBD_SOCKET_DIR=… node -e "console.log('done')"` under `NODE_OPTIONS`
    // prints and then hangs forever. For a long-running service that is invisible —
    // it was going to stay up anyway — and for the test process it is not: a run
    // whose test files all pass would never return, and would be killed by whatever
    // CI timeout came first with a green report already printed. That is the same
    // failure shape as an unclosed source, and worse, because nothing says why.
    //
    // `unref` is the honest direction for a guest (ADR-0005). It makes the module
    // *not* a reason to stay alive, exactly as it makes it not a reason to refuse to
    // start: a service with work to do holds the loop open by its own handles, and a
    // process whose work is finished exits when it would have exited anyway.
    server.unref()

    // The periodic write is what survives a SIGKILL, which runs no handler at all.
    // Unref'd for the same reason the server is: a guest must not be the reason
    // its host stays alive.
    if (SNAPSHOT_INTERVAL_MS > 0) {
      snapshotTimer = setInterval(() => {
        // **No `accumulate()` here.** The periodic file no longer carries the
        // accumulator (`cbd-n9t.2`), so taking coverage for it would reset the
        // isolate counters between boundaries for a field that is not written —
        // and every take is an inspector round trip competing with the boundary
        // ones. Measured on the stores suite: keeping the take while omitting the
        // field still cost ~2× the whole run (57 min against 29 min with the timer
        // off). The file written here is what a SIGKILL can recover by take id; the
        // take handler already writes the same state immediately after each reply,
        // and the exit handler performs its own final take.
        writeSnapshot()
      }, SNAPSHOT_INTERVAL_MS)
      snapshotTimer.unref()
    }
  } catch {
    disconnect()
    return
  }

  // The final, exact write. `'exit'` is synchronous by contract, and the take is
  // synchronous for the same reason — see `takeSync`. A process that exits
  // normally therefore leaves *everything* it ran, not just what the last tick
  // caught; a process killed outright still runs no handler, and the interval
  // above remains the honest bound for that case.
  process.on('exit', () => {
    const final = takeSync()
    if (final !== null) mergeInto(untaken, final)
    writeSnapshot(nowUs(), true)
    shutdown()
  })

  // Advertised only once there is something to stand down, and read by the
  // in-process source at install. The module stays loaded — its job in a collector's
  // process is to be in the environment its children inherit, not to be read here.
  scope.__cbdInstrument = { stop }
}
