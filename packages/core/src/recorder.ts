/**
 * Turns a test run into shard records.
 *
 * Buckets, and why each exists:
 *   per-test   the window between a test's start and its end. The product.
 *   @load      everything before the first test — module imports. Recorded at
 *              `runStart`, which only works because the source is created before
 *              the test files are imported.
 *   @between   everything outside a window: a background timer, a lazily loaded
 *              module, work between tests. Unattributable, so the selector has to
 *              treat it as reaching every test.
 *
 * ## Two sources, one bookkeeping, and why they are not two recorders
 *
 * A *synchronous* source answers in the tick its window closes, so its record is
 * written in that tick. That is a requirement rather than a style choice: japa does
 * not await its lifecycle hooks (A0 F1), and a write deferred to a microtask could
 * land after `runEnd` had already written the footer — a shard whose footer
 * precedes its records, which `parseShard` would have no way to notice.
 *
 * A *queued* source cannot answer in that tick. It can only be handed a boundary
 * and asked for the reply later, which is what `QueuedSource` is for. Its records
 * are therefore queued behind one another and written when the replies land.
 *
 * Everything else — which bucket a boundary belongs to, when `@load` is captured,
 * how a test's duration is derived — is identical, and it is precisely the part
 * that must not exist in two copies. The `@load` rule is a single boolean with three
 * call sites and a subtle one (a run with no tests still has a load phase, and it
 * is only discovered at `runEnd`); two copies that drifted would misfile an entire
 * import phase as `@between`, which escalates rather than under-selects. So the
 * bookkeeping below is written once and the *difference* is a `Windows` strategy:
 * four small functions that decide when a line reaches the sink.
 *
 * ## The ordinal registry is per run, and shared by both strategies
 *
 * V8 stops reporting a script's full function list after the take that follows its
 * compilation, so ordinals derived from a later window would be drawn from a subset
 * and two different functions could collide on one key. One registry per run, and
 * the queued strategy normalizes each window *inside* its chain rather than when the
 * reply arrives, so windows are keyed in boundary order.
 */
import { normalize, type OrdinalRegistry, type ScanOptions, type Touch } from './normalize.js'
import { SHARD_VERSION, type ShardRecord, type ShardSink, type TouchRef } from './shard.js'
import type { DriftStats, QueuedSource, Source, V8ScriptCoverage } from './types.js'

export type TestStatus = 'passed' | 'failed' | 'skipped'

/**
 * Which outcome a test had, from the plain booleans a runner reports.
 *
 * A skipped test still emits start and end events, and its `hasError` is false —
 * so mapping on `hasError` alone records a test that never ran as a passing one
 * with an empty window. That is precisely the "green runs only" hazard amendment
 * 5 exists for, so the caller must pass `isSkipped` through.
 */
export function classifyStatus(outcome: {
  hasError?: boolean
  isSkipped?: boolean
  isTodo?: boolean
}): TestStatus {
  // A todo has no window either, so it is grouped with skipped: the map cares
  // only about whether the recorded coverage can be trusted.
  if (outcome.isSkipped === true || outcome.isTodo === true) return 'skipped'
  return outcome.hasError === true ? 'failed' : 'passed'
}

export interface RecorderOptions {
  source: Source
  sink: ShardSink
  commit: string
  /** Forwarded to `normalize` — projection and relocation rules, include/exclude, prefilter. */
  scan?: ScanOptions
  pid?: number
  now?: () => number
}

function toRefs(touches: Touch[]): TouchRef[] {
  return touches.map((touch) => [touch.file, touch.key, touch.startLine, touch.endLine])
}

/** Turns one window's payload into the touches the map stores. */
type Normalizer = (payload: V8ScriptCoverage[]) => TouchRef[]

/**
 * When a record reaches the sink, and what a window boundary does.
 *
 * The only thing the two kinds of recorder disagree about. Every method is
 * called synchronously from a lifecycle hook, so a strategy that has to wait must
 * do its waiting in its own time — the boundary is crossed when the hook calls
 * `commitWindow`, never when the reply lands.
 */
interface Windows {
  /** A record that is already known: the header, the footer. */
  commit(record: ShardRecord): void
  /**
   * A record that needs a window. `build` is handed the window's touches and
   * returns the record, or `null` for a window with nothing in it that is not
   * worth a line.
   *
   * `build` must be a pure function of its argument. It runs at a different time
   * for the two strategies — in the same tick for a synchronous source, whenever
   * the reply lands for a queued one — so anything it reads from the surrounding
   * scope is read at two different points in the run. Capture first, build second.
   */
  commitWindow(build: (touches: TouchRef[]) => ShardRecord | null): void
  /**
   * A record whose content is not settled until every window ahead of it has been
   * read. The footer, and so far only the footer, is one: it reports the drift of the
   * run, and the boundary this same call just sent is still in flight.
   *
   * The mirror image of `commitWindow`, and the rule inverts with it. There, `build`
   * must be a pure function of its argument because it runs at a point in the run
   * that depends on the source; here, `build` runs precisely *because* it is late.
   * Nothing that varies per window may be read inside it, and nothing that is a fact
   * of the run may be left out of it — the two halves of the footer are split exactly
   * that way.
   */
  commitFinal(build: () => ShardRecord): void
  /** Resolves once every record has reached the sink. */
  drained(): Promise<void>
}

/**
 * How far this source's boundaries have landed from where they were meant.
 *
 * `null` for a source with no boundary to miss. Taken by calling rather than by
 * reading a field, so that a source which keeps the number live cannot accidentally
 * have it read once and captured.
 */
function driftOf(source: Source): DriftStats | null {
  const maybe = source as { drift?: () => DriftStats }
  return typeof maybe.drift === 'function' ? maybe.drift.call(source) : null
}

/** A source that answers in the same tick: write the record in that same tick. */
function syncWindows(source: Source, sink: ShardSink, normalizeWindow: Normalizer): Windows {
  return {
    commit(record) {
      sink.append(JSON.stringify(record))
    },
    commitWindow(build) {
      let payload: V8ScriptCoverage[]
      try {
        payload = source.takeSync()
      } catch {
        // A dead inspector session must not take the test run down with it. An
        // empty window under-selects for that test, which is why the run should
        // also be reported as unhealthy rather than silently trusted.
        payload = []
      }
      const record = build(normalizeWindow(payload))
      if (record !== null) sink.append(JSON.stringify(record))
    },
    commitFinal(build) {
      // Nothing to wait for: a synchronous source has already answered every window
      // by the time this is called, which is why its footer carries no drift.
      sink.append(JSON.stringify(build()))
    },
    drained: () => Promise.resolve(),
  }
}

/** A source that answers later: queue the records so they stay in boundary order. */
function queuedWindows(source: QueuedSource, sink: ShardSink, normalizeWindow: Normalizer): Windows {
  let chain: Promise<void> = Promise.resolve()

  /**
   * Appends to the queue. `work` must *return* its promise — returning void from an
   * async worker resolves the chain immediately and the ordering is silently gone,
   * which is a mistake this function's first version made and the byte-comparison
   * test caught.
   */
  const queue = (work: () => void | Promise<void>): void => {
    chain = chain.then(work)
  }

  return {
    commit(record) {
      queue(() => {
        sink.append(JSON.stringify(record))
      })
    },
    commitWindow(build) {
      let reply: Promise<V8ScriptCoverage[]>
      try {
        // Here, in this tick, with nothing awaited before it: this call is the
        // boundary. Everything below is bookkeeping.
        reply = source.dispatch().settle()
      } catch {
        reply = Promise.resolve([])
      }

      queue(async () => {
        let payload: V8ScriptCoverage[]
        try {
          payload = await reply
        } catch {
          // The socket died mid-run, or the target went away. Same answer as the
          // synchronous path gives for a dead session: an empty window, which
          // under-selects and should be visible as an unhealthy run.
          payload = []
        }
        // Normalized inside the chain, not when the reply landed, so the shared
        // ordinals registry sees windows in boundary order.
        const record = build(normalizeWindow(payload))
        if (record !== null) sink.append(JSON.stringify(record))
      })
    },
    commitFinal(build) {
      queue(() => {
        sink.append(JSON.stringify(build()))
      })
    },
    drained: () => chain,
  }
}

/**
 * The strategy a source needs, or a refusal to build one at all.
 *
 * A source that can neither take synchronously nor accept a boundary cannot be
 * recorded — and the failure it produces if allowed through is the worst kind
 * this project has: every window comes back empty, every test is recorded as
 * touching nothing, and the resulting map is complete, well-formed and says no
 * test reaches any code. That reads as a confident answer rather than as a fault,
 * so it is refused here, where the source is still in hand and can be named.
 */
function windowsFor(source: Source, sink: ShardSink, normalizeWindow: Normalizer): Windows {
  if (source.supportsSync) return syncWindows(source, sink, normalizeWindow)
  if (typeof (source as QueuedSource).dispatch === 'function') {
    return queuedWindows(source as QueuedSource, sink, normalizeWindow)
  }
  throw new Error(
    `the source "${source.kind}" can neither take synchronously nor accept a window boundary, ` +
      'so every window it produced would be empty and the map would record that no test reaches ' +
      'anything. Implement QueuedSource (dispatch plus settle) on it, or drive it from a caller ' +
      'that owns the whole run rather than from the Recorder.',
  )
}

export class Recorder {
  #windows: Windows
  #source: Source
  #commit: string
  #pid: number
  #now: () => number
  #testCount = 0
  #loadCaptured = false
  /**
   * Keys must not be recomputed window by window: V8 stops reporting a script's
   * full function list after the take that follows its compilation, so ordinals
   * derived from a later window would be drawn from a subset and two different
   * functions could collide on one key. One registry per run.
   */
  #ordinals: OrdinalRegistry = new Map()
  #open: { title: string; file: string | null; startedAt: number } | null = null

  constructor(options: RecorderOptions) {
    this.#commit = options.commit
    this.#pid = options.pid ?? process.pid
    this.#now = options.now ?? Date.now

    const scan = options.scan ?? {}
    const source = options.source
    this.#source = source
    this.#windows = windowsFor(source, options.sink, (payload) =>
      toRefs(normalize(payload, source, { ...scan, ordinals: this.#ordinals })),
    )
  }

  #bucket(kind: 'load' | 'between' | 'teardown'): void {
    this.#windows.commitWindow((touches) => (touches.length === 0 ? null : { type: kind, touches }))
  }

  /**
   * Writes the shard header. Call it as early as possible — at plugin-install
   * time, before the test files are imported — so that a crash leaves evidence
   * of how far the run got.
   *
   * It deliberately does NOT take a window. Importing the test files is what
   * produces the `@load` activity, and that happens *after* the source is
   * created but *before* the runner starts, so an early take would capture an
   * empty window and silently mis-file the entire load phase as `@between`.
   */
  runStart(): void {
    this.#windows.commit({
      type: 'shard',
      version: SHARD_VERSION,
      commit: this.#commit,
      pid: this.#pid,
      startedAt: new Date(this.#now()).toISOString(),
    })
  }

  testStart(title: string, file: string | null = null): void {
    // The first test's start is the moment the load phase ends: everything the
    // process executed up to here is module import, which is `@load`.
    if (!this.#loadCaptured) {
      this.#loadCaptured = true
      this.#bucket('load')
    } else {
      this.#bucket('between')
    }
    this.#open = { title, file, startedAt: this.#now() }
  }

  testEnd(title: string, status: TestStatus, durationMs?: number): void {
    // Every field that is not the window is read *here*, before the record is
    // handed over, and that is not tidiness. A queued source builds its record when
    // the reply lands, so anything read inside the builder would be read after the
    // run had moved on — the duration would absorb whatever happened in between,
    // and on a run whose windows are milliseconds long that is most of the value.
    // The builder's only job is to supply the touches.
    const open = this.#open
    const file = open?.title === title ? open.file : (open?.file ?? null)
    const elapsed = durationMs ?? (open === null ? 0 : this.#now() - open.startedAt)

    this.#windows.commitWindow((touches) => ({
      type: 'test',
      title,
      file,
      status,
      durationMs: elapsed,
      touches,
    }))
    this.#testCount += 1
    this.#open = null
  }

  runEnd(): void {
    // A run with no tests never reached the first `testStart`, so the load
    // window is still outstanding.
    if (!this.#loadCaptured) {
      this.#loadCaptured = true
      this.#bucket('load')
    }
    // Post-run activity — global teardown hooks, a timer from the last test that
    // fired late. Filed separately from @between because §8.3 treats a file
    // reached only by teardown as startup code, like @load.
    this.#bucket('teardown')

    // Everything about the footer except the drift is known here, and is captured
    // here. The drift is not: it is the distance between a boundary being sent and
    // being received, and the boundary this call just sent is still in flight — so
    // reading it now would report a run of N windows as N-1 and understate, by one
    // window, the very error the number exists to expose. `commitFinal` builds the
    // footer when the queue reaches it, which is after every reply ahead of it has
    // landed and the count is whole.
    const tests = this.#testCount
    const finishedAt = new Date(this.#now()).toISOString()
    const source = this.#source
    this.#windows.commitFinal(() => {
      const drift = driftOf(source)
      return { type: 'end', tests, finishedAt, ...(drift === null ? {} : { drift }) }
    })
  }

  /**
   * Resolves once every record has reached the sink.
   *
   * A caller driving a synchronous source can ignore this — its `runEnd` has
   * already written the footer. A caller driving a queued one must await it, or
   * the process can exit with records still in flight and the shard left without
   * its footer, which `parseShard` refuses.
   */
  drained(): Promise<void> {
    return this.#windows.drained()
  }

  /**
   * Releases the coverage source. Call it once the run is over, after `drained()`.
   *
   * A source holds a resource, and the resource is not inert. `socketSource` holds an
   * open `net.Socket`, and an open socket keeps Node's event loop alive — so a
   * recorded run that never closes its source prints its summary, reports every test
   * green, and then hangs forever. Measured: `packages/japa/bin/e2e.js` with a socket
   * directory set never exited, and the same entry point without one exited in 0.06s.
   * That failure is worse than a crash, because the output says the run succeeded and
   * only a CI timeout says otherwise.
   *
   * The recorder closes what it was handed rather than expecting the caller to keep a
   * second reference to it. Ownership follows the constructor argument.
   *
   * Closing before `drained()` would lose records rather than merely tidy up, which is
   * why the adapters close afterwards and not at the first opportunity.
   */
  close(): void {
    this.#source.close()
  }
}
