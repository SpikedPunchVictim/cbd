/**
 * The adapter against a real Vitest run.
 *
 * The setup file is the production one, built to `dist/src/setup.js` and named by
 * the fixture's config; nothing here calls the Recorder directly. What is proved is
 * the shape the core depends on: one complete shard per test file, a map whose
 * functions answer, the skipped test absent, and `CBD_SELECTION` narrowing the run.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { buildMap, testsForFunction } from '@spikedpunch/cbd'
import { parseShard } from '@spikedpunch/cbd/adapter'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const vitest = join(packageRoot, 'node_modules', '.bin', 'vitest')
const config = join(packageRoot, 'fixture', 'vitest.e2e.config.mjs')
const mathFile = realpathSync(join(packageRoot, 'fixture', 'src', 'math.mjs'))

function run(dir: string, shard: string, titles?: string[]): void {
  const env: NodeJS.ProcessEnv = { ...process.env, CBD_SHARD: shard, CBD_COMMIT: 'vitest-e2e' }
  // The package's own suite may itself be recorded; a child must not inherit that.
  delete env.CBD_SELECTION
  delete env.CBD_SOCKET_DIR
  delete env.NODE_OPTIONS
  if (titles !== undefined) {
    const selection = join(dir, 'selection.json')
    writeFileSync(selection, JSON.stringify({ titles }))
    env.CBD_SELECTION = selection
  }
  execFileSync(vitest, ['run', '--config', config], { cwd: packageRoot, env, stdio: 'pipe' })
}

const shardsIn = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.ndjson') && !name.endsWith('.service.ndjson'))
    .map((name) => join(dir, name))

function testsIn(path: string) {
  return parseShard(readFileSync(path, 'utf8'), path).filter((record) => record.type === 'test')
}

test('a run writes one complete shard per test file, and the map answers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-vitest-e2e-'))
  try {
    run(dir, join(dir, 'run.ndjson'))
    const shards = shardsIn(dir)
    assert.equal(shards.length, 2, `expected one shard per spec file, got ${shards.join(', ')}`)

    const titles = shards.flatMap((shard) => testsIn(shard).map((record) => record.title)).sort()
    assert.deepEqual(titles, ['another file also adds', 'math > adds', 'math > subtracts'])
    // A statically skipped test opens no window; one recorded as skipped would be a
    // window the map builder must drop anyway, and here it would mean the adapter
    // recorded a test that never ran.
    assert.equal(titles.includes('is skipped'), false)

    // One input per shard: script ids are per isolate, so two workers can use the
    // same id for different scripts. `buildMap` resolves each shard's table against
    // its own file, which is exactly why a shard is a separate input.
    const inputs = shards.map((shard) => ({
      name: shard,
      records: parseShard(readFileSync(shard, 'utf8'), shard),
    }))
    const map = buildMap(inputs, { commit: 'vitest-e2e' })
    assert.equal(map.tests.length, 3)
    assert.deepEqual(
      testsForFunction(map, mathFile, 'add@0').map((entry) => entry.title).sort(),
      ['another file also adds', 'math > adds'],
    )
    assert.deepEqual(
      testsForFunction(map, mathFile, 'sub@0').map((entry) => entry.title),
      ['math > subtracts'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CBD_SELECTION narrows the run; an unselected test leaves no window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-vitest-select-'))
  try {
    run(dir, join(dir, 'run.ndjson'), ['math > adds'])
    const titles = shardsIn(dir).flatMap((shard) => testsIn(shard).map((record) => record.title))
    assert.deepEqual(titles, ['math > adds'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
