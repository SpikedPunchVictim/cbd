/**
 * A service started from a copy of its build: recorded, merged, and selected.
 *
 * `cbd-jmn`. `packages/core/tests/relocate.spec.ts` pins the rule and the key it
 * produces, one script at a time and with no socket in sight. This pins what the rule
 * is *for*: a service running from a copy, driven by a real japa suite, recorded by two
 * processes, merged by `buildMap`, and asked the question a repository diff asks.
 *
 * **The defect is a test here, not a comment.** The lane recorded with no relocation
 * rule is the run that under-selects, and the assertion names the damage: a change to
 * the checked-in `src/handler.ts` selects the one test that ran it in this process,
 * while two others reached the same function over HTTP in the copy. The two sets are
 * disjoint, so the answer is not "smaller" — it is wrong, and it looks complete. That
 * is the shape measured on grizzly key-server's `CreateEncrypt.ts`: 3 tests at the
 * checkout path, 2 different ones under the lane, overlap empty.
 *
 * **Both lanes are real runs against real services, and they cannot share one.** The
 * instrument serves its script table as a delta since the last take, so a second
 * recorded run against an already-taken service would see coverage it could no longer
 * map back — a second lane over the same service would be measuring the fixture's
 * plumbing rather than the rule.
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { buildMap, select, type Change, type CoverageMap, type ShardInput } from '@spikedpunch/cbd'
import { titlesFor } from '../src/adapter.js'
import {
  ambientEnv,
  bucketsHolding,
  changeTo,
  readServiceShard,
  readShard,
  runSuite,
  startService,
  type RunningService,
} from './support/service.js'

/**
 * The checkout: where the fixture's code lives, which is what a repository diff would
 * name. Through `realpathSync` for the reason the other fixtures give — the resolver
 * canonicalizes, so a directory reached through a symlink would be keyed by a
 * different string and every assertion below would be about the link, not the rule.
 */
const DEPLOYED = realpathSync(fileURLToPath(new URL('../../fixture/deployed', import.meta.url)))
const HANDLER = join(DEPLOYED, 'src/handler.ts')
const SERVER = join(DEPLOYED, 'src/server.ts')

/** The fixture suite's titles, quoted here because several assertions turn on which. */
const IN_PROCESS = 'the handler is called in this process'
const STORES = 'the deployed service stores a key'
const FETCHES = 'the deployed service reads a key back'

/**
 * The line a needle is on, 1-based, read from the file rather than written here.
 *
 * Not fussiness: a hunk that quietly stopped intersecting the function it names would
 * turn a function-level question into a file-level one — a weaker question with a
 * bigger answer — and the test would go on passing.
 */
function lineOf(source: string, needle: string): number {
  const index = readFileSync(source, 'utf8')
    .split('\n')
    .findIndex((line) => line.includes(needle))
  assert.ok(index !== -1, `${source} has no line containing ${needle}`)
  return index + 1
}

function changeAt(path: string, line: number): Change {
  return { path, status: 'M', hunks: [{ start: line, end: line }] }
}

interface Lane {
  /** The staged root the service ran from — grizzly's `.grizzly-dev/<lane>`. */
  stage: string
  map: CoverageMap
  testShard: ShardInput
  serviceShard: ShardInput
  stop: () => void
}

/**
 * Copies the fixture's `src/` and `dist/` under a staging root and runs the suite
 * against a service started from the copy.
 *
 * `src/` is copied because a deployment copies the tree, and because the copy's map
 * resolves into it: without it, the staged `dist/handler.js` would name a file that
 * does not exist, and every question below would be about a missing file rather than
 * about a coordinate system.
 */
async function recordLane(relocate: boolean): Promise<Lane> {
  assert.ok(
    existsSync(join(DEPLOYED, 'dist/server.js')),
    'the deployed fixture is not built: run `pnpm --filter @spikedpunch/cbd-japa build`',
  )

  // Realpath'd before anything is copied, so the only alias in play is the staging
  // root this function makes. On macOS `tmpdir()` sits behind a symlink, and a rule
  // spelled the symlinked way would match nothing at all.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'cbd-japa-deployed-')))
  const stage = join(base, 'stage')
  let service: RunningService | null = null

  try {
    cpSync(join(DEPLOYED, 'src'), join(stage, 'src'), { recursive: true })
    cpSync(join(DEPLOYED, 'dist'), join(stage, 'dist'), { recursive: true })

    const running = await startService(base, join(stage, 'dist/server.js'))
    service = running

    const shard = join(base, 'run.ndjson')
    const run = runSuite(
      'deployed',
      ambientEnv(base, {
        CBD_SHARD: shard,
        CBD_FIXTURE_URL: `http://127.0.0.1:${String(running.port)}`,
        // The knob under test, and the only difference between the two lanes. It is
        // read by the TEST process and not by the service, and rightly: that is where
        // the recorder and the map live, and it is the process that has the checkout.
        ...(relocate ? { CBD_RELOCATE_FROM: stage, CBD_RELOCATE_TO: DEPLOYED } : {}),
      }),
    )
    assert.equal(
      run.status,
      0,
      `the recorded run did not pass.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
    )

    const testShard = readShard('test-process', shard)
    const serviceShard = readServiceShard(shard)
    return {
      stage,
      testShard,
      serviceShard,
      // Resolution is the build's job in v2, so the rule under test goes here.
      map: buildMap([testShard, serviceShard], {
        commit: 'e2e',
        ...(relocate ? { scan: { relocate: [{ from: stage, to: DEPLOYED }] } } : {}),
      }),
      stop: () => {
        running.stop()
        rmSync(base, { recursive: true, force: true })
      },
    }
  } catch (error) {
    service?.stop()
    rmSync(base, { recursive: true, force: true })
    throw error
  }
}

const lanes = new Map<string, Promise<Lane>>()

/**
 * A lane, started once and shared by the tests that need it.
 *
 * Started on first use rather than in the group setup, because a service plus a suite
 * run is a second or two and two of them in one setup would be a timeout waiting to
 * happen — while a test waiting for one is well inside the budget it declares itself.
 */
function lane(relocate: boolean): Promise<Lane> {
  const key = relocate ? 'relocated' : 'unrelocated'
  let pending = lanes.get(key)
  if (pending === undefined) {
    pending = recordLane(relocate)
    lanes.set(key, pending)
  }
  return pending
}

/** Every fixture test needs a real run behind it, so every one declares the budget. */
const LANE_MS = 30_000

test.group('a service running from a copy of its build', (group) => {
  group.teardown(async () => {
    for (const pending of lanes.values()) {
      // A lane that failed to start has already cleaned up after itself; swallowing
      // the rejection here keeps a failed test from also failing the teardown that
      // would have explained it.
      const running = await pending.catch(() => null)
      running?.stop()
    }
    lanes.clear()
  })

  /**
   * The defect, at the level the issue measured it: the map holds two entries for one
   * logical file, and each holds only the tests that reached it by one route.
   */
  test('a copy with no rule keys one file twice', async () => {
    const { map, stage, testShard, serviceShard } = await lane(false)
    const staged = join(stage, 'src/handler.ts')

    assert.deepEqual(
      Object.keys(map.files)
        .filter((file) => file.endsWith('/handler.ts'))
        .sort(),
      [HANDLER, staged].sort(),
      'one logical file, two map entries — this is the defect, and it is what the rule removes',
    )

    assert.deepEqual(
      bucketsHolding(testShard, HANDLER),
      ['@load', `test: ${IN_PROCESS}`],
      'the checkout path holds what this process ran, and nothing else can reach it',
    )
    assert.deepEqual(
      bucketsHolding(serviceShard, staged),
      ['@load', `test: ${STORES}`, `test: ${FETCHES}`],
      'the copy holds what the service ran, at a path no repository diff can produce',
    )
  }).timeout(LANE_MS)

  /**
   * What that costs, which is why the issue is a P0. Not "fewer tests" — *wrong* ones,
   * with the omitted tests invisible in the answer.
   */
  test('a diff on the checked-in path under-selects, and looks complete doing it', async () => {
    const { map } = await lane(false)
    const selection = select(map, [changeAt(HANDLER, lineOf(HANDLER, 'export function storeKey'))], {}, {})

    assert.equal(selection.mode, 'subset', 'nothing about this change is unattributable')
    assert.deepEqual(
      titlesFor(selection, map),
      [IN_PROCESS],
      'the selector answered from one of the map\'s two entries for this file. The other ' +
        `holds "${STORES}" and "${FETCHES}", which reach the same function over HTTP in the ` +
        'copy — disjoint from this one, so the answer is not smaller, it is incomplete',
    )
  }).timeout(LANE_MS)

  /**
   * The other half of the damage, and the opposite failure: a file the map has never
   * seen escalates to the whole suite. 269 of the lane's files were this.
   */
  test('a diff on a file only the copy runs escalates to the whole suite', async () => {
    const { map } = await lane(false)
    const selection = select(map, [changeTo(SERVER)], {}, {})

    assert.equal(selection.mode, 'all', 'the checkout path for this file is not in the map')
    assert.deepEqual(selection.reasons, [{ kind: 'all', why: 'unknown-file', file: SERVER }])
  }).timeout(LANE_MS)

  /**
   * The fix, at the level the map is read: one entry, holding every test that reached
   * the function, whichever process ran it and whichever tree it ran in.
   */
  test('a rule makes one entry of it, holding both tests that reached the function', async () => {
    const { map, stage } = await lane(true)

    assert.deepEqual(
      Object.keys(map.files).filter((file) => file.endsWith('/handler.ts')),
      [HANDLER],
      "the copy's path and the checkout's path are one entry, not two",
    )
    assert.deepEqual(
      map.seen.filter((file) => file.startsWith(stage)),
      [],
      'a staged path survived into the map, so a diff can still name a file that is not there',
    )

    const functions = map.files[HANDLER]
    assert.ok(functions !== undefined)
    const store = functions['storeKey@0']
    assert.ok(store !== undefined, 'storeKey was not attributed to the checkout path')
    assert.deepEqual(
      store.tests.map((index) => map.tests[index]?.title ?? '<missing>').sort(),
      [IN_PROCESS, STORES].sort(),
      'one test ran this function in this process and one ran it over HTTP in the copy; ' +
        'the map holds both, and that union is the whole point of the fix',
    )

    // The control. `rotateMasterKey` is never called, so it is in no window, and a
    // pipeline that had lost its "did it actually run?" filter would show it here with
    // the whole file's tests — which reads exactly like a correct map.
    assert.ok(
      Object.keys(functions).every((key) => !key.startsWith('rotateMasterKey')),
      'a function nothing called is in no test\'s window',
    )
  }).timeout(LANE_MS)

  test('a diff on a function reached both ways selects both tests', async () => {
    const { map } = await lane(true)
    const titles = titlesFor(
      select(map, [changeAt(HANDLER, lineOf(HANDLER, 'export function storeKey'))], {}, {}),
      map,
    )

    assert.deepEqual(titles.slice().sort(), [IN_PROCESS, STORES].sort())
    assert.ok(
      !titles.includes(FETCHES),
      'that test fetched a different function, so it is what keeps a filter that selected ' +
        'everything from passing this by luck',
    )
  }).timeout(LANE_MS)

  test('a diff on a file only the copy runs answers with a path a diff can name', async () => {
    const { map } = await lane(true)
    const selection = select(map, [changeTo(SERVER)], {}, {})

    assert.equal(selection.mode, 'subset', 'the whole suite was escalated for one changed route')
    assert.deepEqual(titlesFor(selection, map).slice().sort(), [STORES, FETCHES].sort())
  }).timeout(LANE_MS)

  /**
   * The relocated path is a real path in the repository, and it is the one the map
   * files the copy's *start-up* under — the copy's entry point is imported, so this is
   * the bucket a file reached only by being loaded lands in.
   *
   * `@between` is the residual the whole design is measured on: a file reached only
   * outside every window escalates to every test, so it must not appear here at all.
   * The assertion is written against the fixture's files rather than against the bucket
   * being empty, because CBD's own instrument module does run inside every window it
   * closes — a separate defect, filed as `cbd-qly`.
   */
  test('the copy\'s entry point is filed at a path the repository has', async () => {
    const { map } = await lane(true)

    assert.ok(
      map.load.some((ref) => ref[0] === SERVER),
      'the service imported its entry point at start-up, so the map must have seen it — ' +
        'at the checkout path, which is the path the rule put it on',
    )
    for (const file of [HANDLER, SERVER]) {
      assert.ok(
        !map.between.some((ref) => ref[0] === file),
        `${file} was reached by @between, so a change to it would escalate to every test`,
      )
    }
  }).timeout(LANE_MS)
})
