/**
 * A separately started service, driven by japa, recorded from two processes.
 *
 * `cbd-a3v.3.4`. Everything below this level is proven: `socketSource` satisfies the
 * `Source` contract, the plugin opens two recorders when a socket directory is set,
 * the adapter drives both from one set of boundaries, and `buildMap` unions the
 * touches of a test named twice. What none of that proves is that the pieces compose
 * into a *correct map of a real service*, because no run in this repository had ever
 * put a service, a japa suite and a map in one sentence.
 *
 * So this starts a service the way a developer starts one — one environment variable,
 * an ordinary `node`, nothing imported from CBD — runs a japa suite that drives it,
 * and builds a map from both shards. Three claims come out of it, and they are
 * different claims:
 *
 *   - **Attribution.** A server function reached by one test is attributed to that
 *     test and to no other. `storeKey` is the positive case.
 *   - **Windowing.** The *second* test's window holds only what the second test ran.
 *     A take that accumulated rather than resetting would put `storeKey` in it too.
 *     This is the one a plausible-looking wrong implementation fails, and it fails
 *     silently — an over-attributing map selects more tests, never fewer.
 *   - **The inverse.** A server function no test reaches is absent from the map,
 *     while its file is present. V8 reports unexecuted functions in every take with a
 *     call count of zero, so the control is real data being filtered rather than data
 *     that was never there.
 *
 * The suite that motivated the task — a separately started key server driven by
 * `@japa/api-client` — lives in another repository and is not this account's to
 * change, so the shape is reproduced here at the smallest size that still
 * distinguishes a correct recording from a wrong one.
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
  ambientEnv,
  pidOf,
  readServiceShard,
  readShard,
  runSuite,
  startService,
  testsIn,
  type RunningService,
} from './support/service.js'

/**
 * The service and the suite, as paths — which is also how the map keys them.
 * Resolved through `realpathSync` because the resolver canonicalizes, and a checkout
 * reached through a symlink would otherwise key the map by a different string.
 */
const SERVICE = realpathSync(fileURLToPath(new URL('../../fixture/service/server.js', import.meta.url)))
const SPEC_FILE = realpathSync(
  fileURLToPath(new URL('../../fixture/service-tests/service.spec.js', import.meta.url)),
)

const STORE = 'the key server stores a key'
const FETCH = 'the key server reads a key back'
const INERT = 'a test that drives nothing on the server'

// ---------------------------------------------------------------------------
// Reading the map
// ---------------------------------------------------------------------------

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
  port: number
  serviceOutput: string
  map: CoverageMap
  testProcess: ShardInput
  serviceShard: ShardInput
  stopService: () => void
}

let state: Fixture | null = null

function fixture(): Fixture {
  assert.ok(state !== null, 'the group setup did not run')
  return state
}

test.group('a service started on its own, driven by japa', (group) => {
  group.setup(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-service-'))
    let service: RunningService | null = null
    try {
      const running = await startService(dir, SERVICE)
      service = running
      const shard = join(dir, 'run.ndjson')

      const run = runSuite(
        'service',
        ambientEnv(dir, {
          CBD_SHARD: shard,
          CBD_FIXTURE_URL: `http://127.0.0.1:${String(running.port)}`,
        }),
      )
      assert.equal(
        run.status,
        0,
        `the recorded run did not pass.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      )

      const testProcess = readShard('test-process', shard)
      const serviceShard = readServiceShard(shard)
      const map = buildMap([testProcess, serviceShard], { commit: 'e2e' })

      // Let any stdout still in the pipe reach the handler before it is read. The
      // port is already known; this is about the assertion that the module said
      // nothing else.
      await new Promise((resolve) => setTimeout(resolve, 50))

      state = {
        dir,
        port: running.port,
        serviceOutput: running.output(),
        map,
        testProcess,
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
   * Two processes, two shards, and a map that needs both.
   *
   * The evidence that each shard contributed is a *file* only it could have seen.
   * The test process never loads the service's source; the service never loads the
   * spec file. A map with both files in it had both halves, and the differing pids
   * in the two headers say they came from two processes rather than from one run
   * written twice.
   */
  test('the map joins two shards, and neither could have been answered alone', () => {
    const { map, testProcess, serviceShard } = fixture()

    assert.deepEqual(map.shards, ['test-process', 'service'])
    assert.ok(
      SERVICE in map.files,
      `the service's own coverage is missing. The map knows: ${Object.keys(map.files).join(', ')}`,
    )
    assert.ok(
      SPEC_FILE in map.files,
      `the suite's own coverage is missing. The map knows: ${Object.keys(map.files).join(', ')}`,
    )

    const testPid = pidOf(testProcess)
    const servicePid = pidOf(serviceShard)
    assert.notEqual(testPid, servicePid, 'two shards claiming one pid are not two processes')
  })

  // The claim the whole out-of-process path exists for: code that ran in the service
  // while one test was driving it is attributed to that test.
  test('a server function is attributed to the one test that reached it', () => {
    assert.deepEqual(reaches(fixture().map, SERVICE, 'storeKey'), [STORE])
  })

  /**
   * And the claim that separates a window from a running total.
   *
   * `fetchKey` ran while the second test was driving the service, so it belongs to
   * the second test. What makes the assertion worth making is the *first* test: a take
   * that returned cumulative coverage would carry `storeKey` into every later window,
   * and the map would then attribute it to this test as well. The single-element
   * `deepEqual` fails on exactly that, and on nothing else.
   */
  test('the second window holds only what the second test ran', () => {
    const { map } = fixture()
    assert.deepEqual(reaches(map, SERVICE, 'fetchKey'), [FETCH])
    assert.deepEqual(reaches(map, SERVICE, 'storeKey'), [STORE])
  })

  /**
   * The inverse map, at the scale of one file.
   *
   * `rotateMasterKey` is in the service's source, is compiled into every script, and
   * is named by no handler — so V8 reports it in every take with a call count of zero
   * and the recorder's `executed` filter is the only thing keeping it out. The file
   * being present is what makes its absence mean something: a map that had never
   * seen the service at all would pass a weaker version of this test.
   */
  test('a function no test reaches is absent, though its file is known', () => {
    const { map } = fixture()

    assert.ok(map.seen.includes(SERVICE), 'the service file must be known to the map')
    assert.equal(
      functionsInFile(map, SERVICE).some((key) => key.startsWith('rotateMasterKey@')),
      false,
      'a function nothing calls was attributed to a test',
    )

    // Not in a test window, and not excused into a bucket either: `@load` and
    // `@between` are not "no test reaches this", they are "unattributable", and a
    // file parked there escalates to the whole suite.
    for (const [bucket, refs] of Object.entries({
      load: map.load,
      between: map.between,
      teardown: map.teardown,
    })) {
      assert.equal(
        refs.some((ref) => ref[0] === SERVICE && ref[1].startsWith('rotateMasterKey@')),
        false,
        `the unreached function turned up in @${bucket}`,
      )
    }
  })

  /**
   * A test that drove nothing gets a window with nothing of the service's in it,
   * rather than no window at all.
   *
   * The difference is load-bearing downstream: an absent record and a record with no
   * touches both say "this test reaches nothing here", but only the record says the
   * test *ran*. Dropping it would make a test that never executed look the same as one
   * that executed and reached nothing.
   *
   * **The window is not literally empty, and the assertion says so on purpose.** The
   * instrument module's own code is what serves each take, so it runs inside every
   * window it closes and every service window carries a fixed handful of CBD's own
   * functions. That is a defect of its own — a map whose entries are mostly the tool's
   * implementation — and it is visible only while CBD is workspace-linked, because a
   * published copy resolves under `node_modules` and the default prefilter drops it.
   * It is filed rather than absorbed. What this test pins is the part that belongs to
   * this task: none of the *service's* work fell into a window that did none.
   */
  test('a test that drives nothing is recorded with a window holding none of the service', () => {
    const record = testsIn(fixture().serviceShard).find((entry) => entry.title === INERT)
    assert.ok(record !== undefined, 'the inert test has no record in the service shard')
    assert.deepEqual(
      record.touches.filter((touch) => touch[0] === SERVICE),
      [],
      'the service ran something while a test that drives nothing was in progress',
    )
  })

  /**
   * The instrument module is a guest in someone else's process (ADR-0005), so the
   * service's output is the service's. Started through `NODE_OPTIONS` — a route core's
   * own specs do not cover, since they pass `--import` on the command line — the
   * announcement must be the only thing on stdout.
   */
  test('the service announced its port, and the module said nothing', () => {
    const { serviceOutput, port } = fixture()
    assert.equal(serviceOutput, `listening ${String(port)}\n`)
  })
})
