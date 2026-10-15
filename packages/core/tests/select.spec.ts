/**
 * One test per row of CBD.md §8.3, in the document's order.
 *
 * The map here is hand-built rather than recorded, so each rule can be isolated
 * on exactly the facts it turns on. `recorder-e2e.spec.ts` covers the same code
 * against a real recording.
 */
import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import type { Change } from '../src/changes.js'
import type { CoverageMap } from '../src/map.js'
import { select, verify } from '../src/select.js'

const SRC = '/repo/src/a.ts'
const HELPER = '/repo/src/helper.ts'
const SPEC = '/repo/tests/a.spec.ts'
/** Loaded, never exercised by a test: rule 2. */
const LOADED_ONLY = '/repo/src/loaded-only.ts'
/** Reached only from outside a window: rule 9. */
const BETWEEN_ONLY = '/repo/src/between-only.ts'
/** The map has evidence for it, and no test reaches it: rule 6. */
const UNTESTED = '/repo/src/seen-untested.ts'

function makeMap(overrides: Partial<CoverageMap> = {}): CoverageMap {
  return {
    version: 1,
    commit: 'c0ffee',
    builtAt: 'T0',
    tests: [
      { title: 'adds', file: SPEC },
      { title: 'multiplies', file: SPEC },
      { title: 'uses helper', file: SPEC },
    ],
    files: {
      [SRC]: {
        'add@0': { startLine: 1, endLine: 3, tests: [0] },
        'multiply@0': { startLine: 5, endLine: 7, tests: [1] },
      },
      [HELPER]: {
        'helper@0': { startLine: 1, endLine: 2, tests: [2] },
      },
    },
    load: [[LOADED_ONLY, '<module>@0', 0, 9]],
    between: [],
    teardown: [],
    seen: [SRC, HELPER, SPEC, LOADED_ONLY, BETWEEN_ONLY, UNTESTED],
    shards: ['s1'],
    ...overrides,
  }
}

const change = (
  path: string,
  hunks: Change['hunks'] = [],
  status: Change['status'] = 'M',
  from?: string,
): Change => (from === undefined ? { path, status, hunks } : { path, status, from, hunks })

const reasonKinds = (selection: ReturnType<typeof select>): string[] =>
  selection.reasons.map((r) => (r.kind === 'all' ? `all:${r.why}` : r.kind))

// --- rule 1 -----------------------------------------------------------------
test('rule 1: a file matching alwaysAll forces mode: all', () => {
  const result = select(makeMap(), [change('/repo/package.json')], {
    alwaysAll: ['**/package.json', '**/*.lock'],
  })
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:always-all'])
  assert.deepEqual(result.unmapped, ['/repo/package.json'])
})

// --- rule 2 -----------------------------------------------------------------
test('rule 2: a file reached only by @load forces mode: all', () => {
  const result = select(makeMap(), [change(LOADED_ONLY, [{ start: 1, end: 1 }])])
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:load'])
})

test('rule 2: a file reached only by @teardown is treated the same way', () => {
  const map = makeMap({ load: [], teardown: [[LOADED_ONLY, 'cleanup@0', 1, 1]] })
  const result = select(map, [change(LOADED_ONLY, [{ start: 1, end: 1 }])])
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:load'])
})

// --- rule 3 -----------------------------------------------------------------
test('rule 3: a changed test file selects the tests it contains', () => {
  const result = select(makeMap(), [change(SPEC, [{ start: 3, end: 3 }])])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(reasonKinds(result), ['test-file'])
  assert.deepEqual(result.tests, [0, 1, 2])
})

test('rule 3: a brand-new test file cannot be named, so falls to unknown', () => {
  const result = select(makeMap(), [change('/repo/tests/brand-new.spec.ts', [{ start: 1, end: 1 }])])
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:unknown-file'])
})

// --- rule 4 -----------------------------------------------------------------
test('rule 4: a hunk inside a mapped function selects that function’s tests', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }])])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [0])
  assert.deepEqual(
    result.reasons,
    [{ kind: 'function', file: SRC, fn: 'add@0', tests: [0] }],
  )
})

test('rule 4: hunks in two functions select both, and only those', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }, { start: 6, end: 6 }])])
  assert.deepEqual(result.tests, [0, 1])
})

// --- rule 5 -----------------------------------------------------------------
test('rule 5: a hunk outside every function selects every test that touched the file', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 20, end: 20 }])])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(reasonKinds(result), ['file'])
  assert.deepEqual(result.tests, [0, 1])
})

test('rule 5: a hunk partly outside still widens to the whole file', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }, { start: 50, end: 50 }])])
  assert.deepEqual(reasonKinds(result), ['function', 'file'])
  assert.deepEqual(result.tests, [0, 1])
})

test('rule 5: a change carrying no hunks at all still widens to the whole file', () => {
  const result = select(makeMap(), [change(SRC, [])])
  assert.deepEqual(result.tests, [0, 1])
})

// --- rule 6 -----------------------------------------------------------------
test('rule 6: a file the map has seen but no test reaches is untested, not unknown', () => {
  const result = select(makeMap(), [change(UNTESTED)], { unknownPolicy: 'ignore' })
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.untested, [UNTESTED])
  assert.deepEqual(result.tests, [])
})

// --- rule 7 -----------------------------------------------------------------
test('rule 7: a file the map has never seen forces mode: all by default', () => {
  const result = select(makeMap(), [change('/repo/src/types.ts', [{ start: 1, end: 1 }])])
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:unknown-file'])
})

test('rule 7: unknownPolicy ignore keeps the answer a subset, but reports it', () => {
  const result = select(makeMap(), [change('/repo/src/types.ts', [{ start: 1, end: 1 }])], {
    unknownPolicy: 'ignore',
  })
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.unmapped, ['/repo/src/types.ts'])
})

// --- rule 8 -----------------------------------------------------------------
test('rule 8: a deleted file selects every test that touched it', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 1, end: 7 }], 'D')])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [0, 1])
})

// --- rule 9 -----------------------------------------------------------------
test('rule 9: a file reached only by @between forces mode: all by default', () => {
  const map = makeMap({ between: [[BETWEEN_ONLY, 'timer@0', 1, 1]] })
  const result = select(map, [change(BETWEEN_ONLY, [{ start: 1, end: 1 }])])
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:between'])
})

test('rule 9: betweenPolicy ignore downgrades it, leaving the finding visible', () => {
  const map = makeMap({ between: [[BETWEEN_ONLY, 'timer@0', 1, 1]] })
  const result = select(map, [change(BETWEEN_ONLY, [{ start: 1, end: 1 }])], {
    betweenPolicy: 'ignore',
  })
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.unmapped, [BETWEEN_ONLY])
})

// --- rule 10 ----------------------------------------------------------------
test('rule 10: a dirty map warns, and --strict turns the warning into mode: all', () => {
  const lenient = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }])], {}, { dirty: true })
  assert.equal(lenient.mode, 'subset')
  assert.ok(lenient.warnings.length > 0)

  const strict = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }])], { strict: true }, {
    dirty: true,
  })
  assert.equal(strict.mode, 'all')
  // Both are kept: the escalation, and what would otherwise have run. `tests` is
  // empty either way, so the moot reason cannot be mistaken for an instruction.
  assert.ok(reasonKinds(strict).includes('all:stale-map'))
  assert.ok(reasonKinds(strict).includes('function'))
  assert.deepEqual(strict.tests, [])
})

test('rule 10: a map past maxAgeCommits warns, and --strict makes it all', () => {
  const lenient = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }])], {
    maxAgeCommits: 5,
  }, { distance: 9 })
  assert.equal(lenient.mode, 'subset')
  assert.ok(lenient.warnings.some((w) => w.includes('9 commits behind')))

  const strict = select(
    makeMap(),
    [change(SRC, [{ start: 2, end: 2 }])],
    { maxAgeCommits: 5, strict: true },
    { distance: 9 },
  )
  assert.equal(strict.mode, 'all')
})

// --- misc -------------------------------------------------------------------
test('a file outside include is ignored entirely', () => {
  const result = select(makeMap(), [change('/repo/docs/readme.md')], {
    include: (path) => !path.startsWith('/repo/docs/'),
  })
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [])
  assert.deepEqual(result.reasons, [])
})

test('mode: all reports no test list, because the runner decides', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }]), change('/repo/package.json')], {
    alwaysAll: ['**/package.json'],
  })
  assert.equal(result.mode, 'all')
  assert.deepEqual(result.tests, [])
})

// --- verify -----------------------------------------------------------------
test('verify finds no miss when the selection covers what actually ran', () => {
  const map = makeMap()
  const selection = select(map, [change(SRC, [{ start: 2, end: 2 }])])
  const groundTruth = new Map([
    ['adds', [[SRC, 'add@0', 1, 3]] as [string, string, number, number][]],
    ['multiplies', [[SRC, 'multiply@0', 5, 7]] as [string, string, number, number][]],
  ])
  const result = verify(selection, map, [change(SRC, [{ start: 2, end: 2 }])], groundTruth)
  assert.deepEqual(result.misses, [])
  assert.ok(result.checked > 0)
})

// The planted miss. A hunk lands in `multiply`, but the map forgot that
// `multiplies` touches it — so the selection names only `adds` while a real run
// proves `multiplies` reaches the changed line. Under-selection, caught.
test('verify reports a test that reached changed code but was not selected', () => {
  const map = makeMap({
    files: {
      [SRC]: {
        'add@0': { startLine: 1, endLine: 3, tests: [0] },
        'multiply@0': { startLine: 5, endLine: 7, tests: [] },
      },
    },
  })
  const selection = select(map, [change(SRC, [{ start: 6, end: 6 }])])
  assert.deepEqual(selection.tests, [])

  const groundTruth = new Map([
    ['multiplies', [[SRC, 'multiply@0', 5, 7]] as [string, string, number, number][]],
  ])
  const result = verify(selection, map, [change(SRC, [{ start: 6, end: 6 }])], groundTruth)
  assert.equal(result.misses.length, 1)
  assert.equal(result.misses[0]?.test, 'multiplies')
  assert.equal(result.misses[0]?.key, 'multiply@0')
})

test('verify has nothing to check when the answer was all', () => {
  const map = makeMap()
  const selection = select(map, [change('/repo/package.json')], { alwaysAll: ['**/package.json'] })
  const result = verify(selection, map, [change('/repo/package.json')], new Map())
  assert.equal(result.ranEverything, true)
  assert.deepEqual(result.misses, [])
})

test('verify ignores tests whose touches are nowhere near a changed range', () => {
  const map = makeMap()
  const selection = select(map, [change(SRC, [{ start: 2, end: 2 }])])
  const groundTruth = new Map([
    ['uses helper', [[HELPER, 'helper@0', 1, 2]] as [string, string, number, number][]],
  ])
  const result = verify(selection, map, [change(SRC, [{ start: 2, end: 2 }])], groundTruth)
  assert.equal(result.checked, 0)
  assert.deepEqual(result.misses, [])
})
