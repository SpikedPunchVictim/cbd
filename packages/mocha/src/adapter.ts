/**
 * The mocha adapter: per-test coverage windows, taken from root hooks.
 *
 * Mocha is a friendlier host than japa here, in one way that changes the *output*
 * rather than just the plumbing.
 *
 * `mocha.rootHooks()` is not a special mechanism: it attaches ordinary
 * `beforeEach`/`afterEach` hooks to the ROOT suite (mocha/lib/mocha.js). Mocha
 * runs root hooks outermost, so the window they bound contains the test *and*
 * that test's own suite-level `beforeEach`/`afterEach`. japa could not give us
 * that — `group.each.setup` runs between one test's end and the next one's start,
 * so whatever it touched was unattributable and had to be filed under `@between`
 * (A3 finding 3, and the `@between` inflation that came with it). Here, setup a
 * test caused is attributed to the test that caused it, which is both tighter and
 * more honest about what the suite is doing.
 *
 * The two other differences are conveniences. `Mocha.prototype.run` is the single
 * funnel every run passes through, so one patch suffices and the consumer's test
 * files are untouched. And mocha does not call hooks it does not await, so there
 * is no analogue of A0 F1 — `takeSync()` is used anyway, because it is exact and
 * being certain costs nothing.
 *
 * The three pieces are deliberately separate: `beginShard` wants to run as early
 * as possible, `installMochaAdapter` can only run once a mocha instance exists,
 * and `statusOf` is pure and can be tested on its own.
 */
import {
  Recorder,
  type ScanOptions,
  type ShardSink,
  type Source,
  type TestStatus,
} from '@spikedpunch/cbd/adapter'
import type Mocha from 'mocha'
import { withSelfRoot } from './self.js'

/** Everything the adapter needs that it cannot work out for itself. */
export interface AdapterWiring {
  source: Source
  sink: ShardSink
  commit: string
  /**
   * The record-time filters: `prefilter` and `selfRoots` decide which scripts
   * enter the shard. Projection and include/exclude are applied by `cbd build` in
   * a v2 shard (ADR-0002), so the build needs the same rules.
   */
  scan?: ScanOptions
}

export interface InstalledAdapter {
  readonly recorder: Recorder
  /**
   * Writes the shard footer.
   *
   * Must run before the process exits. Mocha's own exit is
   * `process.exit(failures ? 1 : 0)` *inside* the callback passed to `run`, so
   * that callback is the only point guaranteed to be ahead of it — which is why
   * the footer is written here rather than from an `afterAll` hook.
   */
  finish(): Promise<void>
}

/**
 * Creates the recorder and writes the shard header.
 *
 * Called as early as possible — from `--import`, before the consumer's entry
 * point exists — for the reason the japa adapter does the same: a run that dies
 * while importing its test files should still leave evidence of how far it got,
 * rather than an empty file indistinguishable from never having started.
 *
 * It deliberately takes no window. Importing the test files *is* the `@load`
 * activity, and it has not happened yet; the load window closes at the first
 * test's start, where the Recorder captures it.
 */
export function beginShard(wiring: AdapterWiring): Recorder {
  // The adapter's own files run inside the windows it takes; exclude its package
  // from the scan at the one funnel every mocha recorder passes through (`cbd-qly`).
  const recorder = new Recorder({ ...wiring, scan: withSelfRoot(wiring.scan) })
  recorder.runStart()
  return recorder
}

/**
 * Mocha's outcome vocabulary, mapped onto the recorder's.
 *
 * Measured rather than assumed: mocha *does* run root hooks for a pending test, so
 * a skipped test arrives here with `state` undefined — indistinguishable from a
 * test that started and never finished. Both are `skipped`. That is japa's trap in
 * different clothing (A3 finding 2, where a skipped test emitted start and end with
 * `hasError: false`), and it is the reason this mapping reads the pending flag
 * first rather than trusting the state that is present.
 *
 * Amendment 5 is why it matters: a test that did not run must never be filed as one
 * that did. A skipped test reported as passing carries an empty window, which reads
 * as the confident and entirely wrong answer "no test reaches this code".
 */
export function statusOf(test: { pending?: boolean; state?: string }): TestStatus {
  if (test.pending === true) return 'skipped'
  if (test.state === 'failed') return 'failed'
  if (test.state === 'passed') return 'passed'
  return 'skipped'
}

/**
 * The hook pair, as a plain object.
 *
 * Split out from `installMochaAdapter` so the window boundaries can be exercised
 * directly, without an inspector session or a child process.
 */
export function mochaWindowHooks(recorder: Recorder): {
  beforeEach(this: Mocha.Context): void
  afterEach(this: Mocha.Context): void
} {
  return {
    beforeEach(this: Mocha.Context): void {
      const test = this.currentTest
      if (test === undefined) return
      recorder.testStart(test.fullTitle(), test.file ?? null)
    },
    afterEach(this: Mocha.Context): void {
      const test = this.currentTest
      if (test === undefined) return
      recorder.testEnd(test.fullTitle(), statusOf(test), test.duration)
    },
  }
}

/**
 * Installs the window hooks on a mocha instance.
 *
 * Synchronous on purpose: `Mocha.prototype.run` is synchronous, so anything
 * patching it must be finished before it returns.
 */
export function installMochaAdapter(mocha: Mocha, recorder: Recorder): InstalledAdapter {
  mocha.rootHooks(mochaWindowHooks(recorder))
  return {
    recorder,
    async finish() {
      // Outside every test window: transformed-script coordinates are fetched here.
      await recorder.runEnd()
    },
  }
}
