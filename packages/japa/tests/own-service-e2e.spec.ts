/**
 * A service the suite starts itself, driven by japa, and recorded the same way.
 *
 * `cbd-0gw`. `service-e2e.spec.ts` proves the out-of-process path end to end for a
 * service that was already running when the suite began. What it cannot prove is anything
 * about a service the suite starts *during* the run, and that is the shape that made this a
 * task: a japa suite driving a separately started key server, with several tests that boot
 * a second server of the same code themselves and keep it alive across the boundaries that
 * follow. Measured before any of this was built (`arch/log.md`, 2026-10-17): the child is
 * instrumented, it announces itself in the same socket directory as the lane's server, and
 * it answers. Nothing was missing but a second look — the plugin opened its source once, at
 * install, and never looked again.
 *
 * So there are two services here, and every assertion needs both of them:
 *
 *   - **the lane**, started before the suite, which is what `dev-cli` does for a real lane;
 *   - **the suite's own**, started inside the first test and alive from then on.
 *
 * The four claims are separate failures, and the first is the one no run in this repository
 * has ever made:
 *
 *   - **Discovery.** A handler in the service the suite started is in the map at all. Before
 *     this work its file was not in the map, and a change to it resolved to nothing the map
 *     had seen — which escalates to every test, which is the failure the whole epic exists
 *     to remove.
 *   - **The window that started it.** The child's *start-up* — its module body, which is what
 *     writes the port it is listening on — is attributed to the test that started the
 *     process, not to the next one. That is the soundness rule in ADR-0007: a process's first
 *     take is its whole life, so it belongs to the boundary that caused the process to exist.
 *   - **The lane still works.** Finding a new service by forgetting the old one is the
 *     plausible wrong implementation, and it would leave the lane's file in the map with
 *     nothing attributed to it.
 *   - **The inverse.** A test that drove nothing holds nothing of either service, so an
 *     empty window still means "nothing was recorded" rather than "not looked at yet".
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import {
  buildMap,
  functionsInFile,
  testsForFunction,
  type CoverageMap,
  type ShardInput,
} from '@spikedpunch/cbd'
import {
  instrumentedEnv,
  pidOf,
  readServiceShard,
  readShard,
  runSuite,
  startService,
  testsIn,
  type RunningService,
} from './support/service.js'

/**
 * The two services, as paths — which is also how the map keys them. Resolved through
 * `realpathSync` because the resolver canonicalizes, and a checkout reached through a
 * symlink would otherwise key the map by a different string.
 */
const LANE = realpathSync(fileURLToPath(new URL('../../fixture/service/server.js', import.meta.url)))
const OWN = realpathSync(
  fileURLToPath(new URL('../../fixture/own-service/server.js', import.meta.url)),
)

const STARTED_IT = 'a test that starts a service of its own'
const DROVE_OWN = 'a test that drives the service the previous test started'
const DROVE_LANE = 'a test that drives the service the run was pointed at'
const INERT = 'a test that drives nothing'

/** The key `name@ordinal` the map holds for `name`, or a failure listing what it has. */
function keyOf(map: CoverageMap, file: string, name: string): string {
  const known = functionsInFile(map, file)
  const key = known.find((candidate) => candidate.startsWith(`${name}@`))
  assert.ok(
    key !== undefined,
    `the map has no ${name} in ${file}. It knows: ${known.join(', ') || '(nothing)'}`,
  )
  return key
}

function reaches(map: CoverageMap, file: string, name: string): string[] {
  return testsForFunction(map, file, keyOf(map, file, name)).map((entry) => entry.title)
}

// ---------------------------------------------------------------------------

interface Fixture {
  dir: string
  map: CoverageMap
  serviceShard: ShardInput
  /** The pid this process started the lane in, which is the one the shard must name. */
  lanePid: number
  stopLane: () => void
}

let state: Fixture | null = null

function fixture(): Fixture {
  assert.ok(state !== null, 'the group setup did not run')
  return state
}

test.group('a service the suite starts itself, driven by japa', (group) => {
  group.setup(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-own-'))
    let lane: RunningService | null = null
    try {
      // Started the way a developer starts a service, and before the suite — so that at
      // install the directory holds something, which is the contract the plugin refuses to
      // break: a run told about a service that is not there stops rather than recording a
      // map with no server side in it.
      const running = await startService(dir, LANE)
      lane = running
      const shard = join(dir, 'run.ndjson')

      const run = runSuite(
        'own-service',
        // `instrumentedEnv`, not `ambientEnv`: the suite's own service is instrumented
        // because it inherited `NODE_OPTIONS` from this process, so this process has to be
        // carrying it. Its own socket lands in the same directory, which is the lane shape.
        instrumentedEnv(dir, {
          CBD_SHARD: shard,
          CBD_FIXTURE_URL: `http://127.0.0.1:${String(running.port)}`,
        }),
      )
      assert.equal(
        run.status,
        0,
        `the recorded run did not pass.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      )

      const serviceShard = readServiceShard(shard)
      const map = buildMap([readShard('test-process', shard), serviceShard], { commit: 'e2e' })

      state = {
        dir,
        map,
        serviceShard,
        lanePid: running.proc.pid as number,
        stopLane: () => running.stop(),
      }
    } catch (error) {
      lane?.stop()
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
  })

  group.teardown(() => {
    state?.stopLane()
    if (state !== null) rmSync(state.dir, { recursive: true, force: true })
    state = null
  })

  /**
   * The claim this fixture exists for, and it is a claim about the *map* rather than about
   * the source: a handler in a service the suite started part-way through the run is
   * attributed to the test that drove it.
   *
   * The `deepEqual` is doing the work. A recorder that had read the child's whole life into
   * every later window would attribute `recordNote` to the tests after it as well, and a map
   * with the right answer plus two extra edges reads exactly like a correct one.
   */
  test('a handler in the service the suite started is attributed to the test that drove it', () => {
    const { map } = fixture()

    assert.ok(
      OWN in map.files,
      `the service the suite started is not in the map at all. It knows: ${Object.keys(map.files).join(', ')}`,
    )
    assert.deepEqual(reaches(map, OWN, 'recordNote'), [DROVE_OWN])
  })

  /**
   * And the window it is attributed to is the one that started the process.
   *
   * The child's module body is where `noting <port>` is written, so it ran while the first
   * test was open — the test that spawned it. A source that noticed the child at the *next*
   * boundary and took its whole life there would put this on the second test instead, and
   * would leave the first test recorded as touching nothing of a service it started: a
   * change to the service's file would then select the tests that drive it and not the test
   * that starts it, and they would fail for want of a server.
   */
  test("the start-up of the service is attributed to the window that started the process", () => {
    assert.deepEqual(reaches(fixture().map, OWN, '<module>'), [STARTED_IT])
  })

  /**
   * The service that was there all along is still read.
   *
   * The failure this guards is the plausible one rather than the obvious one: a source that
   * replaced its target with whatever it found most recently would pass every assertion
   * above and leave the lane's file in the map with none of its execution attributed.
   */
  test('the service the run was pointed at is still recorded', () => {
    const { map } = fixture()
    assert.deepEqual(reaches(map, LANE, 'storeKey'), [DROVE_LANE])
  })

  /**
   * The inverse map, for the service the suite started.
   *
   * `retireNote` is compiled into the child's script, is reported in every take with a count
   * of zero, and is named by no route. The file being present is what makes its absence mean
   * something: a map that had never reached the child at all would pass a weaker version of
   * the test above and fail nothing here.
   */
  test('a function in the service the suite started that nothing calls is absent', () => {
    const { map } = fixture()

    assert.equal(
      functionsInFile(map, OWN).some((key) => key.startsWith('retireNote@')),
      false,
      'a function nothing calls was attributed to a test',
    )
    for (const [bucket, refs] of Object.entries({
      load: map.load,
      between: map.between,
      teardown: map.teardown,
    })) {
      assert.equal(
        refs.some((ref) => ref[0] === OWN && ref[1].startsWith('retireNote@')),
        false,
        `the unreached function turned up in @${bucket}`,
      )
    }
  })

  /**
   * A window that drove nothing holds nothing of either service.
   *
   * This is the one that keeps the re-scan honest. Its cheap wrong version is to attach a
   * service when it appears and read its whole life into every window that follows, which
   * would put the child's start-up — and eventually its whole life — into this test as well.
   * The test process's own record is the one being read here, and it is read from the service
   * shard because that is where a test's server-side window is written.
   */
  test('a test that drives nothing holds none of either service', () => {
    const { serviceShard } = fixture()
    const record = testsIn(serviceShard).find((entry) => entry.title === INERT)
    assert.ok(record !== undefined, 'the inert test has no record in the service shard')

    for (const file of [LANE, OWN]) {
      assert.deepEqual(
        record.touches.filter((touch) => touch[0] === file),
        [],
        `${file} ran something while a test that drives nothing was in progress`,
      )
    }
  })

  /**
   * One shard, two processes, and the header names the one the run was pointed at.
   *
   * The shard's `pid` is written but read by nothing downstream (`map.ts` and `shard.ts`
   * never touch it), which is what lets several processes be recorded into one file. What
   * it must not be is the *test* process, which would credit the services' execution to the
   * process reading it and look entirely ordinary doing so — and not the child, which would
   * make the header a claim about whichever service happened to be found last.
   */
  test('the service shard names the lane rather than the child or the test process', () => {
    const { serviceShard, lanePid } = fixture()
    assert.notEqual(lanePid, process.pid, 'the fixture started its lane in this process')
    assert.equal(pidOf(serviceShard), lanePid)
  })
})
