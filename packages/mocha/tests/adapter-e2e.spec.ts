/**
 * The adapter against a real mocha run, in a child process, reached the way a
 * consumer reaches it: `NODE_OPTIONS="--import …/auto.js"` and nothing else.
 *
 * Nothing here calls the adapter directly. The point is that a plain
 * `mocha spec/calc.spec.js` — no plugin, no config, no change to the spec — comes
 * out the other side as per-test windows, which is the whole seam the project is
 * built on. That is what makes "the developer runs tests like they usually do"
 * true rather than aspirational.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { buildMap } from '@spikedpunch/cbd'
import { parseShard, resolveShard, summarizeShard, type ScanOptions } from '@spikedpunch/cbd/adapter'
import { statusOf } from '../src/adapter.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const autoEntry = join(packageRoot, 'dist/src/auto.js')

/**
 * Source and output are byte-identical, which is what makes projection's 1:1
 * assumption *true* here rather than assumed. The generated file carries no
 * sourceMappingURL, so this is the `out-nomaps` shape: projection is the only
 * resolver that can answer, and the answer is exact.
 */
const CALC = [
  'export function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'export function sub(a, b) {',
  '  return a - b;',
  '}',
  '',
].join('\n')

const SPEC = [
  "import { add, sub } from '../out/src/calc.js'",
  '',
  "describe('calc', () => {",
  "  it('adds two numbers', () => {",
  "    if (add(1, 2) !== 3) throw new Error('add is wrong')",
  '  })',
  '',
  "  it('subtracts two numbers', () => {",
  "    if (sub(5, 2) !== 3) throw new Error('sub is wrong')",
  '  })',
  '',
  "  it('is skipped', function () {",
  '    this.skip()',
  '  })',
  '})',
  '',
].join('\n')

function makeProject(): { root: string; cleanup: () => void } {
  // Deliberately the *unresolved* `tmpdir()` path. Node canonicalizes script URLs
  // through symlinks — on macOS this is `/var/...` whose realpath is
  // `/private/var/...` — so configuring the projection with what `tmpdir()` returns
  // is exactly how a user would get it wrong, and it used to drop every script and
  // empty the map with no error. `canonicalProjectionRules` is what makes this work;
  // `projection.spec.ts` holds the hermetic version with a symlink it creates itself.
  const root = mkdtempSync(join(tmpdir(), 'cbd-mocha-project-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'out/src'), { recursive: true })
  mkdirSync(join(root, 'spec'), { recursive: true })
  writeFileSync(join(root, 'src/calc.ts'), CALC)
  writeFileSync(join(root, 'out/src/calc.js'), CALC)
  writeFileSync(join(root, 'spec/calc.spec.js'), SPEC)
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/**
 * Runs mocha the way a consumer does, with an optional shard and extra environment.
 *
 * `CBD_SHARD` and `CBD_SELECTION` are deleted from the inherited environment
 * first: under `cbd collect` this test process has both, and a child that inherits
 * them would write into its parent's shard.
 */
function runMochaResult(
  root: string,
  shardPath: string | null,
  extra: NodeJS.ProcessEnv = {},
  args: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const require = createRequire(join(packageRoot, 'package.json'))
  const mochaBin = require.resolve('mocha/bin/mocha.js')
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.CBD_SHARD
  delete env.CBD_SELECTION
  env.NODE_OPTIONS = `--import ${pathToFileURL(autoEntry).href}`
  env.CBD_COMMIT = 'mini-head'
  env.CBD_PROJECTION_FROM = join(root, 'out')
  env.CBD_PROJECTION_TO = root
  env.CBD_INCLUDE = join(root, 'src')
  env.CBD_MOCHA_ROOT = packageRoot
  if (shardPath !== null) env.CBD_SHARD = shardPath
  Object.assign(env, extra)

  const argv = [mochaBin, '--exit', join(root, 'spec/calc.spec.js'), ...args]
  const result = spawnSync(process.execPath, argv, { cwd: packageRoot, env, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function runMocha(
  root: string,
  shardPath: string | null,
  extra: NodeJS.ProcessEnv = {},
  args: string[] = [],
): string {
  const result = runMochaResult(root, shardPath, extra, args)
  if (result.status !== 0) {
    throw new Error(`mocha run failed: status ${String(result.status)}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

// Amendment 5, at its narrowest. A skipped test emits an end event in japa with
// hasError false and is indistinguishable from a pass unless `isSkipped` is read;
// mocha reports the same thing as an undefined state. Either way the test did not
// run, so it must never be recorded as one that did — a passing test with an empty
// window is an assertion that no test reaches that code.
test('an outcome that did not happen is never recorded as a pass', () => {
  assert.equal(statusOf({ pending: true, state: undefined }), 'skipped')
  assert.equal(statusOf({ state: undefined }), 'skipped')
  assert.equal(statusOf({ state: 'passed' }), 'passed')
  assert.equal(statusOf({ state: 'failed' }), 'failed')
})

test('a plain mocha run, with only --import added, yields per-test windows', () => {
  const project = makeProject()
  const dir = mkdtempSync(join(tmpdir(), 'cbd-mocha-shard-'))
  try {
    const shardPath = join(dir, 'shard.jsonl')
    runMocha(project.root, shardPath)

    const records = parseShard(readFileSync(shardPath, 'utf8'), shardPath)
    const summary = summarizeShard(records)
    assert.equal(summary.header.commit, 'mini-head')

    // A v2 shard holds byte ranges; the *.js -> *.ts join is the projection the
    // recording assumed, and in v2 it is applied by the build (ADR-0002).
    const scan: ScanOptions = {
      projection: [{ from: join(project.root, 'out'), to: project.root }],
      include: (file) => file.startsWith(join(project.root, 'src')),
    }
    const windows = resolveShard({ name: 'shard.jsonl', records }, { scan })

    // 1. One window per test, titled the way mocha titles it — describe + it. The
    //    skipped test DOES open a window: mocha runs root hooks for a pending test,
    //    which I had assumed it did not until this assertion disagreed. So it
    //    arrives here as `skipped` rather than never arriving, which is japa's
    //    situation again (A3 finding 2) and is defended the same way — the status
    //    keeps it out of the map, checked in 5 below.
    const passed = windows.tests.filter((t) => t.status === 'passed')
    assert.deepEqual(
      passed.map((t) => t.title).sort(),
      ['calc adds two numbers', 'calc subtracts two numbers'],
      `recorded: ${summary.tests.map((t) => `${t.title}=${t.status}`).join(', ')}`,
    )

    // 2. Attribution is exact. `add` is the first function in the file and `sub`
    //    the second, and each window sees only its own.
    const calc = join(project.root, 'src/calc.ts')
    const touchedBy = (title: string): string[] => {
      const found = passed.find((t) => t.title === title)
      assert.ok(found, `no window recorded for "${title}"`)
      return found.touches.filter((ref) => ref[0] === calc).map((ref) => ref[1])
    }
    assert.deepEqual(touchedBy('calc adds two numbers'), ['add@0'])
    assert.deepEqual(touchedBy('calc subtracts two numbers'), ['sub@0'])

    // 3. The import phase is its own bucket. `add` and `sub` were both executed
    //    before the first test started, so the module body is `@load` — and, per
    //    A2, a module body never turns up inside a test window.
    assert.ok(
      windows.load.some((ref) => ref[0] === calc && ref[1] === '<module>@0'),
      'the load window was not captured; the import phase went missing',
    )
    for (const touch of windows.tests.flatMap((t) => t.touches)) {
      assert.notEqual(touch[1], '<module>@0', 'a module body appeared inside a test window')
    }

    // 4. Projection did the work: the source path is the *.ts* file, which is not
    //    what V8 reported and does not exist in the generated tree.
    assert.equal(windows.tests[0]?.touches[0]?.[0], calc)

    // 5. And the shard is complete, so `buildMap` will accept it.
    const map = buildMap([{ name: 'shard.jsonl', records }], {
      commit: 'mini-head',
      scan,
    })
    assert.equal(map.tests.length, 2, 'the skipped test reached the map')
  } finally {
    project.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CBD_GRANULARITY=group records one window for the suite', () => {
  const project = makeProject()
  const dir = mkdtempSync(join(tmpdir(), 'cbd-mocha-grouped-'))
  try {
    const shardPath = join(dir, 'shard.jsonl')
    runMocha(project.root, shardPath, { CBD_GRANULARITY: 'group' })

    const records = parseShard(readFileSync(shardPath, 'utf8'), shardPath)
    // `describe('calc')` is the one group; the root suite's end finds nothing
    // pending. No test boundary took a window, which is the saving.
    assert.equal(records.filter((record) => record.type === 'group').length, 1)
    assert.equal(records.filter((record) => record.type === 'test').length, 0)

    const summary = summarizeShard(records)
    assert.deepEqual(
      summary.tests.map((entry) => entry.title).sort(),
      ['calc adds two numbers', 'calc is skipped', 'calc subtracts two numbers'],
    )
    // Every test in the group carries the same window — the union of what the
    // group executed, which is over-selection and never under-selection.
    const touches = summary.tests.map((entry) => entry.touches)
    for (const window of touches) assert.equal(window, touches[0])

    const scan: ScanOptions = {
      projection: [{ from: join(project.root, 'out'), to: project.root }],
      include: (file) => file.startsWith(join(project.root, 'src')),
    }
    const resolved = resolveShard({ name: 'shard.jsonl', records }, { scan })
    const calc = join(project.root, 'src/calc.ts')
    const keys = resolved.tests[0]?.touches.filter((ref) => ref[0] === calc).map((ref) => ref[1])
    assert.deepEqual(keys, ['add@0', 'sub@0'])
    assert.equal(summary.between.length, 0, 'the gap between tests is not a bucket in group mode')
  } finally {
    project.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CBD_SELECTION narrows a recording run to exactly the selected titles', () => {
  const project = makeProject()
  const dir = mkdtempSync(join(tmpdir(), 'cbd-mocha-selected-'))
  try {
    const selection = join(dir, 'selection.json')
    writeFileSync(selection, JSON.stringify({ titles: ['calc subtracts two numbers'] }))
    const shardPath = join(dir, 'shard.jsonl')
    runMocha(project.root, shardPath, { CBD_SELECTION: selection })

    const summary = summarizeShard(parseShard(readFileSync(shardPath, 'utf8'), shardPath))
    assert.deepEqual(
      summary.tests.map((entry) => entry.title),
      ['calc subtracts two numbers'],
      'a test outside the selection must not run, and so must not open a window',
    )
    assert.equal(summary.tests[0]?.status, 'passed')
  } finally {
    project.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CBD_SELECTION narrows a run that is not being recorded', () => {
  const project = makeProject()
  const dir = mkdtempSync(join(tmpdir(), 'cbd-mocha-selected-'))
  try {
    const selection = join(dir, 'selection.json')
    writeFileSync(selection, JSON.stringify({ titles: ['calc adds two numbers'] }))
    const output = runMocha(project.root, null, { CBD_SELECTION: selection })
    assert.match(output, /1 passing/)
    assert.match(output, /adds two numbers/)
    assert.doesNotMatch(output, /subtracts two numbers/)
  } finally {
    project.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a selection and --invert are refused rather than run as the complement', () => {
  const project = makeProject()
  const dir = mkdtempSync(join(tmpdir(), 'cbd-mocha-selected-'))
  try {
    const selection = join(dir, 'selection.json')
    writeFileSync(selection, JSON.stringify({ titles: ['calc adds two numbers'] }))
    assert.throws(
      () => runMocha(project.root, null, { CBD_SELECTION: selection }, ['--grep', 'calc', '--invert']),
      /--invert/,
      'the selected tests would have been skipped silently',
    )
  } finally {
    project.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a selection that matches no test fails the run rather than passing it', () => {
  const project = makeProject()
  const dir = mkdtempSync(join(tmpdir(), 'cbd-mocha-selected-'))
  try {
    const selection = join(dir, 'selection.json')
    writeFileSync(selection, JSON.stringify({ titles: ['calc no such test'] }))
    const result = runMochaResult(project.root, null, { CBD_SELECTION: selection })
    assert.notEqual(result.status, 0, 'a run that executed nothing was reported as a pass')
    assert.match(result.stderr, /no test ran/)
  } finally {
    project.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--parallel with a recording says the shard will be empty', () => {
  const project = makeProject()
  const dir = mkdtempSync(join(tmpdir(), 'cbd-mocha-parallel-'))
  try {
    const result = runMochaResult(project.root, join(dir, 'shard.jsonl'), {}, ['--parallel'])
    assert.match(result.stderr, /--parallel/)
  } finally {
    project.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a --parallel run whose workers ran the selected tests is not failed by the guard', () => {
  const project = makeProject()
  const dir = mkdtempSync(join(tmpdir(), 'cbd-mocha-selected-'))
  try {
    const selection = join(dir, 'selection.json')
    writeFileSync(selection, JSON.stringify({ titles: ['calc adds two numbers'] }))
    const result = runMochaResult(project.root, null, { CBD_SELECTION: selection }, ['--parallel'])
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.doesNotMatch(result.stderr, /no test ran/)
  } finally {
    project.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
