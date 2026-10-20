/**
 * The japa adapter: per-test coverage windows, taken from the emitter.
 *
 * japa is a friendlier host than mocha for *finding the window*, and a harsher one
 * for *using* it. Both differences are facts about japa, measured rather than
 * assumed (`.explore/A0-japa-hooks.md`), and each one shapes the code below.
 *
 * **The window boundary is sharper here.** japa does not await `emit` (A0 F1), so
 * a handler that awaited anything would take its coverage after the next test had
 * started and attribute one test's execution to another. Every handler registered
 * on `test:start` / `test:end` is therefore synchronous and stays that way, and
 * the `Recorder` is driven through its synchronous API only. This is not a style
 * choice; it is the constraint the whole adapter is built around.
 *
 * **The install can be asynchronous, and that is the first escape hatch.** japa
 * *does* await its plugins (`await plugin({…})`), and plugins run before the test
 * files are imported. So the one genuinely async step at the start — opening a
 * coverage source, which for a socket source means a connection — happens at
 * install, and the window boundaries stay sync. That split is why this package
 * needs no `takeSync()` compromise on the install side.
 *
 * **The drain can be asynchronous too, and that is the second.** A boundary can be
 * `dispatch()`ed synchronously even when its reply cannot be read synchronously,
 * so a window crossing into another process still lands where it was meant to; the
 * replies are collected at `runner:end`, which japa awaits (A0 F12). Between those
 * two hatches — install and drain — nothing on the per-test path waits for
 * anything, which is what keeps attribution honest.
 *
 * **The file comes from japa, not from us.** `payload.meta.fileName` is set by the
 * runner as it imports each file, and reaches every `test:start` / `test:end`
 * payload (A0 F8). No stack walk, no source parsing, no loader hook — and the
 * stack walk provably would not have worked, because japa invokes its callbacks
 * from its own frame and the top of the stack is this module.
 *
 * **And the test's identity is its bare title.** `payload.title.original`, never
 * `expanded` — for a test with no dataset the two are identical, and japa's own
 * filter matches the bare one (A0 F10). Recording anything else would have made
 * every emitted filter match zero tests, which is a miss.
 */
import type { CoverageMap, Selection } from '@spikedpunch/cbd'
import {
  Recorder,
  classifyStatus,
  type Correlator,
  type OwnerIndex,
  type ScanOptions,
  type ShardSink,
  type Source,
  type TestStatus,
} from '@spikedpunch/cbd/adapter'
import { withSelfRoot } from './self.js'

/** Everything the adapter needs that it cannot work out for itself. */
export interface AdapterWiring {
  source: Source
  sink: ShardSink
  commit: string
  /**
   * The record-time filters: `prefilter` and `selfRoots` decide which scripts
   * enter the shard. Projection, relocation and include/exclude are applied by
   * `cbd build` in a v2 shard (ADR-0002), so the build needs the same rules.
   */
  scan?: ScanOptions
  /**
   * Whose coverage this is. Defaults to this process, which is right for an
   * in-process source and wrong for one reading a service — the service's
   * execution belongs in a shard naming the service.
   */
  pid?: number
  /** `'service'` records a process the suite observes rather than the test process. */
  role?: 'service'
  /** Resolves a correlation id to the test that sent it. Absent without correlation. */
  owners?: OwnerIndex
}

export interface InstalledAdapter {
  readonly recorders: readonly Recorder[]
  /**
   * Writes the shard footer, waits for any records still in flight, and closes every
   * source.
   *
   * Idempotent. `installJapaAdapter` registers this on `runner:end` itself, and
   * that is the one event where an async listener is safe: japa does not await
   * `emit` for the per-test events (A0 F1), but it *does* await a promise returned
   * by a `runner:end` listener (A0 F12) — measured, not inferred, because
   * "`run()` awaits `runner.end()`" and "japa awaits what a listener returns" are
   * different claims. Every window boundary stays synchronous; only the drain
   * waits. It is exposed as well for callers that drive the emitter by hand.
   */
  finish(): Promise<void>
}

/**
 * Creates the recorder and writes the shard header.
 *
 * Called from the plugin, which japa runs *after* `configure` and *before* it
 * imports the test files. That ordering is exactly what the `@load` bucket needs:
 * importing the test files is the `@load` activity, it has not happened yet, and
 * the `Recorder` captures it at the first test's start. A source created later
 * than this would miss the load phase entirely and misfile it as `@between`.
 */
export function beginShard(wiring: AdapterWiring): Recorder {
  // The adapter's own files are inside every window it closes — it is what takes
  // and normalizes them — so its package root is excluded from the scan here, the
  // one funnel every japa recorder is opened through (`cbd-qly`).
  const recorder = new Recorder({ ...wiring, scan: withSelfRoot(wiring.scan) })
  recorder.runStart()
  return recorder
}

/**
 * The fields of a japa test node the adapter reads.
 *
 * Declared structurally rather than imported. `@japa/runner` does not re-export
 * `TestStartNode`, `TestEndNode` or `Emitter` — they live in `@japa/core`, and
 * reaching for them means depending on a transitive package's internal subpath
 * and inheriting a surface of a hundred fields this adapter never touches. Naming
 * the six it does read keeps the dependency honest and makes a change upstream
 * show up here as a compile error rather than as a silent `undefined`.
 */
export interface JapaTestStartNode {
  title: { original: string; expanded: string }
  meta: { fileName?: string }
}

export interface JapaTestEndNode extends JapaTestStartNode {
  duration: number
  hasError: boolean
  isSkipped?: boolean
  isTodo?: boolean
}

/**
 * Any listener shape. japa's emitter (Emittery) is generic over an event map the
 * adapter deliberately does not model, so the seam is left permissive and each
 * handler narrows to the node type it expects.
 */
export type JapaListener = (...args: never[]) => void

export interface JapaEmitter {
  on(eventName: string, listener: JapaListener): unknown
}

/**
 * japa's outcome vocabulary, mapped onto the recorder's.
 *
 * A skipped test still emits `test:start` and `test:end`, and its `hasError` is
 * false — so a mapping that read `hasError` alone would record a test that never
 * ran as a passing one holding an empty window, which reads as the confident and
 * entirely wrong answer "no test reaches this code". `isSkipped` and `isTodo` are
 * on the payload because they are `TestOptions` fields, so the distinction is
 * available for free; it only has to be looked at, and it is looked at first.
 *
 * The mapping itself lives in the core, next to the reasoning, so both adapters
 * answer this question the same way.
 */
export function statusOf(node: JapaTestEndNode): TestStatus {
  return classifyStatus(node)
}

/**
 * The window hooks, as a plain object.
 *
 * Split out from `installJapaAdapter` so the boundaries can be exercised directly,
 * with a stub recorder and no inspector session. Both are synchronous on purpose —
 * see the module docblock; an `await` in either one silently corrupts attribution.
 */
export function japaWindowHooks(recorder: Recorder): {
  onTestStart(node: JapaTestStartNode): void
  onTestEnd(node: JapaTestEndNode): void
} {
  return {
    onTestStart(node: JapaTestStartNode): void {
      // `original`, not `expanded` — A0 F10. They are equal today, but the map's
      // identity has to match what japa filters on, and that is the bare title.
      recorder.testStart(node.title.original, node.meta.fileName ?? null)
    },
    onTestEnd(node: JapaTestEndNode): void {
      recorder.testEnd(node.title.original, statusOf(node), node.duration)
    },
  }
}

/**
 * Installs the window hooks on a japa emitter, driving every recorder given.
 *
 * A run can have more than one thing to record. The test process has its own
 * coverage, and a suite that drives a separately started service has the service's
 * too — `cbd-a3v` in one sentence. Both are driven by the same boundaries because
 * they are the same boundaries: the service's window for a test is the interval
 * during which that test was running, and only the test runner knows where those
 * intervals begin and end.
 *
 * The recorders stay separate rather than sharing one because a `Recorder` writes
 * one shard, and a shard names the process it came from. Two processes, two shards,
 * merged later by `buildMap` — which is also what makes the merge free: both record
 * the same test titles, so the map's `indexOfTest` unions the touch sets under one
 * test rather than creating two.
 *
 * Synchronous on purpose, for the same reason the handlers are: `finish` is
 * registered here, and anything awaiting between install and the first test would
 * risk opening the first window late — a late window is missing coverage, which
 * under-selects.
 */
export function installJapaAdapter(
  emitter: JapaEmitter,
  recorders: readonly Recorder[],
  options: { correlation?: Correlator } = {},
): InstalledAdapter {
  const hooks = recorders.map((recorder) => japaWindowHooks(recorder))

  /**
   * One window per test for every recorder, and one correlation id for the
   * requests it makes.
   *
   * The id is opened before the recorders dispatch their boundaries, so a request
   * made by the first line of the test already carries it, and closed after the
   * last boundary, so a request started in the test's final tick still does.
   */
  const onTestStart = (node: JapaTestStartNode): void => {
    options.correlation?.begin(node.title.original, node.meta.fileName ?? null)
    for (const hook of hooks) hook.onTestStart(node)
  }
  const onTestEnd = (node: JapaTestEndNode): void => {
    for (const hook of hooks) hook.onTestEnd(node)
    options.correlation?.end()
  }

  let finished: Promise<void> | null = null
  const finish = (): Promise<void> => {
    if (finished !== null) return finished
    finished = (async () => {
      // Generated coordinates are fetched here, after the last test and outside
      // every window (`cbd-x2j`). A source that cannot prepare is a no-op.
      for (const recorder of recorders) {
        await recorder.runEnd()
      }
      // A synchronous source has already written everything, so these resolve
      // immediately and cost a microtask. A queued one resolves when its last
      // record reaches the sink — and an unawaited drain would leave that shard
      // without its footer, which `parseShard` refuses rather than trusts.
      //
      // Closing comes *after* the drains and never before them: a closed source
      // cannot answer, so closing early would drop the records still in flight.
      // But it does have to happen, because a socket source holds an open
      // `net.Socket` and an open socket keeps Node alive — without this the run
      // prints its summary, reports every test green, and then hangs until
      // something kills it.
      await Promise.all(recorders.map((recorder) => recorder.drained()))
      for (const recorder of recorders) recorder.close()
    })().finally(() => {
      // The HTTP patch is a process-wide side effect; leaving it in place after
      // the run would put an id on requests nobody is recording.
      options.correlation?.end()
      options.correlation?.release()
    })
    return finished
  }

  emitter.on('test:start', onTestStart as JapaListener)
  emitter.on('test:end', onTestEnd as JapaListener)
  emitter.on('runner:end', finish as JapaListener)

  return { recorders, finish }
}

// ---------------------------------------------------------------------------
// The select half
// ---------------------------------------------------------------------------

/**
 * The slice of japa's config that selection touches.
 *
 * `configure()` hydrates this once, at call time, and japa reads it back later —
 * plugins run inside `run()`, and `Planner.plan()` collects the refiner filters
 * after them. That gap is what makes setting the filter from here reliable where
 * emitting `--tests` is not (A0 F11).
 */
export interface JapaConfigLike {
  filters: { tests?: string[] }
}

/**
 * Turns a selection into the titles japa filters on.
 *
 * Indices into `map.tests`, which is where `select` leaves its answer, resolved
 * against the map's own ordering. An index with no entry is dropped rather than
 * emitted as `undefined`: a title of `undefined` would never match, and a filter
 * that silently matches nothing is a miss.
 */
export function titlesFor(selection: Selection, map: CoverageMap): string[] {
  const titles: string[] = []
  for (const index of selection.tests) {
    const entry = map.tests[index]
    if (entry !== undefined) titles.push(entry.title)
  }
  return titles
}

/**
 * Restricts the run by writing the filter into japa's config.
 *
 * **This is deliberately not done by emitting `--tests` CLI args**, which is what
 * `CBD.md` §7.1 sketched. `configure()` snapshots the parsed args when it is
 * called, so an entry point that called `processCLIArgs` second would have every
 * flag silently discarded — and the observable result is a green run with zero
 * speedup and no error, which is precisely the outcome this project exists to
 * remove. Writing `config.filters.tests` from the plugin cannot be broken by the
 * consumer's call order, and needs nothing added to their npm script.
 *
 * **An empty list means "no filter", not "no tests".** japa's
 * `Refiner#isTestTitleAllowed` returns `true` as soon as the filter is empty, so
 * an empty selection runs the *whole* suite. That is the safe direction — extra
 * tests cost time, missing ones cost correctness — but it must never be reached by
 * a caller who meant "run nothing", so this function refuses that call rather than
 * quietly turning it into the opposite.
 *
 * `groups` is left alone, and must stay that way: as soon as it is non-empty japa
 * rejects every ungrouped test in the run, and treats a group as allowed if *any*
 * test in it matches. It is a blunter instrument than a per-test list, and using
 * it would silently drop tests.
 */
export function applyTests(config: JapaConfigLike, titles: string[]): void {
  if (titles.length === 0) {
    throw new Error(
      'applyTests was given an empty title list, which japa reads as "no filter" and ' +
        'therefore runs every test. Pass the selection only when mode is "subset" and it ' +
        'selected something; an empty selection is a question for the caller, not a filter.',
    )
  }
  config.filters.tests = [...titles]
}
