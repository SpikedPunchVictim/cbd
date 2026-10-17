/**
 * Coverage from *every* instrumented process in a socket directory, including the ones
 * that appear after the run has started — ADR-0007's first mechanism.
 *
 * ## Why one source and not several
 *
 * A suite can start services of its own. The one CBD was built for does: a japa suite
 * driving a key server started before it, with a handful of tests that boot a second
 * server of the same code themselves, from the environment they already carry
 * (`NODE_OPTIONS` is inherited, ADR-0005). `socketSource` cannot read that second
 * process, and the reason is not that it is unreachable — measured, it announces
 * itself in the same directory and answers — but that it was not there when the
 * source was opened. A `Recorder` hands its source one boundary per window and reads
 * whatever it holds; a process it does not hold is a process nobody takes a window
 * from, for the whole run.
 *
 * So this source keeps looking. Every boundary it lists the directory, and a socket it
 * has not seen before is opened, so that from the next boundary onward that process is
 * read exactly like the first one.
 *
 * **One shard carries them all, and that costs nothing.** The service shard's header
 * names a pid, but nothing downstream reads it — `map.ts` and `shard.ts` never touch
 * the field — so several processes may be recorded into one shard without confusing
 * anybody. What `pid` on this source means is therefore "the first target", which is
 * the process the run was pointed at; the shard's other targets are named in the
 * footer's drift only by their number.
 *
 * ## The first take of a process is its whole life, which is what makes this sound
 *
 * The instrument module calls `Profiler.startPreciseCoverage` when it starts, so the
 * counters begin at zero and the first take a client is given is *everything the
 * process has run* — no more and no less. There is no earlier boundary to have taken
 * it from, and no baseline to discard.
 *
 * That gives the attribution rule, and it is one rule for both entry points: **a
 * target's first window is the boundary at or after the moment the process appeared,
 * and it is credited to the window that was closing then.** A test that starts a
 * server gets that server's start-up in its own window, which is also the window whose
 * failure that start-up would have caused. The lane's own service, open before the run
 * begins, is credited with its whole history at the first boundary, which is `@load` —
 * the same answer `socketSource` has always given, and the one §8.3 wants, since a
 * change to a file reached only at start-up must escalate rather than vanish.
 *
 * **Because the take is what fixes the boundary, the two entry points differ by one
 * call.** At install the next boundary takes the whole history anyway, so opening is
 * enough. Mid-run the next boundary is a *different window* from the one the process
 * appeared in, so the take is sent the moment the socket is open. Get that wrong and
 * the failure is under-selection rather than noise: a test that starts a server is
 * recorded as touching none of it, a change to that server's file selects only the
 * later tests that drive it, and those fail because the test that started it did not
 * run.
 *
 * **A target is never attached behind a discarded baseline.** Discarding would drop
 * the discovering window's own server work along with everything before it, and this
 * project treats under-selection as the unacceptable failure. Folding the whole
 * history into the window that discovered the process over-attributes instead:
 * execution from earlier windows is credited to a test that did not cause it, which
 * selects more tests than it must and never fewer.
 *
 * ## Script ids are namespaced, because two processes disagree about them
 *
 * A `scriptId` is unique inside one isolate and not across processes, and `normalize`
 * looks one up — `scripts().get(script.scriptId)` — to find the `sourceMapURL` that
 * says how to map the generated file back to its source. Merging two processes' tables
 * under their own ids would let the child's entry script answer for the lane's, and
 * the result is a wrong source map or a projection fallback where a map was owed:
 * either way the wrong file, silently. So every id is prefixed with the pid it came
 * from, on the way out of a take and in the merged table. One process, one namespace.
 *
 * The ordinal registry upstream stays keyed by script URL, which is right: two
 * processes running the same build have the same generated offsets, so one entry
 * describes both.
 *
 * ## What this cannot do, named rather than discovered later
 *
 * **A process that dies inside its window is not here.** By the time any boundary
 * looks, its socket is gone and its coverage went with it. That is ADR-0007's second
 * mechanism — the child's own snapshot, harvested after the run — and it is not this
 * file.
 *
 * **An attach that outlives the next boundary loses that window.** The attach costs a
 * connect and a hello; a window shorter than that has no target to take from, and the
 * work it did lands in the discovering window instead. This is the same regime
 * `socket.ts` already names for drift — a suite whose tests are shorter than a socket
 * round trip — measured in tens of microseconds against windows measured in tens of
 * milliseconds, so it is named and not prevented. Preventing it would mean guessing
 * which window a merged window belongs to, which is the one thing this file refuses to
 * do.
 *
 * ## What is given up on
 *
 * A socket that will not answer is dropped, exactly as `discoverSockets` drops one:
 * it cannot produce coverage, so there is no decision to make about a stale file. It
 * is retried once, because `listen` binds the path before it accepts and a boundary
 * can land in that window; a second failure writes the path off for the rest of the
 * run. The case that gives up on is a pid reused within one run — the file would have
 * to be removed and rebound at that same path after both attempts, and a process that
 * dies and is replaced that quickly inside one test run is not a shape worth a stat
 * per boundary to catch.
 */
import { DEFAULT_INSPECTOR_TIMEOUT_MS } from './inspector.js'
import { SocketSourceError, noServiceError, socketPaths, socketSource } from './socket.js'
import { SOCKET_DIR_ENV } from '../instrument-protocol.js'
import type {
  DriftStats,
  PendingTake,
  QueuedSource,
  ScriptInfo,
  V8ScriptCoverage,
} from '../types.js'

export interface RescanningSocketSourceOptions {
  /** The directory the instrument modules wrote into. Defaults to `CBD_SOCKET_DIR`. */
  dir?: string
  /** How long to wait for a connect, a hello or a take. */
  timeoutMs?: number
}

/** One instrumented process, and the socket it is reached by. */
interface Target {
  path: string
  source: QueuedSource
  pid: number
}

/**
 * How many times a socket path is tried before it is written off.
 *
 * `server.listen(path)` binds the path before it accepts, so a boundary that lands in
 * that window sees a file it cannot connect to. The next boundary is a whole test
 * later, by which time the listener is up — or the process is gone and the file is a
 * leftover, which is what a second failure says.
 */
const ATTACH_ATTEMPTS = 2

export async function rescanningSocketSource(
  options: RescanningSocketSourceOptions = {},
): Promise<QueuedSource> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSPECTOR_TIMEOUT_MS
  const configured = options.dir ?? process.env[SOCKET_DIR_ENV]
  if (configured === undefined || configured === '') {
    throw new SocketSourceError(
      `no socket directory: pass "dir", or set ${SOCKET_DIR_ENV} to the directory the ` +
        'instrument module was pointed at.',
    )
  }
  // Narrowed above and copied here, so that the closures below — `attach` is hoisted,
  // and TypeScript will not carry a narrowing into one — read a `string` and not a
  // `string | undefined`.
  const dir: string = configured

  const targets: Target[] = []
  /** Paths never to open again: this process's own, and a pid already held. */
  const refused = new Set<string>()
  /** Paths with an attach in flight, so two boundaries cannot start two of them. */
  const attaching = new Map<string, Promise<V8ScriptCoverage[]>>()
  const failures = new Map<string, number>()

  let closed = false
  let outstanding = 0
  let nextSeq = 0

  /**
   * The merged script table, rebuilt only when one of the targets' tables has grown.
   *
   * `normalize` reads this once per window, and a table holds every script the process
   * parsed — node internals and dependencies included — so merging from scratch every
   * window would be thousands of entries times the number of tests, for a table that
   * stops changing after the first second of the run. Sizes only ever grow, so the sum
   * is a sound thing to compare.
   */
  let merged = new Map<string, ScriptInfo>()
  let mergedRows = -1

  function scripts(): ReadonlyMap<string, ScriptInfo> {
    let rows = 0
    for (const target of targets) rows += target.source.scripts().size
    if (rows === mergedRows) return merged

    mergedRows = rows
    merged = new Map()
    for (const target of targets) {
      for (const [id, info] of target.source.scripts()) merged.set(`${String(target.pid)}:${id}`, info)
    }
    return merged
  }

  /** One target's window, with its ids moved into that target's namespace. */
  function takeFrom(target: Target): Promise<V8ScriptCoverage[]> {
    let settle: Promise<V8ScriptCoverage[]>
    try {
      settle = target.source.dispatch().settle()
    } catch {
      settle = Promise.resolve([])
    }
    return settle.then(
      (payload) =>
        payload.map((script) => ({ ...script, scriptId: `${String(target.pid)}:${script.scriptId}` })),
      // Swallowed per target rather than left to the Recorder. The Recorder catches a
      // failed window for the whole source, which would blank every *other* target's
      // coverage in the same window: one service dying mid-run would erase the lane's
      // map for that test as well as its own.
      () => [],
    )
  }

  /**
   * Opens one socket, holds it if it is a process of ours to read, and — mid-run —
   * takes the window it appeared in.
   *
   * `boundary` is false only at install, where the next boundary is the first one of
   * the run and takes the whole history regardless. See the module docblock.
   */
  async function attach(path: string, boundary: boolean): Promise<V8ScriptCoverage[]> {
    try {
      const source = await socketSource({ socket: path, timeoutMs })
      // The run can end while an attach is in flight, and an unclosed `net.Socket`
      // keeps Node alive: a run that prints its summary and then hangs.
      if (closed) {
        source.close()
        return []
      }
      // This process's own coverage is taken in-process by the adapter's source, so
      // reading it here would double every touch the test process produced. A second
      // socket for a pid already held is the same process seen twice.
      if (source.pid === process.pid || targets.some((target) => target.pid === source.pid)) {
        source.close()
        refused.add(path)
        return []
      }
      const target: Target = { path, source, pid: source.pid }
      targets.push(target)
      return boundary ? takeFrom(target) : []
    } catch {
      failures.set(path, (failures.get(path) ?? 0) + 1)
      return []
    }
  }

  for (const path of socketPaths(dir)) await attach(path, false)
  if (targets.length === 0) throw noServiceError(dir)

  function dispatch(): PendingTake {
    if (closed) throw new SocketSourceError('the source is closed')
    const seq = nextSeq++
    outstanding += 1

    const parts: Array<Promise<V8ScriptCoverage[]>> = []
    // First, in this tick and nothing awaited before it: the boundary every held
    // target is asked for. That ordering is the contract in `source/inspector.ts` —
    // dispatch time is the boundary, not completion time — and an `await` above it
    // would fold one test's execution into its neighbour's window.
    for (const target of targets) parts.push(takeFrom(target))

    // Then a look at what is new. A directory that has become unreadable is not worth
    // taking the run down for: the targets already held can still be read, and the
    // alternative is that a whole run's server coverage becomes empty windows.
    let candidates: string[] = []
    try {
      candidates = socketPaths(dir)
    } catch {
      candidates = []
    }

    for (const path of candidates) {
      if (refused.has(path) || attaching.has(path)) continue
      if (targets.some((target) => target.path === path)) continue
      if ((failures.get(path) ?? 0) >= ATTACH_ATTEMPTS) continue

      const promise = attach(path, true)
      attaching.set(path, promise)
      void promise.then(() => attaching.delete(path))
      parts.push(promise)
    }

    const settled = Promise.all(parts).then((windows) => windows.flat())
    void settled.then(
      () => {
        outstanding -= 1
      },
      () => {
        outstanding -= 1
      },
    )
    return { seq, settle: () => settled }
  }

  return {
    kind: 'socket-rescan',
    supportsSync: false,
    // The process the run was pointed at, which is the one the service shard's header
    // names. Any later target is in the same shard and named nowhere, which is fine:
    // nothing downstream reads that field (ADR-0007).
    pid: (targets[0] as Target).pid,

    takeSync(): V8ScriptCoverage[] {
      throw new SocketSourceError(
        'rescanningSocketSource cannot take synchronously: it reads processes on the other ' +
          'side of a socket, and a round trip cannot complete inside a japa lifecycle hook. ' +
          'Use take(), or dispatch() where the boundary has to be synchronous, and see the ' +
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
            'needs to send boundaries it cannot wait on.',
        )
      }
      return dispatch().settle()
    },

    dispatch,
    scripts,

    /**
     * The run's boundaries, over every target, as one set of numbers.
     *
     * Per target the numbers mean what they mean in `socket.ts`; across targets they are
     * combined so that the reading stays the same one it has always been. `maxUs` and
     * `maxDepth` are the worst any target saw, because "how bad did a boundary land" is
     * a question about the worst case; `minGapUs` is the closest any two boundaries came,
     * which is the denominator the drift is read against and so also a worst case. The
     * mean is over all windows rather than the mean of means, so a target with more
     * windows weighs more — it has more boundaries whose landing the number describes.
     */
    drift: (): DriftStats => {
      let windows = 0
      let totalUs = 0
      let maxUs = 0
      let maxDepth = 0
      let minGapUs = 0
      for (const target of targets) {
        const drift = target.source.drift()
        windows += drift.windows
        // Recovered from the mean rather than carried: one multiplication per target,
        // and the round trip through a double is exact to within an ulp of a microsecond.
        totalUs += drift.meanUs * drift.windows
        if (drift.maxUs > maxUs) maxUs = drift.maxUs
        if (drift.maxDepth > maxDepth) maxDepth = drift.maxDepth
        if (drift.minGapUs !== 0 && (minGapUs === 0 || drift.minGapUs < minGapUs)) minGapUs = drift.minGapUs
      }
      return {
        windows,
        maxUs,
        meanUs: windows === 0 ? 0 : totalUs / windows,
        maxDepth,
        minGapUs,
      }
    },

    close: () => {
      if (closed) return
      closed = true
      for (const target of targets) target.source.close()
    },
  }
}
