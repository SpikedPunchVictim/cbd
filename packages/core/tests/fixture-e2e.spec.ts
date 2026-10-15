/**
 * The point of the stage.
 *
 * Runs the fixture's suite twice — once from the source-mapped build, once from
 * the build with no maps at all — normalises each test's coverage window in both,
 * and requires the resulting `src/` keys to be identical.
 *
 * If path projection is wrong, the unmapped build produces nothing and this fails
 * loudly. If it were merely *plausible*, the two would disagree on some file and
 * this fails on that file by name.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixtureRoot = resolve(coreRoot, '../../fixture')

interface Collection {
  build: string
  viaCounts: Record<string, number>
  tests: Record<string, string[]>
}

let cached: { mapped: Collection; unmapped: Collection } | null = null

function runCollector(build: string, outFile: string): Collection {
  execFileSync(
    process.execPath,
    [join(coreRoot, 'scripts/collect-fixture.mjs'), build, outFile],
    { stdio: 'pipe' },
  )
  return JSON.parse(readFileSync(outFile, 'utf8')) as Collection
}

/** Collecting twice is expensive (it runs the whole fixture suite), so do it once. */
function collectBoth(): { mapped: Collection; unmapped: Collection } {
  if (cached !== null) return cached
  const dir = mkdtempSync(join(tmpdir(), 'cbd-e2e-'))
  try {
    cached = {
      mapped: runCollector('out-maps', join(dir, 'maps.json')),
      unmapped: runCollector('out-nomaps', join(dir, 'nomaps.json')),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return cached
}

test('both builds produce attribution for the same tests', () => {
  const { mapped, unmapped } = collectBoth()
  const mappedTitles = Object.keys(mapped.tests)
  assert.ok(mappedTitles.length > 30, `only ${mappedTitles.length} tests were attributed`)
  assert.deepEqual(Object.keys(unmapped.tests).sort(), mappedTitles.sort())
})

// Without this, the test below could pass while both builds quietly took the
// same path — proving nothing about projection.
test('each build actually used its own resolution path', () => {
  const { mapped, unmapped } = collectBoth()
  assert.ok(mapped.viaCounts['source-map']! > 0, 'out-maps resolved nothing through a source map')
  assert.equal(mapped.viaCounts.projection, 0, 'out-maps fell back to projection')
  assert.ok(unmapped.viaCounts.projection! > 0, 'out-nomaps resolved nothing by projection')
  assert.equal(unmapped.viaCounts['source-map'], 0, 'out-nomaps found source maps it should not have')
})

test('the mapped and unmapped builds normalise to identical src/ keys', () => {
  const { mapped, unmapped } = collectBoth()
  for (const [title, keys] of Object.entries(mapped.tests)) {
    assert.deepEqual(unmapped.tests[title], keys, `attribution diverged for "${title}"`)
  }
})

test('a known test is attributed to the source functions it exercises', () => {
  const { mapped } = collectBoth()
  const keys = mapped.tests['add sums two numbers'] ?? []
  assert.ok(
    keys.includes(`${join(fixtureRoot, 'src/math.ts')}::add@0`),
    `expected add@0 in src/math.ts, got:\n${keys.join('\n')}`,
  )
})

// The inverse map, from the same data. `factorial` lives in a file that IS loaded
// and never runs; `uncovered.ts` is never imported at all.
test('code no test reaches appears in no window', () => {
  const { mapped } = collectBoth()
  const everything = Object.values(mapped.tests).flat()
  assert.equal(
    everything.some((key) => key.includes('src/uncovered.ts')),
    false,
    'a module no test imports was attributed to some test',
  )
  assert.equal(
    everything.some((key) => key.includes('::factorial@')),
    false,
    'a function that never runs appeared as a touch',
  )
})

test('a shared helper is reachable from many tests, as a filename rule could not tell', () => {
  const { mapped } = collectBoth()
  const helpersFile = join(fixtureRoot, 'src/helpers.ts')
  const reaching = Object.entries(mapped.tests).filter(([, keys]) =>
    keys.some((key) => key.startsWith(`${helpersFile}::`)),
  )
  assert.ok(
    reaching.length >= 5,
    `expected several tests to reach src/helpers.ts, found ${reaching.length}`,
  )
})
