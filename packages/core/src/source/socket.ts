/**
 * Coverage from a *separate* process, over the socket the injected instrument
 * module serves — `take()` only, never `takeSync()`.
 *
 * This is the source ADR-0005 chose. The `inspectorSource` in the neighbouring
 * file reaches a service by attaching a debugger to `--inspect`, which asks the
 * developer to choose a port, discover it, guard an unauthenticated code-execution
 * surface, and repeat all of it per process. This one drives a socket the target
 * opened for itself because `NODE_OPTIONS` said so, so there is nothing to
 * discover and nothing to guard beyond the socket's own file mode.
 *
 * ## The window rule, restated because it is the whole risk
 *
 * `supportsSync` is `false` and `takeSync()` throws. The contract in
 * `inspector.ts` says why, and it applies unchanged here: **dispatch time is the
 * window boundary, not completion time.** `take()` writes its request in the same
 * tick it is called, so the peer resets its coverage at the boundary the caller
 * meant; the promise settles whenever the reply arrives. That ordering is not an
 * optimisation — a take that waited for the previous reply before sending would
 * fold one test's execution into its neighbour's window, which is the
 * under-selection failure this project treats as the unacceptable one.
 *
 * **Two ways to take, and the difference is whether the caller can wait.**
 * `take()` refuses to start while a window is outstanding, because a caller using
 * `take()` alone has no way to say which window a late reply belongs to; that is
 * the silent misattribution, so it is an error rather than a queue. `dispatch()`
 * is the same boundary with the ambiguity removed: it hands back a handle carrying
 * the window's place in the dispatch order, and every handle resolves in that
 * order. A japa boundary handler, which cannot wait (A0 F1), uses `dispatch()`;
 * everything else uses `take()`.
 *
 * **Overlapping dispatches partition correctly, and that is a claim about the peer
 * rather than about this file.** `takePreciseCoverage` returns the counts since the
 * previous call and resets them, and the instrument module serves requests off one
 * inspector session in arrival order — so N boundaries sent back to back produce N
 * deltas that partition the process's execution, with no work counted twice and
 * none dropped. That is the property the deferred-recording design rests on, so it
 * is asserted directly in `socket-source.spec.ts` rather than reasoned about here.
 *
 * **Partitioning is not the same as landing where you meant, and the difference is
 * queue depth.** A window begins when its boundary is *received*, and the peer
 * serves takes one at a time, so a boundary written while an earlier one is still
 * being served waits behind it and slides late. Measured on this host: boundaries
 * spaced by half a millisecond drift 68µs, and two hundred written back to back
 * drift 24ms — roughly 115µs of queue delay each. Real suites space boundaries by
 * whole milliseconds and never accumulate, but a suite faster than a take round
 * trip (~0.6ms) would put every window in the second regime, and the map would
 * attribute one test's work to another with nothing to show for it.
 *
 * `drift()` exists so that is arithmetic rather than hope, and the pair to read is
 * `maxUs` against `minGapUs` — how far a boundary landed, against how close the
 * boundaries came to each other. `maxDepth` is not that pair: a client which is merely
 * busy reading an earlier reply raises the depth without moving any boundary, which is
 * what a real run was measured doing (`cbd-a3v.3.5`, and `DriftStats.maxDepth`).
 *
 * ## A take is a reset, and both kinds drain the same counter
 *
 * The service holds one `takePreciseCoverage` counter, so `take()`, `dispatch()`
 * and any other take against the same process partition one stream rather than
 * showing two views of it.
 *
 * ## No lock file, and why that is not an oversight
 *
 * `inspector.ts` records that two collectors must not share one target, and
 * planned a lock keyed by origin. That was a consequence of the target being a
 * *port*: many processes, one address, no way to tell who else is attached. Here
 * each process owns its own socket, named for its pid, created by the module and
 * removed when it closes. Two collectors in the same directory would still collide
 * — but they would have to be two collectors sharing a socket *directory*, which is
 * a configuration this can report (`cbd-a3v.3` owns the multi-process picture)
 * rather than a race it has to police per target.
 *
 * ## Discovery refuses ambiguity rather than guessing
 *
 * A directory holds one socket per instrumented process. With one candidate this
 * drives it; with several it throws and names them. Picking one would produce a
 * map that silently attributed one process's execution and omitted the rest —
 * under-selection arriving as a confident answer. **A directory that gains a process
 * mid-run is `rescanningSocketSource`'s problem, not this one's**: the refusal below is
 * about a caller that named no pid and would otherwise be choosing by accident, and it
 * stays, because a source opened once cannot read a process that arrived after it.
 */
import { readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import { dirname, join } from 'node:path'
import { DEFAULT_INSPECTOR_TIMEOUT_MS } from './inspector.js'
import {
  INSTRUMENT_PROTOCOL,
  LineSplitter,
  SOCKET_DIR_ENV,
  encodeMessage,
  nowUs,
  snapshotPath,
  type HelloResult,
  type InstrumentRequest,
  type InstrumentResponse,
  type RequestWindow,
  type ScriptRow,
  type SnapshotFile,
  type TakeResult,
} from '../instrument-protocol.js'
import type {
  DriftStats,
  PendingTake,
  QueuedSource,
  ScriptInfo,
  Source,
  TakeCapture,
  V8ScriptCoverage,
} from '../types.js'

/** What a socket in the directory said it was. */
export interface SocketTarget {
  path: string
  pid: number
  role: string
  startedAt: string
}

export class SocketSourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SocketSourceError'
  }
}

export interface SocketSourceOptions {
  /** The directory the instrument module wrote into. Defaults to `CBD_SOCKET_DIR`. */
  dir?: string
  /** One specific socket. Refused together with `dir` or `pid`. */
  socket?: string
  /** Choose this pid out of `dir`, rather than requiring exactly one candidate. */
  pid?: number
  /** How long to wait for a connect, a hello or a take. */
  timeoutMs?: number
  /**
   * Turn on request-id correlation in the target, reading this header.
   *
   * Sent as a `correlate` op after the hello. Opt-in because it changes what the
   * target does: every correlated request costs two takes, and a service started
   * by a developer should not start paying that until a collector asks for it.
   */
  correlationHeader?: string
}

/** `pid-1234.sock`, the name the instrument module writes. */
const SOCKET_NAME = /^pid-(\d+)\.sock$/

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

interface Pending {
  resolve: (response: InstrumentResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

class SocketClient {
  readonly #socket: net.Socket
  readonly #splitter = new LineSplitter()
  readonly #pending = new Map<number, Pending>()
  readonly #timeoutMs: number
  #nextId = 1
  #closed = false
  #gone = false

  constructor(socket: net.Socket, timeoutMs: number) {
    this.#socket = socket
    this.#timeoutMs = timeoutMs
    socket.setEncoding('utf8')

    socket.on('data', (chunk: string) => {
      for (const line of this.#splitter.push(chunk)) {
        if (line.trim() === '') continue
        this.#settle(line)
      }
    })
    socket.on('error', (error: Error) => this.#fail(error))
    socket.on('close', () => this.#fail(new SocketSourceError('the instrument socket closed')))
  }

  #settle(line: string): void {
    let response: InstrumentResponse
    try {
      response = JSON.parse(line) as InstrumentResponse
    } catch {
      // A line we cannot read is a protocol failure, not a message to drop: the
      // take it belongs to would hang until its timeout otherwise.
      this.#fail(new SocketSourceError(`unreadable line from the instrument socket: ${line}`))
      return
    }
    const pending = this.#pending.get(response.id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.#pending.delete(response.id)
    pending.resolve(response)
  }

  /**
   * Whether the peer can answer again.
   *
   * A socket error or close is terminal — a unix socket stream is not revived. The
   * source uses it, with `fallbackTaken`, to stop asking once the target's
   * unnumbered lifetime has been read; numbered windows are still recovered by id.
   * An unreadable line counts too: the stream cannot be trusted to carry the next
   * reply.
   */
  get gone(): boolean {
    return this.#gone
  }

  #fail(error: Error): void {
    this.#gone = true
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  /**
   * Sends a request and waits for its reply.
   *
   * The write happens synchronously, before this returns its promise, and that is
   * the point — see the module docblock. Nothing is queued behind a previous
   * request; a caller that sends two at once gets two throws rather than two
   * interleaved windows.
   */
  request(
    op: 'hello' | 'close' | 'correlate',
    sentAtUs?: number,
    header?: string,
  ): Promise<InstrumentResponse> {
    const id = this.#nextId++
    return this.#send(id, op, sentAtUs, header)
  }

  /** Generated line starts for scripts the recorder already saw, at end of run. */
  generated(ids: string[]): Promise<InstrumentResponse> {
    const id = this.#nextId++
    return this.#send(id, 'generated', undefined, undefined, ids)
  }

  /**
   * A take, with the id it was sent under.
   *
   * The id is the handle both sides use to name this window: the instrument files
   * its coverage under it, and the ack below releases exactly that entry. Without
   * it, recovery would have to guess which buffered window a lost reply belonged
   * to, which is the guess `ADR-0007` refuses to make.
   */
  take(sentAtUs: number): { id: number; reply: Promise<InstrumentResponse> } {
    const id = this.#nextId++
    return { id, reply: this.#send(id, 'take', sentAtUs) }
  }

  /**
   * Tells the instrument a window arrived.
   *
   * Fire-and-forget, and id 0 is deliberate: it is outside the request space, so
   * the reply is dropped by `#settle` instead of needing a pending entry. A failed
   * write is also silent — if the socket is gone, the instrument has kept the
   * evidence rather than losing it, which is the whole design.
   */
  ack(takeId: number): void {
    if (this.#closed) return
    try {
      this.#socket.write(encodeMessage({ id: 0, op: 'ack', ackId: takeId }))
    } catch {
      // See above: not receiving the ack is the safe failure.
    }
  }

  #send(
    id: number,
    op: 'hello' | 'take' | 'close' | 'correlate' | 'generated',
    sentAtUs?: number,
    header?: string,
    ids?: string[],
  ): Promise<InstrumentResponse> {
    if (this.#closed) return Promise.reject(new SocketSourceError('the socket is closed'))

    return new Promise<InstrumentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new SocketSourceError(`no reply to "${op}" within ${String(this.#timeoutMs)}ms`))
      }, this.#timeoutMs)

      this.#pending.set(id, { resolve, reject, timer })
      this.#socket.write(encodeMessage(buildRequest(id, op, sentAtUs, header, ids)))
    })
  }

  /**
   * Disconnects the client, and deliberately does not tell the service to stop.
   *
   * `close` on the wire stops precise coverage for good. The service outlives the
   * test run that reads it (ADR-0005: `dev-cli` starts the server, the suite comes
   * and goes), so ending its session here would leave the next run with a dead
   * target and no way to tell why.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#fail(new SocketSourceError('the socket is closed'))
    this.#socket.destroy()
  }
}

function buildRequest(
  id: number,
  op: 'hello' | 'take' | 'close' | 'correlate' | 'generated',
  sentAtUs?: number,
  header?: string,
  ids?: string[],
): InstrumentRequest {
  switch (op) {
    case 'hello':
      return { id, op: 'hello' }
    case 'take':
      return { id, op: 'take', ...(sentAtUs === undefined ? {} : { sentAtUs }) }
    case 'close':
      return { id, op: 'close' }
    case 'correlate':
      return { id, op: 'correlate', header: header ?? '' }
    case 'generated':
      return { id, op: 'generated', ids: ids ?? [] }
  }
}

function connect(path: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new SocketSourceError(`no instrument socket at ${path} within ${String(timeoutMs)}ms`))
    }, timeoutMs)

    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeAllListeners('error')
      resolve(socket)
    })
    socket.once('error', (error: Error) => {
      clearTimeout(timer)
      reject(new SocketSourceError(`cannot reach ${path}: ${error.message}`))
    })
  })
}

async function openOne(
  path: string,
  timeoutMs: number,
): Promise<{ client: SocketClient; hello: HelloResult }> {
  const socket = await connect(path, timeoutMs)
  const client = new SocketClient(socket, timeoutMs)
  try {
    const response = await client.request('hello')
    if (!response.ok) throw new SocketSourceError(`the instrument module refused hello: ${response.error}`)
    return { client, hello: (response as { result: HelloResult }).result }
  } catch (error) {
    client.close()
    throw error
  }
}

/**
 * A window the instrument kept after the reply was lost, found again by number.
 *
 * This is `ADR-0007`'s second mechanism used for its narrower case: not a process
 * that died inside its window, but a reply that never arrived. The instrument only
 * forgets a take when the collector acknowledges it, so if the collector is asking
 * this question the answer is still on disk — unless the process did not reach a
 * snapshot, in which case the window is genuinely gone and the caller says so out
 * loud rather than recording an empty window.
 *
 * Matching is by `takeId` first. `sentAtUs` is a fallback for the pathological case
 * where the instrument was restarted at the same pid and numbered its takes again;
 * the boundary is a value the collector chose, so it cannot collide.
 */
interface Recovered {
  coverage: V8ScriptCoverage[]
  scripts: ScriptRow[]
  /** The correlation tags the lost reply carried, so recovery does not drop them. */
  ids: string[]
  requests: RequestWindow[]
  /**
   * Whether a window numbered for this take was found, rather than the unnumbered
   * fallback. Numbered windows belong to one take and can be read as often as that
   * take is asked for; the fallback is a whole lifetime that may be offered only
   * once. See `fallbackTaken`.
   */
  matched: boolean
}

async function recoverWindow(
  socketPath: string,
  pid: number,
  takeId: number,
  sentAtUs: number,
): Promise<Recovered | null> {
  let file: SnapshotFile
  try {
    file = JSON.parse(await readFile(snapshotPath(dirname(socketPath), pid), 'utf8')) as SnapshotFile
  } catch {
    return null
  }
  if (file.protocol !== INSTRUMENT_PROTOCOL || file.pid !== pid) return null

  const coverage: V8ScriptCoverage[] = []
  const ids: string[] = []
  const requests: RequestWindow[] = []
  let matched = false
  for (const window of file.windows) {
    if (window.takeId === takeId || window.sentAtUs === sentAtUs) {
      coverage.push(...window.coverage)
      ids.push(...(window.ids ?? []))
      requests.push(...(window.requests ?? []))
      matched = true
    }
  }
  // A failed *write* means the request never reached the instrument at all, so
  // there is no numbered window to find. The work it was meant to carry is still
  // accumulated as "taken since the last client take", which is exactly the
  // window this dispatch asked for — so it is the right thing to return rather
  // than an empty window. It is a whole lifetime, though, not a window, and the
  // caller may offer it only once.
  //
  // `untaken`/`pendingRequests` are only in the exit write (`cbd-n9t.2`: the
  // periodic file is bounded to what can be recovered by take id, because the
  // accumulator can be hundreds of MB). If they are absent, the instrument is
  // still alive with its accumulator intact and the next successful take carries
  // this work; the loss reported for *this* boundary is honest rather than silent.
  if (!matched) {
    coverage.push(...(file.untaken ?? []))
    requests.push(...(file.pendingRequests ?? []))
  }
  if (coverage.length === 0 && requests.length === 0) return null
  return { coverage, scripts: file.scripts, ids, requests, matched }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Every socket in `dir` that answered, minus the ones that are not the collector's
 * to read.
 *
 * **Our own pid** is the filter, and it is the only one. This process is running
 * the tests, and its coverage is taken in-process by the adapter's own source;
 * reading our socket here would double every touch we produced.
 *
 * **A role is not a filter, and cannot be one.** `CBD_ROLE` looks like a
 * declaration of what a process is, but it is inherited exactly as `NODE_OPTIONS`
 * is, so a service the test process starts for itself announces whatever the test
 * process announces. Filtering on it therefore does not separate the service from
 * its client — it hides the service, and it does so silently: discovery keeps
 * succeeding, then stops, with nothing to report. The doubling risk the role was
 * meant to cover is the collector's own socket, and the pid above already covers
 * it (ADR-0007). `role` stays in the hello and is carried through to the target,
 * where it is true and descriptive; it just does not decide.
 *
 * An unreadable socket is dropped rather than reported. A socket file left by a
 * process that died cannot produce coverage, so there is no decision to make about
 * it — and failing the whole run because a directory held one stale file would
 * make a crash in an unrelated process look like a CBD failure.
 */
export async function discoverSockets(
  dir: string,
  timeoutMs: number = DEFAULT_INSPECTOR_TIMEOUT_MS,
): Promise<SocketTarget[]> {
  const targets: SocketTarget[] = []
  for (const path of socketPaths(dir)) {
    try {
      const { client, hello } = await openOne(path, timeoutMs)
      client.close()
      if (hello.pid === process.pid) continue
      targets.push({ path, pid: hello.pid, role: hello.role, startedAt: hello.startedAt })
    } catch {
      // Stale, busy, or not an instrument socket at all.
    }
  }
  return targets
}

/**
 * Every socket in `dir`, by path, without opening any of them.
 *
 * Split out from `discoverSockets` for the caller that has to look *repeatedly*: one
 * that asks "which of these have I not seen yet?" at every boundary cannot afford to
 * connect and say hello to everything it already holds, once per test. Listing is a
 * `readdir`; the connections are what cost.
 *
 * The paths, not the targets: a path is what a caller remembers between looks, and it
 * is stable for the life of the socket file. What the process behind it says about
 * itself is `discoverSockets`' question, and answering it costs a round trip.
 */
export function socketPaths(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (error) {
    throw new SocketSourceError(
      `cannot read the socket directory ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const paths: string[] = []
  for (const entry of entries) {
    if (SOCKET_NAME.test(entry)) paths.push(join(dir, entry))
  }
  return paths
}

/**
 * The refusal a caller gets when a socket directory holds nothing to read.
 *
 * A function rather than a message inlined twice, because two sources now look in the
 * same place and both have to say the same thing about finding nothing there. The
 * sentence is the whole value of the error — which variable was expected, and where —
 * and a second copy of it would drift.
 */
export function noServiceError(dir: string): SocketSourceError {
  return new SocketSourceError(
    `no instrumented service answered in ${dir}. Check that the target ` +
      'started with NODE_OPTIONS="--import @spikedpunch/cbd/instrument" and the same ' +
      `${SOCKET_DIR_ENV}.`,
  )
}

type Resolved =
  | { kind: 'path'; path: string }
  | { kind: 'dir'; dir: string; pid?: number }

function resolveSocket(options: SocketSourceOptions): Resolved {
  const dir = options.dir ?? process.env[SOCKET_DIR_ENV]

  if (options.socket !== undefined) {
    if (options.dir !== undefined || options.pid !== undefined) {
      throw new SocketSourceError(
        'passing "socket" together with "dir" or "pid" names the target two ways at once; ' +
          'give either one path or one directory to choose from.',
      )
    }
    return { kind: 'path', path: options.socket }
  }

  if (dir === undefined || dir === '') {
    throw new SocketSourceError(
      `no socket directory: pass "dir", or set ${SOCKET_DIR_ENV} to the directory the ` +
        'instrument module was pointed at.',
    )
  }
  return { kind: 'dir', dir, ...(options.pid === undefined ? {} : { pid: options.pid }) }
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

export async function socketSource(options: SocketSourceOptions = {}): Promise<QueuedSource> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSPECTOR_TIMEOUT_MS
  const resolved = resolveSocket(options)

  let path: string
  if (resolved.kind === 'path') {
    path = resolved.path
  } else {
    const targets = await discoverSockets(resolved.dir, timeoutMs)
    if (targets.length === 0) throw noServiceError(resolved.dir)

    if (resolved.pid === undefined) {
      if (targets.length > 1) {
        throw new SocketSourceError(
          `${String(targets.length)} instrumented services answered in ${resolved.dir} ` +
            `(pids ${targets.map((t) => String(t.pid)).join(', ')}). One source drives one ` +
            'process: pass "pid" to choose, or "socket" for one path. Driving the first and ' +
            'ignoring the rest would under-select silently.',
        )
      }
      path = (targets[0] as SocketTarget).path
    } else {
      const match = targets.find((target) => target.pid === resolved.pid)
      if (match === undefined) {
        throw new SocketSourceError(
          `no instrumented service with pid ${String(resolved.pid)} in ${resolved.dir}` +
            ` (found ${targets.map((t) => String(t.pid)).join(', ')})`,
        )
      }
      path = match.path
    }
  }

  const { client, hello } = await openOne(path, timeoutMs)

  if (
    options.correlationHeader !== undefined &&
    options.correlationHeader !== '' &&
    hello.correlating !== true
  ) {
    // The target has to agree to this before any request is made, or the first
    // request's coverage is taken by time like every other window. A refusal is
    // loud rather than a silent fallback: a run that asked for correlation and got
    // time-based windows is a map whose attribution is weaker than the caller was
    // told, and under-selection is the direction this project does not accept.
    //
    // Skipped when the hello says the process already is: a service a recording
    // test spawned inherited the header name and installed the hook at start-up.
    // Saving that round trip is not micro-optimisation — it is the difference
    // between attaching inside the test that started the process and attaching
    // during the next one.
    const reply = await client.request('correlate', undefined, options.correlationHeader)
    if (!reply.ok) {
      client.close()
      throw new SocketSourceError(
        `the instrument in pid ${String(hello.pid)} refused request-id correlation: ` +
          `${reply.error}. It may predate the "correlate" op; rebuild the package the ` +
          'service imports, or start it without correlation.',
      )
    }
  }

  /**
   * Accumulated across takes, because each row is sent exactly once — the module
   * drains its queue rather than repeating the table.
   */
  const scripts = new Map<string, ScriptInfo>()
  let closed = false

  /**
   * Windows sent but not yet answered, and the chain that makes their handles
   * resolve in the order they were sent.
   *
   * The chain is defensive rather than necessary — the peer answers on one
   * connection in arrival order — but "the ordering is right because a layer below
   * happens to preserve it" is exactly the kind of fact that stops being true
   * quietly. Here it is a property of this file.
   */
  let outstanding = 0
  let nextSeq = 0
  let tail: Promise<void> = Promise.resolve()

  let driftWindows = 0
  let driftTotalUs = 0
  let driftMaxUs = 0
  let maxDepth = 0
  /** The previous boundary's send time, so the gap to this one is one subtraction. */
  let lastSentUs: number | null = null
  let minGapUs = 0

  const absorb = (rows: ScriptRow[]): void => {
    for (const row of rows) {
      scripts.set(row.id, {
        url: row.url,
        ...(row.sourceMapURL === undefined ? {} : { sourceMapURL: row.sourceMapURL }),
        ...(row.generated === undefined ? {} : { generated: row.generated }),
      })
    }
  }

  /**
   * Says a window is gone, once, instead of recording it as empty.
   *
   * This is the loudness half of the decision: an empty window is indistinguishable
   * from a test that reached nothing, and the map is built from it either way. A
   * line on stderr is the only truthful thing left to say. Deduplicated per source
   * because one dead target can lose many windows, and a hundred copies of the
   * same sentence is noise rather than evidence.
   */
  let lossReported = false
  function reportLoss(error: Error): void {
    if (lossReported) return
    lossReported = true
    process.stderr.write(
      `cbd: coverage from pid ${String(hello.pid)} was lost and could not be recovered ` +
        `(${error.message}). The map for this run is missing that window and selection ` +
        'may under-select.\n',
    )
  }

  /**
   * Whether the *unnumbered* fallback has been offered.
   *
   * This guards exactly one thing, and the distinction took a measurement to find.
   * A window the instrument numbered for this take belongs to that take: it may be
   * recovered whenever that take is asked for, and every take that was served before
   * the socket died has one. The unnumbered fallback is different — it is the
   * whole accumulated lifetime, and it is the right answer only for the window that
   * discovered the loss. Offering it at later boundaries credits one test's
   * execution to every test that follows: measured on grizzly, one dead child's
   * start-up landed in 74 windows.
   *
   * So numbered windows are always recovered; the fallback is spent once.
   */
  let fallbackTaken = false

  function dispatch(): PendingTake {
    if (closed) throw new SocketSourceError('the source is closed')
    // The target is gone and the whole lifetime it left behind has been read. A
    // window it did not exist for is empty, which is the truth — and asking anyway
    // would spend a write and a timeout on every remaining test. A take that was
    // *served* before the death has a numbered window and is recovered below, so
    // this only skips takes that could never have one.
    if (client.gone && fallbackTaken) {
      return { seq: nextSeq++, settle: () => Promise.resolve([]) }
    }

    // Read and written in this tick, with nothing awaited between them: the
    // timestamp and the boundary are the same event or the measurement is a lie.
    const sentAtUs = nowUs()
    const seq = nextSeq++
    outstanding += 1
    if (outstanding > maxDepth) maxDepth = outstanding

    // The gap between boundaries, from the same clock and the same tick as the
    // boundary itself. Read at dispatch rather than at receipt because it is a
    // property of what the *suite* asked for, not of how long the answer took.
    if (lastSentUs !== null) {
      const gap = sentAtUs - lastSentUs
      if (minGapUs === 0 || gap < minGapUs) minGapUs = gap
    }
    lastSentUs = sentAtUs

    const take = client.take(sentAtUs)
    const delta: Promise<TakeCapture> = take.reply.then(
      (response) => {
        if (!response.ok) throw new SocketSourceError(`take failed: ${response.error}`)
        const result = (response as { result: TakeResult }).result

        const driftUs = result.atUs - sentAtUs
        driftWindows += 1
        driftTotalUs += driftUs
        if (driftUs > driftMaxUs) driftMaxUs = driftUs

        absorb(result.scripts)
        // The window is in the collector's hands. Only now may the instrument
        // forget it.
        client.ack(take.id)
        return {
          coverage: result.coverage,
          ids: result.ids ?? [],
          requests: result.requests ?? [],
        }
      },
      async (error: Error) => {
        // A reply that never arrived is not necessarily a window that never
        // existed: the instrument kept it until we acknowledged it. Look for the
        // exact window this take was sent for.
        const window = await recoverWindow(path, hello.pid, take.id, sentAtUs)
        if (window !== null) {
          absorb(window.scripts)
          client.ack(take.id)
          // The unnumbered fallback is one lifetime, and it belongs to whichever
          // window discovered that the target is gone. Every other take keeps the
          // numbered window it was sent for, or nothing.
          if (!window.matched) {
            if (fallbackTaken) return { coverage: [], ids: [], requests: [] }
            fallbackTaken = true
          }
          return { coverage: window.coverage, ids: window.ids, requests: window.requests }
        }
        reportLoss(error)
        throw error
      },
    )

    const previous = tail
    tail = delta.then(
      () => {
        outstanding -= 1
      },
      () => {
        // A window that failed still ends; the ones dispatched after it must not
        // be held back by it, and their own errors are their own.
        outstanding -= 1
      },
    )

    const handle: PendingTake = {
      seq,
      settle: () => previous.then(() => delta).then((capture) => capture.coverage),
    }
    // Only a source that asked for correlation can produce tags. Leaving the
    // method absent otherwise keeps an uncorrelated run on exactly the path it had
    // before there was a tag to carry — which is the path the drift fixture
    // measures, and it is sensitive to work added per boundary.
    if (options.correlationHeader !== undefined && options.correlationHeader !== '') {
      handle.settleTagged = () => previous.then(() => delta)
    }
    return handle
  }

  return {
    kind: 'socket',
    supportsSync: false,
    // From the hello reply rather than from the socket file's name. The name is a
    // convention the module happens to follow; the reply is what the process says
    // about itself, and the two would disagree if the convention ever changed.
    pid: hello.pid,

    takeSync(): V8ScriptCoverage[] {
      throw new SocketSourceError(
        'socketSource cannot take synchronously: the coverage lives in another process and a ' +
          'socket round-trip cannot complete inside a japa lifecycle hook. Use take(), or ' +
          'dispatch() where the boundary has to be synchronous, and see the ' +
          'dispatch-time-is-the-boundary contract in source/inspector.ts.',
      )
    },

    async take(): Promise<V8ScriptCoverage[]> {
      if (closed) throw new SocketSourceError('the source is closed')
      if (outstanding > 0) {
        throw new SocketSourceError(
          'a window is already outstanding. take() cannot say which window a late reply belongs ' +
            'to, so a second one is refused rather than folded into the first — that would be ' +
            'silent misattribution. Wait for the previous take, or use dispatch() if the caller ' +
            'needs to send boundaries it cannot wait on: dispatch() carries the window order, so ' +
            'its handles are unambiguous.',
        )
      }
      return dispatch().settle()
    },

    dispatch,

    drift: (): DriftStats => ({
      windows: driftWindows,
      maxUs: driftMaxUs,
      meanUs: driftWindows === 0 ? 0 : driftTotalUs / driftWindows,
      maxDepth,
      minGapUs,
    }),

    scripts: () => scripts,
    generated: (scriptId: string) => scripts.get(scriptId)?.generated,
    async prepare(scriptIds: readonly string[]) {
      if (closed || scriptIds.length === 0) return
      try {
        const reply = await client.generated([...scriptIds])
        if (reply.ok && reply.op === 'generated') {
          for (const [id, generated] of Object.entries(reply.result.generated)) {
            const info = scripts.get(id)
            if (info !== undefined) info.generated = generated
          }
        }
      } catch {
        // An instrument older than this op, or a socket that died at the end:
        // the build falls back to the file. Never make the run fail here.
      }
    },

    close: () => {
      if (closed) return
      closed = true
      client.close()
    },
  }
}
