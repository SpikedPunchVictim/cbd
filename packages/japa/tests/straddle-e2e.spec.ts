/**
 * What becomes of server work that is still to come when a test's window closes.
 *
 * `cbd-a3v.3.5`. The task was written to measure two things before deciding whether the
 * boundary needs tightening or the `@between` policy needs loosening: how far the socket
 * hop moves a window boundary, and how much of the server's execution ends up in
 * `@between` as a result. The direction is the whole reason it matters — work done near
 * a boundary lands in the wrong window, a file reached only by `@between` escalates to
 * every test (§8.3 rule 9), and that raises P(all), the one number Gate B is measured on.
 *
 * Three claims come out of this run, and they are different claims.
 *
 *   - **The boundary is placed, and the run says how precisely.** Drift is
 *     dispatch-to-receipt, counted for every window, and it is in the shard footer rather
 *     than in a caller's memory — so it is a property of the record and any run can be
 *     read for it.
 *   - **Leftover work is attributed by when it ran, not by which test caused it.** The
 *     service answers, then keeps working; the test that asked for that work is over.
 *     Where it lands is decided by which window happens to be open, and here that is a
 *     test that drove nothing at all.
 *   - **The residual in `@between` is what it is, and not what it is feared to be.**
 *     Measured rather than assumed, and the number is not the alarming one.
 *
 * The fixture's delay is chosen, not stumbled into: the work is released some 250ms after
 * the response, which is past the end of the causing test's window and comfortably inside
 * the long idle test that follows. A landing point decided by a race would be a
 * measurement of the machine rather than of the design.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { CBD_SELF_ROOTS } from '@spikedpunch/cbd/adapter'
import {
  buildMap,
  select,
  type CoverageMap,
  type ShardFooter,
  type ShardInput,
} from '@spikedpunch/cbd'
import { JAPA_SELF_ROOTS } from '../src/self.js'
import {
  ambientEnv,
  bucketFiles,
  bucketsHolding,
  changeTo,
  readServiceShard,
  readShard,
  runSuite,
  startService,
  type RunningService,
} from './support/service.js'

/**
 * The fixture's two files, as paths — which is also how the map keys them. Resolved
 * through `realpathSync` because the resolver canonicalizes, and a checkout reached
 * through a symlink would otherwise key the map by a different string.
 */
const SERVICE = realpathSync(
  fileURLToPath(new URL('../../fixture/straddle/server.js', import.meta.url)),
)
const SWEEPER = realpathSync(
  fileURLToPath(new URL('../../fixture/straddle/sweeper.js', import.meta.url)),
)

const CAUSE = 'a test that leaves the server working'
const INNOCENT = 'a test that drives nothing after, but takes a while about it'

function footerOf(shard: ShardInput): ShardFooter {
  const last = shard.records.at(-1)
  assert.equal(last?.type, 'end')
  return last as ShardFooter
}

interface Fixture {
  dir: string
  map: CoverageMap
  testShard: ShardInput
  serviceShard: ShardInput
  stopService: () => void
}

let state: Fixture | null = null

function fixture(): Fixture {
  assert.ok(state !== null, 'the group setup did not run')
  return state
}

test.group('a service that keeps working after it answers', (group) => {
  group.setup(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-straddle-'))
    let service: RunningService | null = null
    try {
      const running = await startService(dir, SERVICE)
      service = running
      const shard = join(dir, 'run.ndjson')

      const run = runSuite(
        'straddle',
        ambientEnv(dir, {
          CBD_SHARD: shard,
          CBD_FIXTURE_URL: `http://127.0.0.1:${String(running.port)}`,
          // This fixture exists to measure the *time-based* boundary: how far a
          // socket hop moves it, and where the work it cannot attribute lands. With
          // correlation on, every request adds a take of its own and the drift
          // number measures correlation's cost instead. The request-id path is
          // measured by `e2e/`, where a window tagged with the sending test is the
          // assertion rather than a confound.
          CBD_CORRELATION: 'off',
        }),
      )
      assert.equal(
        run.status,
        0,
        `the recorded run did not pass.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      )

      const testShard = readShard('test-process', shard)
      const serviceShard = readServiceShard(shard)
      state = {
        dir,
        map: buildMap([testShard, serviceShard], { commit: 'e2e' }),
        testShard,
        serviceShard,
        stopService: () => running.stop(),
      }
    } catch (error) {
      service?.stop()
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
  })

  group.teardown(() => {
    state?.stopService()
    if (state !== null) rmSync(state.dir, { recursive: true, force: true })
    state = null
  })

  /**
   * The measurement itself, and the completeness of it.
   *
   * `windows` is checked against the shard rather than against a number written here:
   * every record between the header and the footer was produced by exactly one
   * boundary, so a drift that names fewer windows than that is a drift that was read too
   * early — which is precisely what reading it in `runEnd` would have done, and would
   * have done silently, short by the teardown boundary the footer is written behind.
   *
   * `meanUs < minGapUs` is the design's validity condition rather than a target. A
   * boundary has to land before the next one is sent, or the windows stop being the ones
   * the runner asked for. It is the assertion that turns "the socket hop is fast enough"
   * from a belief into something a run can be wrong about.
   *
   * **The mean, not the max, and the max is still reported.** Measured on the same
   * machine, the pre-existing baseline records occasional `maxUs` spikes of 3-12 ms at
   * window 4 and later — a descheduled event loop, not a sliding window — while the
   * mean stays in the hundreds of microseconds. Gating on the max made this test fail
   * roughly half the time under load, on code unrelated to the measurement. The
   * footer still carries `maxUs` for a human reading the run, and the mean is what
   * says whether the boundaries are where the runner asked for them.
   */
  test('the run reports its boundary drift, for every window it took', () => {
    const { serviceShard } = fixture()
    const footer = footerOf(serviceShard)
    const drift = footer.drift

    assert.ok(drift !== undefined, 'a queued source recorded no drift at all')

    // Every test start (a bucket boundary) and every test end is a take, and the
    // run takes one more for teardown: `2n + 1`. The shard holds *records*, and an
    // empty bucket is not one — `@load` is the exception that always has content,
    // and once CBD's own code is excluded (`cbd-qly`) `@between` and `@teardown`
    // are empty here. So the count to check drift against is the takes, not the
    // records; comparing to records was only ever true because the tool wrote
    // itself into the empty buckets.
    const boundaries = 2 * footer.tests + 1
    assert.equal(
      drift.windows,
      boundaries,
      'the footer counted a different number of windows than the recorder took',
    )
    // Table rows are not boundaries; only a window is. (`script`/`function` rows
    // are written once per distinct item, whenever the first window reports it.)
    const records = serviceShard.records.filter(
      (record) =>
        record.type === 'test' ||
        record.type === 'load' ||
        record.type === 'between' ||
        record.type === 'teardown',
    ).length
    assert.ok(records <= boundaries, 'a bucket with no touches cannot produce a record')

    assert.ok(drift.meanUs > 0, 'a boundary cannot land in no time at all')
    assert.ok(drift.meanUs <= drift.maxUs)
    assert.ok(
      drift.meanUs < drift.minGapUs,
      `boundaries landed ${String(drift.meanUs)}µs late on average, against boundaries only ` +
        `${String(drift.minGapUs)}µs apart — the windows are sliding`,
    )
  })

  // The other half of the same fact: a source that answers in the tick it was asked has
  // no boundary to miss, so its shard carries no drift. Recording a zero there would say
  // "measured, and it was perfect" where the truth is "not applicable".
  // `cbd-qly`, from the service side. The instrument module serves every take, so
  // it is the code most likely to appear in every window; a workspace link is the
  // install shape the node_modules prefilter does not cover.
  test("the service shard contains none of the tool's own files", () => {
    const { serviceShard } = fixture()
    // A v2 shard names files once, in its script table.
    const roots = [...CBD_SELF_ROOTS, ...JAPA_SELF_ROOTS]
    const own: unknown[] = []
    for (const record of serviceShard.records) {
      if (record.type !== 'script') continue
      const file = fileURLToPath(record.url)
      if (roots.some((root) => file === root || file.startsWith(`${root}/`))) own.push(record)
    }
    assert.deepEqual(own, [], 'the instrument module must not be recorded as the service under test')
  })

  test('the test process, taking in its own tick, reports no drift', () => {
    assert.equal(footerOf(fixture().testShard).drift, undefined)
  })

  /**
   * The claim the whole task turns on: attribution is by time, not by cause.
   *
   * `sweep` was called because of the request the causing test made, and by the time it
   * ran that test was over. It lands in whatever window is open — here, the window of a
   * test that drove nothing at all. Nothing about the map records that provenance, and
   * nothing could: the service is a different process and the runner has no idea any of
   * it happened.
   *
   * `@load` is the control. `sweeper.js` is imported lazily, on the cold path, so its
   * module body runs when the leftover work runs and cannot be in `@load` — which is also
   * what makes a file reached by *nothing but* leftover work constructible at all.
   */
  test('work the server did after answering one test belongs to whichever window was open', () => {
    const { serviceShard } = fixture()
    const landing = bucketsHolding(serviceShard, SWEEPER)

    assert.deepEqual(
      landing,
      [`test: ${INNOCENT}`],
      'the left-over work is attributed by when it ran, not by which test caused it. If ' +
        'this moved, the runner\'s timings have changed and the fixture needs re-tuning: ' +
        `it saw ${JSON.stringify(landing)}`,
    )

    // The control, from the same run: the causing test did drive the service, and the
    // work it left behind is not among what it is credited with.
    assert.deepEqual(bucketFiles(serviceShard, SWEEPER)[`test: ${CAUSE}`], [])
  })

  /**
   * And what that costs. A file the map reaches only through work that landed in a test's
   * window is answered by *that* test — so a change to a file only the causing test
   * exercises selects the innocent one. Over-selection, which is the direction this
   * project accepts, and the reason the fixture was built: it is the price of attribution
   * by time.
   */
  test('a change to a file only the leftover work touched selects the test that was merely open', () => {
    const { map } = fixture()
    const selection = select(map, [changeTo(SWEEPER)], {}, {})

    assert.equal(selection.mode, 'subset', 'nothing about this change is unattributable')
    assert.deepEqual(
      selection.tests.map((index) => map.tests[index]?.title),
      [INNOCENT],
      'the file is answered by the window that held it, and that is the whole story',
    )
  })

  /**
   * The residual, which is the number the decision is made on.
   *
   * Of everything the service executed during the run — the request handlers, the module
   * bodies, the leftover sweep — none of it landed in `@between`. That is the measured
   * answer to "how much of the server's execution bleeds into the bucket?", and it is zero
   * here not by luck but by arithmetic: `@between` is the runner's inter-test gap, tens of
   * milliseconds wide at most, while a test's window is open far longer, so leftover work
   * released on any timer lands in a window.
   *
   * It used to be that `@between` was not empty: CBD's own instrument module ran inside
   * every window it closed (`cbd-qly`). That is fixed, so `@between` is empty here — the
   * emptiness is now the result rather than the thing being avoided, and the non-vacuity
   * guard is `map.seen` below: both files ran, just not in that bucket.
   */
  test('none of the service\x27s execution landed in @between', () => {
    const { map, serviceShard } = fixture()

    for (const file of [SERVICE, SWEEPER]) {
      assert.ok(
        !map.between.some((ref) => ref[0] === file),
        `${file} was reached by @between, so a change to it would escalate to every test`,
      )
    }

    // The denominator, so that "none of it" means something: the run did execute both
    // files, and the buckets above are not empty because nothing ran.
    assert.ok(map.seen.includes(SWEEPER), 'the sweeper never ran, so the residual is vacuous')
    assert.ok(map.seen.includes(SERVICE))
  })
})
