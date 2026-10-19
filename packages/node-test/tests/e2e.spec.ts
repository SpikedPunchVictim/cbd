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
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const mathFile = realpathSync(join(fixture, 'src', 'math.js'))

function run(dir: string, shard: string, titles?: string[]): void {
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
  const result = spawnSync(process.execPath, ['--import', register, '--test', aFile, bFile], {
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
