/**
 * The adapter against a real Vitest run.
 *
 * The setup file is the production one, built to `dist/src/setup.js` and named by
 * the fixture's config; nothing here calls the Recorder directly. What is proved is
 * the shape the core depends on: one complete shard per test file, a map whose
 * functions answer, the skipped test absent, and `CBD_SELECTION` narrowing the run.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { test } from '@japa/runner'
import { buildMap, testsForFunction } from '@spikedpunch/cbd'
import { parseShard } from '@spikedpunch/cbd/adapter'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const vitest = join(packageRoot, 'node_modules', '.bin', 'vitest')
const config = join(packageRoot, 'fixture', 'vitest.e2e.config.mjs')
const concurrentConfig = join(packageRoot, 'fixture', 'vitest.concurrent.config.mjs')
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
    // one.spec reads math.mjs at module scope: both tests in that file depend on
    // it, and the other spec does not.
    assert.deepEqual(
      (map.reads?.[mathFile] ?? []).map((index) => map.tests[index]?.title).sort(),
      ['math > adds', 'math > subtracts'],
    )
    // `cbd-x2j`: Vitest compiles in memory, so V8's offsets are into generated
    // text. The build must use the shard's generated line starts, not the source
    // file's; otherwise every function resolves to the file's last line.
    const add = map.files[mathFile]?.['add@0']
    assert.equal(add?.startLine, 1)
    assert.equal(add?.endLine, 1)
    const sub = map.files[mathFile]?.['sub@0']
    assert.equal(sub?.startLine, 2)
    assert.equal(sub?.endLine, 2)
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

test('a concurrent run is refused and leaves no complete shard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-vitest-concurrent-'))
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CBD_SHARD: join(dir, 'run.ndjson'),
      CBD_COMMIT: 'vitest-e2e',
    }
    delete env.CBD_SELECTION
    delete env.CBD_SOCKET_DIR
    delete env.NODE_OPTIONS

    const result = spawnSync(vitest, ['run', '--config', concurrentConfig], {
      cwd: packageRoot,
      env,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0, 'a concurrent recording must fail, not be recorded')
    assert.match(`${result.stdout}\n${result.stderr}`, /still open when the next test started/)

    // The adapter declines to finish the shard. An end record would let a build
    // accept a map whose windows overlapped, which is the failure this guard exists
    // to prevent.
    const shards = readdirSync(dir).filter((name) => name.endsWith('.ndjson'))
    for (const name of shards) {
      const text = readFileSync(join(dir, name), 'utf8')
      assert.equal(
        text.includes('"type":"end"'),
        false,
        `${name} has an end record, so an overlapping run could be built`,
      )
    }
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

// Selecting and recording are independent: `cbd select --emit-selection` hands the
// setup file a CBD_SELECTION and nothing else, and the narrowing must still happen.
test('a selection without a shard narrows the run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-vitest-select-only-'))
  const env: NodeJS.ProcessEnv = { ...process.env, CBD_COMMIT: 'vitest-e2e' }
  delete env.CBD_SHARD
  delete env.CBD_SOCKET_DIR
  delete env.NODE_OPTIONS
  try {
    const selection = join(dir, 'selection.json')
    writeFileSync(selection, JSON.stringify({ titles: ['math > adds'] }))
    env.CBD_SELECTION = selection

    const result = spawnSync(vitest, ['run', '--config', config, '--reporter=verbose'], {
      cwd: packageRoot,
      env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    // The reporter lists skipped tests too, so the count line is the answer: one
    // test ran, the rest were filtered out by the selection. CI forces colour, and
    // the escape codes sit between the words.
    const stdout = stripVTControlCharacters(result.stdout)
    assert.match(stdout, /Tests\s+1 passed \| 3 skipped/)
    assert.match(stdout, /✓ .*math > adds/)
    assert.deepEqual(shardsIn(dir), [], 'a selection-only run records nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const guardConfig = join(packageRoot, 'fixture', 'vitest.guard.config.mjs')

function runGuarded(titles?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-vitest-guard-'))
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, CBD_COMMIT: 'vitest-e2e' }
    delete env.CBD_SHARD
    delete env.CBD_SELECTION
    delete env.CBD_SOCKET_DIR
    delete env.NODE_OPTIONS
    if (titles !== undefined) {
      const selection = join(dir, 'selection.json')
      writeFileSync(selection, JSON.stringify({ titles }))
      env.CBD_SELECTION = selection
    }
    return spawnSync(vitest, ['run', '--config', guardConfig], { cwd: packageRoot, env, encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// A selection of titles the suite no longer has skips every test; Vitest exits 0 on
// an all-skipped run, which would read as "these tests passed".
test('a selection that matches no test fails the run', () => {
  const result = runGuarded(['no such test'])
  assert.notEqual(result.status, 0, `vitest passed having run nothing:\n${result.stderr}`)
  assert.match(result.stderr, /no test ran/)
})

test('a selection that matches a test passes the guard', () => {
  const result = runGuarded(['math > adds'])
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stderr, /no test ran/)
})

test('a run without a selection passes the guard', () => {
  const result = runGuarded()
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.doesNotMatch(result.stderr, /no test ran/)
})
