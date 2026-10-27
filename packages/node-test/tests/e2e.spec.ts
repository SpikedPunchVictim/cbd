/**
 * The adapter against a real `node --test` run.
 *
 * The preload is the production one, built to `dist/src/register.js` and passed to
 * `--import`; nothing here calls the Recorder directly. Asserted: one complete
 * shard per test file, the failed window present in the shard but absent from the
 * map, statically skipped tests absent, a body-level `t.skip()` recorded as
 * skipped, `@load` holding the imported module, and `CBD_SELECTION` narrowing the
 * run through the runner's name pattern.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { realpath } from '@spikedpunch/cbd/adapter'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { buildMap, testsForFunction } from '@spikedpunch/cbd'
import { parseShard } from '@spikedpunch/cbd/adapter'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const register = pathToFileURL(join(packageRoot, 'dist', 'src', 'register.js')).href
const fixture = join(packageRoot, 'fixture')
const aFile = join(fixture, 'tests', 'a.test.mjs')
const bFile = join(fixture, 'tests', 'b.test.mjs')
const subFile = join(fixture, 'subtests', 'sub.test.mjs')
const mathFile = realpath(join(fixture, 'src', 'math.js'))

function run(dir: string, shard: string, titles?: string[], files: string[] = [aFile, bFile]): void {
  const env: NodeJS.ProcessEnv = { ...process.env, CBD_SHARD: shard, CBD_COMMIT: 'node-test-e2e' }
  // The package's own suite may itself be recorded; a child must not inherit that.
  delete env.CBD_SELECTION
  delete env.CBD_SOCKET_DIR
  delete env.NODE_OPTIONS
  delete env.NODE_TEST_CONTEXT
  if (titles !== undefined) {
    const selection = join(dir, 'selection.json')
    writeFileSync(selection, JSON.stringify({ titles }))
    env.CBD_SELECTION = selection
  }
  // The fixture deliberately has a failing test; node exits 1 for it.
  const result = spawnSync(process.execPath, ['--import', register, '--test', ...files], {
    cwd: fixture,
    env,
    encoding: 'utf8',
  })
  assert.ok(result.status === 0 || result.status === 1, `node --test failed to run:\n${result.stderr ?? ''}`)
}

const shardsIn = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.ndjson') && !name.endsWith('.service.ndjson'))
    .map((name) => join(dir, name))

function recordsIn(path: string) {
  return parseShard(readFileSync(path, 'utf8'), path)
}

test('a run writes one complete shard per test file, and the map answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-node-test-e2e-'))
  try {
    run(dir, join(dir, 'run.ndjson'))
    const shards = shardsIn(dir)
    assert.equal(shards.length, 2, `expected one shard per test file, got ${shards.join(', ')}`)

    const tests = shards.flatMap((shard) => recordsIn(shard).filter((r) => r.type === 'test'))
    assert.deepEqual(
      tests.map((entry) => [entry.title, entry.status]).sort(),
      [
        ['another file also adds', 'passed'],
        ['body skip', 'skipped'],
        ['outer > fails', 'failed'],
        ['outer > inner > nested passes', 'passed'],
        ['outer > passes', 'passed'],
      ].sort(),
    )
    // A statically skipped test reaches no hook, so it opens no window at all.
    assert.equal(tests.some((entry) => entry.title === 'outer > skipped'), false)

    const inputs = shards.map((shard) => ({ name: shard, records: recordsIn(shard) }))
    const map = buildMap(inputs, { commit: 'node-test-e2e' })
    // The failed and skipped windows are not trustworthy and must not reach the map.
    assert.equal(map.tests.length, 3)
    assert.deepEqual(
      testsForFunction(map, mathFile, 'add@0').map((entry) => entry.title).sort(),
      ['another file also adds', 'outer > passes'],
    )
    assert.deepEqual(
      testsForFunction(map, mathFile, 'sub@0').map((entry) => entry.title),
      ['outer > inner > nested passes'],
    )
    assert.ok(
      map.load.some((ref) => ref[0] === mathFile),
      'the import phase was not captured in @load',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function selectedTitles(dir: string): string[] {
  return shardsIn(dir)
    .flatMap((shard) =>
      recordsIn(shard)
        .filter((record) => record.type === 'test')
        .map((record) => record.title),
    )
    .sort()
}

test('CBD_SELECTION narrows the run through the runner\'s name pattern', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-node-test-select-'))
  try {
    run(dir, join(dir, 'run.ndjson'), ['outer > passes'])
    assert.deepEqual(selectedTitles(dir), ['outer > passes'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// node:test matches the full name with parts joined by single spaces, not CBD's
// ` > `; a nested selection exercises that translation.
test('a nested test can be selected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-node-test-nested-'))
  try {
    run(dir, join(dir, 'run.ndjson'), ['outer > inner > nested passes'])
    assert.deepEqual(selectedTitles(dir), ['outer > inner > nested passes'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A subtest opens no window of its own: what it touches belongs to its top-level
// test, and selecting that test re-runs its subtests.
test('subtests are attributed to their top-level test', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-node-test-subtests-'))
  try {
    run(dir, join(dir, 'run.ndjson'), undefined, [subFile])
    const shards = shardsIn(dir)
    assert.equal(shards.length, 1)
    const records = recordsIn(shards[0] as string)
    assert.deepEqual(
      records.filter((r) => r.type === 'test').map((r) => [r.title, r.status]).sort(),
      [
        ['parent', 'passed'],
        ['sibling', 'passed'],
      ],
    )
    const map = buildMap([{ name: shards[0] as string, records }], { commit: 'node-test-e2e' })
    assert.deepEqual(
      testsForFunction(map, mathFile, 'sub@0').map((entry) => entry.title),
      ['parent'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('selecting a test with subtests still runs its subtests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-node-test-subselect-'))
  try {
    run(dir, join(dir, 'run.ndjson'), ['parent'], [subFile])
    assert.deepEqual(selectedTitles(dir), ['parent'])
    const map = buildMap(
      shardsIn(dir).map((shard) => ({ name: shard, records: recordsIn(shard) })),
      { commit: 'node-test-e2e' },
    )
    assert.deepEqual(testsForFunction(map, mathFile, 'sub@0').map((entry) => entry.title), ['parent'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const reporter = pathToFileURL(join(packageRoot, 'dist', 'src', 'reporter.js')).href

function runGuarded(titles?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-node-test-guard-'))
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, CBD_COMMIT: 'node-test-e2e' }
    delete env.CBD_SHARD
    delete env.CBD_SELECTION
    delete env.CBD_SOCKET_DIR
    delete env.NODE_OPTIONS
    delete env.NODE_TEST_CONTEXT
    if (titles !== undefined) {
      const selection = join(dir, 'selection.json')
      writeFileSync(selection, JSON.stringify({ titles }))
      env.CBD_SELECTION = selection
    }
    // The documented command: the spec reporter keeps the normal output.
    return spawnSync(
      process.execPath,
      [
        '--import', register,
        '--test',
        '--test-reporter=spec', '--test-reporter-destination=stdout',
        `--test-reporter=${reporter}`, '--test-reporter-destination=stderr',
        bFile, subFile,
      ],
      { cwd: fixture, env, encoding: 'utf8' },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A selection of titles the suite no longer has filters out every test; node:test
// exits 0 for a run of no tests, which would read as "these tests passed".
test('a selection that matches no test fails the run', () => {
  const result = runGuarded(['no such test'])
  assert.notEqual(result.status, 0, `node --test passed having run nothing:\n${result.stderr}`)
  assert.match(result.stderr, /no test ran/)
})

test('a selection that matches a test passes the guard', () => {
  const result = runGuarded(['sibling'])
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stderr, /no test ran/)
})

test('a run without a selection passes the guard', () => {
  const result = runGuarded()
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stderr, /no test ran/)
})
