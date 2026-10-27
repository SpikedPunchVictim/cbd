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
 * **A process that dies before it is attached is read from its exit snapshot.** A
 * normal exit unlinks the socket, so the discovery loop cannot see it at all; what is
 * left is `pid-N.coverage.json` beside where the socket was. That file is ADR-0007's
 * second mechanism, and this source harvests it: once per process, for a process born
 * after the recording started and never attached, delivered to the boundary that
 * discovered it.
 *
 * **A process that dies while attached is read by its own socket source.** The take
 * fails, and the exit write's unnumbered lifetime is recovered once, by the boundary
 * that discovers the loss (`socket.ts`); this source neither duplicates nor loses it.
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
import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { DEFAULT_INSPECTOR_TIMEOUT_MS } from './inspector.js'
import {
  SocketSourceError,
  noServiceError,
  pidOfSnapshotPath,
  pidOfSocketPath,
  snapshotLifetime,
  snapshotPaths,
  socketPaths,
  socketSource,
} from './socket.js'
import { INSTRUMENT_PROTOCOL, SOCKET_DIR_ENV, socketDirFromEnv, nowUs, snapshotPath, type ScriptRow, type SnapshotFile } from '../instrument-protocol.js'
import type {
  DriftStats,
  PendingTake,
  QueuedSource,
  ScriptInfo,
  TaggedCoverage,
  TakeCapture,
  V8ScriptCoverage,
} from '../types.js'

export interface RescanningSocketSourceOptions {
  /** The directory the instrument modules wrote into. Defaults to `CBD_SOCKET_DIR`. */
  dir?: string
  /** How long to wait for a connect, a hello or a take. */
  timeoutMs?: number
  /**
   * Turn on request-id correlation in every target this source attaches to,
   * including the ones that appear mid-run.
   *
   * Passed through to `socketSource`, so the op is sent on attach rather than at
   * the boundary: a target discovered while a window is open must be correlating
   * before the next request, not after the next test.
   */
  correlationHeader?: string
  /**
   * How often to look for a new target *between* boundaries. Default 25 ms.
   *
   * The interval bounds how long a newly appeared process waits to be attached; a
   * test can lengthen it to keep its own timing deterministic.
   */
  discoveryIntervalMs?: number
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

/**
 * How often to look for a new target *between* boundaries.
 *
 * Attaching costs a connect and a hello, and both are asynchronous. Started at a
 * boundary, that work lands in the same turn as the window normalization — which
 * is where the process's own coverage, the largest payload of the run, is reduced
 * to touches. The loop is busy for tens of milliseconds, the connect cannot
 * complete, and the child's first take is dispatched late enough to carry the
 * *next* test's work. Measured as `cbd-ot8`.
 *
 * So a socket that appears mid-window is attached while the window is still
 * running, and by the next boundary it is an ordinary held target: the take is
 * written synchronously in the boundary tick, before any normalization. The
 * interval is a bound on how long a newly appeared target waits, not on when its
 * coverage is attributed — that rule is unchanged, and is still the boundary that
 * discovers it.
 */
const DISCOVERY_INTERVAL_MS = 25

export async function rescanningSocketSource(
  options: RescanningSocketSourceOptions = {},
): Promise<QueuedSource> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSPECTOR_TIMEOUT_MS
  const configured = options.dir ?? socketDirFromEnv()
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
  /** Paths with an attach in flight, so two lookers cannot start two of them. */
  const attaching = new Map<string, Promise<Target | null>>()
  const failures = new Map<string, number>()
  /**
   * The file each path's failures were counted against (inode and mtime). A path is
   * only a name: once a different file sits under it, the process that earned the
   * failures is gone and the verdict does not carry over to its successor.
   */
  const failedFile = new Map<string, string>()
  /** The last error each path produced, for the one warning when it is given up on. */
  const lastError = new Map<string, string>()
  /** Paths already reported as written off; the warning is said once. */
  const writtenOff = new Set<string>()

  /**
   * Processes that died before their socket answered, and the lifetime each left.
   *
   * Read once, delivered once: the next boundary is the one that discovered them,
   * which is the same window a live target's first take would have gone to.
   */
  interface Harvest {
    pid: number
    coverage: V8ScriptCoverage[]
    scripts: ScriptRow[]
    ids: string[]
    requests: TakeCapture['requests']
    /** Files the process read since its last take; absent when none. */
    reads?: string[]
    dirReads?: string[]
  }
  /** Harvests waiting for the next boundary. Drained on delivery. */
  const harvested: Harvest[] = []
  /**
   * Every harvest ever made, kept after delivery. The script table and the missing-text
   * list describe the whole run, so a delivered harvest's rows must stay in them: the
   * build resolves a harvested process's ranges through exactly those rows.
   */
  const everHarvested: Harvest[] = []
  /**
   * Process identities already harvested or reserved: pid plus the instrument's start
   * time, because a pid can be reused by a later process and that is a new lifetime.
   */
  const harvestedKeys = new Set<string>()

  /** Processes born before this are another run's: their files can share the directory. */
  const recordingStartedUs = nowUs()
  /** The same instant on the wall clock, which a file's mtime is on. */
  const recordingStartedMs = Date.now()
  const MTIME_SLACK_MS = 2_000

  let closed = false
  let lost = 0
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
    let rows = everHarvested.length
    for (const target of targets) rows += target.source.scripts().size
    if (rows === mergedRows) return merged

    mergedRows = rows
    merged = new Map()
    for (const target of targets) {
      for (const [id, info] of target.source.scripts()) merged.set(`${String(target.pid)}:${id}`, info)
    }
    for (const harvest of everHarvested) {
      for (const row of harvest.scripts) {
        merged.set(`${String(harvest.pid)}:${row.id}`, {
          url: row.url,
          ...(row.sourceMapURL === undefined ? {} : { sourceMapURL: row.sourceMapURL }),
        })
      }
    }
    return merged
  }

  /**
   * Reads the exit snapshot of a process whose socket would not answer.
   *
   * The socket file outlives the process, so the connect failure is what says the
   * process is gone. Its exit write is the whole lifetime — the accumulator no take
   * drained plus the rows no reply delivered — and it is this run's because the
   * process was born after the recording started and no collector ever attached.
   */
  async function harvestPid(pid: number | undefined): Promise<Harvest | null> {
    if (pid === undefined) return null
    if (targets.some((target) => target.pid === pid)) return null

    let modifiedMs: number | undefined
    let file: SnapshotFile
    // The snapshot lives in the directory its socket would have been in.
    const path = snapshotPath(dir, pid)
    try {
      modifiedMs = statSync(path).mtimeMs
    } catch {
      // Read below decides; a missing file is simply not harvestable.
    }
    // `startedAtUs` is a monotonic clock whose origin resets at boot, so it cannot
    // tell a file left before a reboot from one written by this run. The mtime is
    // wall clock: a file last written before the recording began is not this run's.
    // The slack covers filesystems whose mtime is coarser than a second.
    if (modifiedMs !== undefined && modifiedMs < recordingStartedMs - MTIME_SLACK_MS) {
      markAttempted(pid, modifiedMs)
      return null
    }
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return null
    }
    try {
      file = JSON.parse(text) as SnapshotFile
    } catch {
      // A snapshot is written whole and renamed into place, so bytes that do not
      // parse will not once waited on. A new write changes the mtime and is looked at.
      markAttempted(pid, modifiedMs)
      return null
    }
    // Valid JSON of the wrong shape (`null`, a number) is not a snapshot. Nothing a
    // later look would learn, so it is final.
    if (typeof file !== 'object' || file === null || !Array.isArray(file.scripts)) {
      markAttempted(pid, modifiedMs)
      return null
    }

    // Reserved before anything else happens and with no await since the check: the
    // socket path and the snapshot path can reach the same file in one boundary, and
    // two of them past a check that only the later one fills in would deliver one
    // lifetime twice.
    const key = `${String(pid)}:${String(file.startedAtUs)}`
    if (harvestedKeys.has(key)) return null
    harvestedKeys.add(key)

    const lifetime = snapshotLifetime(file, recordingStartedUs)
    if (lifetime === null) {
      harvestedKeys.delete(key)
      // A file from this run with no exit write yet belongs to a process that is
      // still alive; it must be read again once it has gone. Anything else will not
      // become harvestable by waiting.
      const alive =
        file.protocol === INSTRUMENT_PROTOCOL &&
        file.session === undefined &&
        file.startedAtUs >= recordingStartedUs &&
        file.endedAtUs === undefined
      if (!alive) markAttempted(pid, modifiedMs)
      return null
    }

    markAttempted(pid, modifiedMs)
    const harvest: Harvest = {
      pid,
      coverage: lifetime.coverage,
      scripts: lifetime.scripts,
      ids: lifetime.ids,
      requests: lifetime.requests,
      ...(lifetime.reads === undefined ? {} : { reads: lifetime.reads }),
      ...(lifetime.dirReads === undefined ? {} : { dirReads: lifetime.dirReads }),
    }
    everHarvested.push(harvest)
    return harvest
  }

  /** One harvest as a window's capture, in that process's script-id namespace. */
  function captureOf(harvest: Harvest): TakeCapture {
    const pid = String(harvest.pid)
    const prefix = (coverage: V8ScriptCoverage[]): V8ScriptCoverage[] =>
      coverage.map((script) => ({ ...script, scriptId: `${pid}:${script.scriptId}` }))
    return {
      coverage: prefix(harvest.coverage),
      ids: harvest.ids,
      requests: harvest.requests.map((window) => ({
        ids: window.ids,
        coverage: prefix(window.coverage),
      })),
      ...(harvest.reads === undefined ? {} : { reads: harvest.reads }),
      ...(harvest.dirReads === undefined ? {} : { dirReads: harvest.dirReads }),
    }
  }

  /** One target's window, with its ids moved into that target's namespace. */
  function takeFrom(target: Target): Promise<TakeCapture> {
    const pid = String(target.pid)
    const prefix = (coverage: V8ScriptCoverage[]): V8ScriptCoverage[] =>
      coverage.map((script) => ({ ...script, scriptId: `${pid}:${script.scriptId}` }))

    let settled: Promise<TakeCapture>
    try {
      const pending = target.source.dispatch()
      settled =
        pending.settleTagged === undefined
          ? pending.settle().then((coverage) => ({ coverage, ids: [], requests: [] }))
          : pending.settleTagged()
    } catch {
      settled = Promise.resolve({ coverage: [], ids: [], requests: [] })
    }
    return settled.then(
      (capture) => ({
        coverage: prefix(capture.coverage),
        // An id belongs to the test process that generated it, not to the target
        // that echoed it, so it is passed through unchanged.
        ids: capture.ids,
        requests: capture.requests.map((window: TaggedCoverage) => ({
          ids: window.ids,
          coverage: prefix(window.coverage),
        })),
        // Reads are paths, not script ids: one namespace, no prefixing.
        ...(capture.reads === undefined ? {} : { reads: capture.reads }),
        ...(capture.dirReads === undefined ? {} : { dirReads: capture.dirReads }),
      }),
      // Swallowed per target rather than left to the Recorder. The Recorder catches a
      // failed window for the whole source, which would blank every *other* target's
      // coverage in the same window: one service dying mid-run would erase the lane's
      // map for that test as well as its own. The loss itself is counted separately,
      // because an uncounted empty window under-selects silently.
      () => {
        lost += 1
        return { coverage: [], ids: [], requests: [] }
      },
    )
  }

  /**
   * Opens one socket and holds it if it is a process of ours to read.
   *
   * It deliberately takes nothing. A take is a boundary event, and the boundary
   * decides which window the target's first take is credited to; attaching is only
   * discovery, and doing it ahead of the boundary is what keeps that take
   * synchronous (see `DISCOVERY_INTERVAL_MS`).
   */
  async function attach(
    path: string,
    deliver?: (harvest: Harvest) => void,
  ): Promise<Target | null> {
    try {
      const source = await socketSource({
        socket: path,
        timeoutMs,
        ...(options.correlationHeader === undefined
          ? {}
          : { correlationHeader: options.correlationHeader }),
      })
      // The run can end while an attach is in flight, and an unclosed `net.Socket`
      // keeps Node alive: a run that prints its summary and then hangs.
      if (closed) {
        source.close()
        return null
      }
      // This process's own coverage is taken in-process by the adapter's source, so
      // reading it here would double every touch the test process produced. A second
      // socket for a pid already held is the same process seen twice.
      if (source.pid === process.pid || targets.some((target) => target.pid === source.pid)) {
        source.close()
        refused.add(path)
        return null
      }
      const target: Target = { path, source, pid: source.pid }
      targets.push(target)
      return target
    } catch (error) {
      // A socket file outlives its process. If the process ended before it answered,
      // its exit snapshot is still this run's work — read it once instead of
      // reporting the child missing.
      const recovered = await harvestPid(pidOfSocketPath(path))
      if (recovered !== null) {
        refused.add(path)
        // The boundary that discovered the process gets its lifetime in that same
        // window; a background look queues it for the next one, exactly as a live
        // target found between boundaries waits for the next take.
        if (deliver === undefined) harvested.push(recovered)
        else deliver(recovered)
        return null
      }
      failures.set(path, (failures.get(path) ?? 0) + 1)
      const identity = fileIdentity(path)
      if (identity === undefined) failedFile.delete(path)
      else failedFile.set(path, identity)
      lastError.set(path, error instanceof Error ? error.message : String(error))
      return null
    }
  }

  for (const path of socketPaths(dir)) await attach(path)
  if (targets.length === 0) throw noServiceError(dir)

  // Attach while the window is still running, so that the boundary does not have
  // to. See `DISCOVERY_INTERVAL_MS`.
  const discovery = setInterval(() => {
    if (!closed) attachCandidates(false, [])
  }, options.discoveryIntervalMs ?? DISCOVERY_INTERVAL_MS)
  discovery.unref()

  /**
   * Opens any socket not already held.
   *
   * `boundary` says whether this look closes a window, in which case each target
   * this look is responsible for — including one whose attach is already in flight
   * from a background tick — contributes its first take to that window. Waiting on
   * an in-flight attach rather than skipping it is what keeps a socket that
   * appeared late in a window from being credited to the *next* one: skipping it
   * would make the next boundary the first boundary after it was held, and the
   * whole history would move with it.
   */
  /**
   * Pids whose snapshot has been looked at, so a file that cannot be harvested is
   * not read again at every boundary. A process that exits without running its exit
   * handler leaves only the bounded periodic file, and that one is not recoverable
   * by any rule — retrying would pay a read per test to learn nothing.
   */
  const harvestAttempted = new Map<number, number | undefined>()

  /** Records that this version of the pid's snapshot will never become harvestable. */
  function markAttempted(pid: number, modifiedMs: number | undefined): void {
    harvestAttempted.set(pid, modifiedMs)
  }

  /**
   * Processes that exited before any socket could answer: a normal exit unlinks the
   * socket, so the discovery loop's socket list cannot see them at all.
   */
  function harvestCandidates(boundary: boolean, parts: Array<Promise<TakeCapture>>): void {
    for (const path of snapshotPaths(dir)) {
      const pid = pidOfSnapshotPath(path)
      if (pid === undefined || pid === process.pid) continue
      if (targets.some((target) => target.pid === pid)) continue
      // Skipped only while the file is the one already judged: a reused pid writes a
      // new file, and that is a new process to look at.
      if (harvestAttempted.has(pid)) {
        let modifiedMs: number | undefined
        try {
          modifiedMs = statSync(path).mtimeMs
        } catch {
          continue
        }
        if (harvestAttempted.get(pid) === modifiedMs) continue
      }

      const opening = harvestPid(pid)
      if (boundary) {
        parts.push(
          opening.then((harvest) =>
            harvest === null ? { coverage: [], ids: [], requests: [] } : captureOf(harvest),
          ),
        )
      } else {
        void opening.then((harvest) => {
          if (harvest !== null) harvested.push(harvest)
        })
      }
    }
  }

  function fileIdentity(path: string): string | undefined {
    try {
      const stats = statSync(path)
      return `${String(stats.ino)}:${String(stats.mtimeMs)}`
    } catch {
      return undefined
    }
  }

  function attachCandidates(boundary: boolean, parts: Array<Promise<TakeCapture>>): void {
    let candidates: string[] = []
    try {
      candidates = socketPaths(dir)
    } catch {
      // A directory that has become unreadable is not worth taking the run down
      // for: the targets already held can still be read, and the alternative is
      // that a whole run's server coverage becomes empty windows.
      candidates = []
    }

    // A process that exited normally unlinked its socket, so there is no path to
    // connect to and the loop below cannot see it. Its snapshot is the only thing
    // left of it; look for those too.
    harvestCandidates(boundary, parts)

    for (const path of candidates) {
      if (refused.has(path)) continue
      if (targets.some((target) => target.path === path)) continue
      if (failures.has(path) && failedFile.get(path) !== fileIdentity(path)) {
        // A new process reusing the pid bound the name again: it is a new target.
        failures.delete(path)
        failedFile.delete(path)
        lastError.delete(path)
        writtenOff.delete(path)
      }
      if ((failures.get(path) ?? 0) >= ATTACH_ATTEMPTS) {
        // A written-off socket is coverage the map will not have. The docblock's
        // case is a leftover file, but a target whose loop is blocked past the
        // timeout lands here too, and a missing service must never be silent.
        if (!writtenOff.has(path)) {
          writtenOff.add(path)
          process.stderr.write(
            `cbd: gave up on ${path} after ${String(ATTACH_ATTEMPTS)} attempts ` +
              `(${lastError.get(path) ?? 'no answer'}); that process's coverage is missing ` +
              'from this run, so selection may under-select.\n',
          )
        }
        continue
      }

      // A harvest the attach recovers arrives after `dispatch` has gathered `parts`,
      // so it cannot be pushed there: it is handed to this path's own part, which
      // resolves only once the attach has finished.
      let recovered: Harvest | undefined
      let opening = attaching.get(path)
      if (opening === undefined) {
        opening = attach(path, boundary ? (harvest) => void (recovered = harvest) : undefined)
        attaching.set(path, opening)
        void opening.then(() => attaching.delete(path))
      }
      if (boundary) {
        parts.push(
          opening.then((target) => {
            if (target !== null) return takeFrom(target)
            return recovered === undefined
              ? { coverage: [], ids: [], requests: [] }
              : captureOf(recovered)
          }),
        )
      }
    }
  }

  function dispatch(): PendingTake {
    if (closed) throw new SocketSourceError('the source is closed')
    const seq = nextSeq++
    outstanding += 1

    const parts: Array<Promise<TakeCapture>> = []
    // First, in this tick and nothing awaited before it: the boundary every held
    // target is asked for. That ordering is the contract in `source/inspector.ts` —
    // dispatch time is the boundary, not completion time — and an `await` above it
    // would fold one test's execution into its neighbour's window.
    for (const target of targets) parts.push(takeFrom(target))

    // A process discovered dead at this boundary brings the lifetime it left. It is
    // offered once, to this window — the same rule a live target's first take
    // follows, where the process's start-up is credited to the window that caused it.
    for (const harvest of harvested.splice(0, harvested.length)) {
      parts.push(Promise.resolve(captureOf(harvest)))
    }

    // Then a look at what is new. Usually the background interval has already
    // found and attached it, which is the point: this look is the fallback for a
    // target that appeared between two ticks.
    attachCandidates(true, parts)

    const settled: Promise<TakeCapture> = Promise.all(parts).then((captures) => {
      const reads = captures.flatMap((capture) => capture.reads ?? [])
      const dirReads = captures.flatMap((capture) => capture.dirReads ?? [])
      return {
        coverage: captures.flatMap((capture) => capture.coverage),
        // One id may have requests open in several targets; the recorder resolves it
        // through one owner registry, so duplicates are harmless.
        ids: captures.flatMap((capture) => capture.ids),
        requests: captures.flatMap((capture) => capture.requests),
        // Reads have one namespace across targets — a path is a path — so they are
        // concatenated and the recorder deduplicates.
        ...(reads.length === 0 ? {} : { reads }),
        ...(dirReads.length === 0 ? {} : { dirReads }),
      }
    })
    void settled.then(
      () => {
        outstanding -= 1
      },
      () => {
        outstanding -= 1
      },
    )
    const handle: PendingTake = {
      seq,
      settle: () => settled.then((capture) => capture.coverage),
    }
    // Always: a target's reads travel in the capture, correlated or not.
    handle.settleTagged = () => settled
    return handle
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
    generated: (scriptId: string) => scripts().get(scriptId)?.generated,
    /**
     * Every target's missing scripts, in the shard's namespace.
     *
     * The nested source names its own script ids, which are unique only within its
     * process; the rows this source publishes are `${pid}:${id}` (see `scripts`),
     * and the build looks the id up in exactly that table.
     */
    generatedMissing: () => [
      ...targets.flatMap((target) =>
        (target.source.generatedMissing?.() ?? []).map((id) => `${String(target.pid)}:${id}`),
      ),
      // A harvested process is gone: its generated text can never be fetched, so a
      // script of its that carries a map is exactly the case the partial marker
      // exists for.
      ...everHarvested.flatMap((harvest) =>
        harvest.scripts
          .filter((row) => row.sourceMapURL !== undefined && row.sourceMapURL !== '')
          .map((row) => `${String(harvest.pid)}:${row.id}`),
      ),
    ],
    /** Windows swallowed above: real losses the recorder has no rejection to count. */
    lostTakes: () => lost,
    async prepare(scriptIds: readonly string[]) {
      const byPid = new Map<string, string[]>()
      for (const prefixed of scriptIds) {
        const colon = prefixed.indexOf(':')
        if (colon === -1) continue
        const pid = prefixed.slice(0, colon)
        const local = prefixed.slice(colon + 1)
        const list = byPid.get(pid)
        if (list === undefined) byPid.set(pid, [local])
        else list.push(local)
      }
      await Promise.all(
        [...byPid].map(async ([pid, ids]) => {
          const target = targets.find((candidate) => String(candidate.pid) === pid)
          await target?.source.prepare?.(ids)
        }),
      )
    },

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
      clearInterval(discovery)
      for (const target of targets) target.source.close()
    },
  }
}
