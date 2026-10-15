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
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { buildMap, parseShard, summarizeShard } from '@cbd/core'
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

function runMocha(root: string, shardPath: string): void {
  const require = createRequire(join(packageRoot, 'package.json'))
  const mochaBin = require.resolve('mocha/bin/mocha.js')
  try {
    execFileSync(process.execPath, [mochaBin, '--exit', join(root, 'spec/calc.spec.js')], {
      cwd: packageRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: `--import ${pathToFileURL(autoEntry).href}`,
        CBD_SHARD: shardPath,
        CBD_COMMIT: 'mini-head',
        CBD_PROJECTION_FROM: join(root, 'out'),
        CBD_PROJECTION_TO: root,
        CBD_INCLUDE: join(root, 'src'),
        CBD_MOCHA_ROOT: packageRoot,
      },
      stdio: 'pipe',
    })
  } catch (error) {
    const failed = error as { message: string; stdout?: Buffer; stderr?: Buffer }
    throw new Error(
      `mocha run failed: ${failed.message}\n` +
        `${failed.stdout?.toString() ?? ''}\n${failed.stderr?.toString() ?? ''}`,
    )
  }
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

    const summary = summarizeShard(parseShard(readFileSync(shardPath, 'utf8'), shardPath))
    assert.equal(summary.header.commit, 'mini-head')

    // 1. One window per test, titled the way mocha titles it — describe + it. The
    //    skipped test DOES open a window: mocha runs root hooks for a pending test,
    //    which I had assumed it did not until this assertion disagreed. So it
    //    arrives here as `skipped` rather than never arriving, which is japa's
    //    situation again (A3 finding 2) and is defended the same way — the status
    //    keeps it out of the map, checked in 5 below.
    const passed = summary.tests.filter((t) => t.status === 'passed')
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
      summary.load.some((ref) => ref[0] === calc && ref[1] === '<module>@0'),
      'the load window was not captured; the import phase went missing',
    )
    for (const touch of summary.tests.flatMap((t) => t.touches)) {
      assert.notEqual(touch[1], '<module>@0', 'a module body appeared inside a test window')
    }

    // 4. Projection did the work: the source path is the *.ts* file, which is not
    //    what V8 reported and does not exist in the generated tree.
    assert.equal(summary.tests[0]?.touches[0]?.[0], calc)

    // 5. And the shard is complete, so `buildMap` will accept it.
    const map = buildMap([{ name: 'shard.jsonl', records: parseShard(readFileSync(shardPath, 'utf8'), shardPath) }], {
      commit: 'mini-head',
    })
    assert.equal(map.tests.length, 2, 'the skipped test reached the map')
  } finally {
    project.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
})
