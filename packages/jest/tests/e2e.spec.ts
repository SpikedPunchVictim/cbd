/**
 * The adapter against a real Jest run (Jest 30).
 *
 * The environment and the selection setup are the built CommonJS entries named by
 * the fixture's config; nothing here calls the Recorder directly. Asserted: one
 * complete shard per test file, the failed window present in the shard but absent
 * from the map, the skipped test absent, `@load` holding the imported module, and
 * `CBD_SELECTION` narrowing the run to one test.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { buildMap, testsForFunction } from '@spikedpunch/cbd'
import { parseShard } from '@spikedpunch/cbd/adapter'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const jest = join(packageRoot, 'node_modules', '.bin', 'jest')
const config = join(packageRoot, 'fixture', 'jest.cbd.config.cjs')
const mathFile = realpathSync(join(packageRoot, 'fixture', 'src', 'math.js'))

function run(dir: string, shard: string, titles?: string[]): void {
  const env: NodeJS.ProcessEnv = { ...process.env, CBD_SHARD: shard, CBD_COMMIT: 'jest-e2e' }
  delete env.CBD_SELECTION
  delete env.CBD_SOCKET_DIR
  delete env.NODE_OPTIONS
  if (titles !== undefined) {
    const selection = join(dir, 'selection.json')
    writeFileSync(selection, JSON.stringify({ titles }))
    env.CBD_SELECTION = selection
  }
  // The fixture deliberately has a failing test; Jest exits 1 for it.
  const result = spawnSync(jest, ['--config', config, '--runInBand'], {
    cwd: packageRoot,
    env,
    encoding: 'utf8',
  })
  assert.ok(result.status === 0 || result.status === 1, `jest failed to run:\n${result.stderr}`)
}

const shardsIn = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.ndjson') && !name.endsWith('.service.ndjson'))
    .map((name) => join(dir, name))

function recordsIn(path: string) {
  return parseShard(readFileSync(path, 'utf8'), path)
}

test('a run writes one shard per test file, and the map answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-jest-e2e-'))
  try {
    run(dir, join(dir, 'run.ndjson'))
    const shards = shardsIn(dir)
    assert.equal(shards.length, 2, `expected one shard per test file, got ${shards.join(', ')}`)

    const tests = shards.flatMap((shard) => recordsIn(shard).filter((r) => r.type === 'test'))
    assert.deepEqual(
      tests.map((entry) => [entry.title, entry.status]).sort(),
      [
        ['outer > fails', 'failed'],
        ['outer > inner > nested passes', 'passed'],
        ['outer > passes', 'passed'],
        ['rows > row a', 'passed'],
        ['rows > row b', 'passed'],
        ['second file', 'passed'],
      ].sort(),
    )
    assert.equal(tests.some((entry) => entry.title === 'outer > skipped'), false)

    const inputs = shards.map((shard) => ({ name: shard, records: recordsIn(shard) }))
    const map = buildMap(inputs, { commit: 'jest-e2e' })
    // The failed window is not trustworthy and must not reach the map.
    assert.equal(map.tests.length, 5)
    assert.deepEqual(
      testsForFunction(map, mathFile, 'add@0').map((entry) => entry.title).sort(),
      // The failing test also called `add`, but its window is not trustworthy.
      ['outer > inner > nested passes', 'outer > passes'],
    )
    assert.ok(
      map.load.some((ref) => ref[0] === mathFile),
      'the import phase was not captured in @load',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CBD_SELECTION narrows the run through Jest\'s name pattern', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-jest-select-'))
  try {
    run(dir, join(dir, 'run.ndjson'), ['outer > passes'])
    const titles = shardsIn(dir).flatMap((shard) =>
      recordsIn(shard)
        .filter((record) => record.type === 'test')
        .map((record) => record.title),
    )
    assert.deepEqual(titles, ['outer > passes'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The reason selection moved to the config: Jest's pattern sees the expanded row
// name, so `test.each` rows are selectable. A setup-file wrapper would skip them.
test('an each row can be selected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-jest-each-'))
  try {
    run(dir, join(dir, 'run.ndjson'), ['rows > row a'])
    const titles = shardsIn(dir).flatMap((shard) =>
      recordsIn(shard)
        .filter((record) => record.type === 'test')
        .map((record) => record.title),
    )
    assert.deepEqual(titles, ['rows > row a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
