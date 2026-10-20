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
import { fileDefinesTests, select, verify } from '../src/select.js'

const SRC = '/repo/src/a.ts'
const HELPER = '/repo/src/helper.ts'
const SPEC = '/repo/tests/a.spec.ts'
/** Matches the default tests-directory glob, but defines no tests: ordinary code (`cbd-e9l`). */
const TEST_HELPER = '/repo/tests/helpers/auth.ts'
/** Also under `tests/`, seen, and with no function evidence of its own. */
const TEST_HELPER_UNTOUCHED = '/repo/tests/helpers/unused.ts'
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
      [TEST_HELPER]: {
        'buildAuth@0': { startLine: 1, endLine: 4, tests: [2] },
      },
    },
    load: [[LOADED_ONLY, '<module>@0', 0, 9]],
    between: [],
    teardown: [],
    seen: [SRC, HELPER, SPEC, TEST_HELPER, TEST_HELPER_UNTOUCHED, LOADED_ONLY, BETWEEN_ONLY, UNTESTED],
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

test('rule 1: alwaysAll applies outside include', () => {
  // The documented config lists `**/migrations/**` in alwaysAll while include
  // covers only src/**, so a migration change must still run everything. Checking
  // include first silently dropped it (cbd-0lu).
  const result = select(makeMap(), [change('/repo/migrations/001.sql')], {
    include: (path) => path.startsWith('/repo/src/'),
    alwaysAll: ['**/migrations/**'],
  })
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:always-all'])
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

// `cbd-0na.2`: a module body that ran at load is observable through its
// top-level bindings. A test can compare one without calling a function in the
// file, so "the tests that touched the file" is not the honest answer.
test('rule 5: an outside-function change in a @load file forces mode: all', () => {
  const map = makeMap({ load: [[SRC, '<module>@0', 0, 30]] })
  const result = select(map, [change(SRC, [{ start: 20, end: 20 }])])
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:load'])
  assert.deepEqual(result.unmapped, [SRC])
})

test('rule 5: a @load file selects the tests in the process that loaded it', () => {
  // One process loaded the module; a test comparing a top-level binding runs in
  // that process even if it never calls a function in the file. The map records
  // the shard's tests, so the answer is those plus the function index's tests.
  const map = makeMap({
    load: [[SRC, '<module>@0', 0, 30]],
    shardTests: [[1]],
    loadShards: { [SRC]: [0] },
  })
  const result = select(map, [change(SRC, [{ start: 20, end: 20 }])])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [0, 1])
  assert.deepEqual(reasonKinds(result), ['file'])
})

test('rule 5: a @load file still answers a change inside a function precisely', () => {
  const map = makeMap({ load: [[SRC, '<module>@0', 0, 30]] })
  const result = select(map, [change(SRC, [{ start: 2, end: 2 }])])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [0])
  assert.deepEqual(reasonKinds(result), ['function'])
})

test('rule 5: an insertion outside every function in a @load file forces all', () => {
  const map = makeMap({ load: [[SRC, '<module>@0', 0, 30]] })
  const result = select(map, [inserted(SRC, 4)])
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:load'])
})

test('rule 5: a file in @teardown gets the same outside-function answer', () => {
  const map = makeMap({ teardown: [[SRC, 'cleanup@0', 0, 30]] })
  const result = select(map, [change(SRC, [{ start: 20, end: 20 }])])
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:load'])
})

// --- rule 3 -----------------------------------------------------------------
test('rule 3: a changed test file selects its known tests and warns about the gap', () => {
  // The map can name this file's existing tests, but not a test the edit added.
  // `known` is the default because spec edits are ordinary (53 of 79 commits in
  // one measured week), so the gap is surfaced rather than paid for every time.
  const result = select(makeMap(), [change(SPEC, [{ start: 3, end: 3 }])])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(reasonKinds(result), ['test-file'])
  assert.deepEqual(result.tests, [0, 1, 2])
  assert.ok(
    result.warnings.some((warning) => /a test it adds is not in the map/.test(warning)),
    `expected the new-test gap to be named, got: ${result.warnings.join(' | ')}`,
  )
})

test('rule 3: testFilePolicy "all" forces the suite for a changed test file', () => {
  const result = select(makeMap(), [change(SPEC, [{ start: 3, end: 3 }])], {
    testFilePolicy: 'all',
  })
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:test-file'])
})

test('rule 3: a brand-new test file cannot be named, so falls to unknown', () => {
  const result = select(makeMap(), [change('/repo/tests/brand-new.spec.ts', [{ start: 1, end: 1 }])])
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:unknown-file'])
})

// `cbd-e9l`: a helper under a tests directory is code, not a test definition,
// and the default `**/tests/**` glob must not hand it to rule 3.
test('rule 3 does not claim a test helper: the function index answers it', () => {
  const inside = select(makeMap(), [change(TEST_HELPER, [{ start: 2, end: 2 }])])
  assert.equal(inside.mode, 'subset')
  assert.deepEqual(reasonKinds(inside), ['function'])
  assert.deepEqual(inside.tests, [2])

  const outside = select(makeMap(), [change(TEST_HELPER, [{ start: 20, end: 20 }])])
  assert.equal(outside.mode, 'subset')
  assert.deepEqual(reasonKinds(outside), ['file'])
  assert.deepEqual(outside.tests, [2])
})

test('the registration scan sees the common shapes and not ordinary calls', () => {
  for (const text of [
    "test('adds', () => {})",
    'it("works", () => {})',
    'test.each([1])("n", () => {})',
    'describe.skip("x", () => {})',
    'suite("s", () => {})',
    "  test ('spaced', () => {})",
  ]) {
    assert.equal(fileDefinesTests(text), true, text)
  }
  for (const text of [
    'const latest = value',
    'function contest(x) {}',
    "const s = 'test('",
  ]) {
    assert.equal(fileDefinesTests(text), false, text)
  }
})

// `cbd-0na.3`: a helper that defines tests through a shared function is a test
// file even though the registry attributes its tests to the spec that calls it.
test('rule 3: a helper that defines tests is answered as a test file', () => {
  const result = select(makeMap(), [change(TEST_HELPER, [{ start: 2, end: 2 }])], {
    definesTests: () => true,
  })
  assert.equal(result.mode, 'subset')
  assert.deepEqual(reasonKinds(result), ['test-file'])
  assert.deepEqual(result.tests, [2], 'the tests that execute code in the helper')
  assert.ok(
    result.warnings.some((warning) => /a test it adds is not in the map/.test(warning)),
    `expected the added-test warning, got: ${result.warnings.join(' | ')}`,
  )
})

test('rule 3: testFilePolicy all forces the suite for a helper that defines tests', () => {
  const result = select(makeMap(), [change(TEST_HELPER, [{ start: 2, end: 2 }])], {
    definesTests: () => true,
    testFilePolicy: 'all',
  })
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:test-file'])
})

test('rule 3: a helper with no registration call keeps the function answer', () => {
  const result = select(makeMap(), [change(TEST_HELPER, [{ start: 2, end: 2 }])], {
    definesTests: () => false,
  })
  assert.deepEqual(reasonKinds(result), ['function'])
  assert.deepEqual(result.tests, [2])
})

test('rule 3: an unscanned new test file still reaches unknown-file', () => {
  const result = select(
    makeMap(),
    [change('/repo/tests/brand-new.spec.ts', [{ start: 1, end: 1 }])],
    { definesTests: () => true },
  )
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:unknown-file'])
})

test('a seen helper with no evidence is untested, not unknown', () => {
  const result = select(makeMap(), [change(TEST_HELPER_UNTOUCHED, [{ start: 1, end: 1 }])])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [])
  assert.deepEqual(result.untested, [TEST_HELPER_UNTOUCHED])
  assert.deepEqual(reasonKinds(result), [])
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

// --- rule 4/5, pure insertions (`cbd-81h.1`) --------------------------------
const inserted = (path: string, ...points: number[]): Change => ({
  path,
  status: 'M',
  hunks: [],
  insertions: points,
})

test('an insertion inside a mapped function selects that function, not the file', () => {
  // `add@0` spans lines 1-3; inserting after line 2 is inside it.
  const result = select(makeMap(), [inserted(SRC, 2)])
  assert.deepEqual(result.tests, [0])
  assert.deepEqual(result.reasons, [{ kind: 'function', file: SRC, fn: 'add@0', tests: [0] }])
})

test('an insertion between functions selects every test that touched the file', () => {
  // Line 4 sits between `add` (1-3) and `multiply` (5-7).
  const result = select(makeMap(), [inserted(SRC, 4)])
  assert.deepEqual(result.tests, [0, 1])
  assert.deepEqual(reasonKinds(result), ['file'])
})

test('an insertion at the start of the file selects every test that touched it', () => {
  const result = select(makeMap(), [inserted(SRC, 0)])
  assert.deepEqual(result.tests, [0, 1])
})

test('an insertion after a function’s closing line is top-level code, not the function’s', () => {
  // `multiply@0` ends at line 7; content appended after it is outside every function.
  const result = select(makeMap(), [inserted(SRC, 7)])
  assert.deepEqual(result.tests, [0, 1])
  assert.deepEqual(reasonKinds(result), ['file'])
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

// --- rule 11: alwaysSelect (`cbd-0na.4`) ------------------------------------
test('alwaysSelect adds its tests to a matching subset with its own reason', () => {
  const result = select(makeMap(), [change(HELPER, [{ start: 1, end: 1 }])], {
    alwaysSelect: [{ tests: [{ file: SPEC, title: 'adds' }], when: ['/repo/src/**'] }],
  })
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [0, 2])
  assert.deepEqual(
    result.reasons.filter((reason) => reason.kind === 'always'),
    [{ kind: 'always', tests: [0] }],
  )
})

test('alwaysSelect does not fire when no change matches its when globs', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }])], {
    alwaysSelect: [{ tests: [{ file: SPEC, title: 'multiplies' }], when: ['/repo/docs/**'] }],
  })
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [0])
})

test('alwaysSelect with no when fires on any in-scope change', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }])], {
    alwaysSelect: [{ tests: [{ file: SPEC, title: 'multiplies' }] }],
  })
  assert.deepEqual(result.tests, [0, 1])
})

test('alwaysSelect with no when does not fire on an empty change set', () => {
  const result = select(makeMap(), [], {
    alwaysSelect: [{ tests: [{ file: SPEC, title: 'adds' }] }],
  })
  assert.deepEqual(result.tests, [])
  assert.deepEqual(result.reasons, [])
})

test('alwaysSelect names a whole test file', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }])], {
    alwaysSelect: [{ tests: [{ file: SPEC }] }],
  })
  assert.deepEqual(result.tests, [0, 1, 2])
})

test('alwaysSelect can claim a change outside include', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }])], {
    include: (path) => !path.startsWith('/repo/src/'),
    alwaysSelect: [{ tests: [{ file: SPEC, title: 'adds' }], when: ['/repo/src/**'] }],
  })
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [0], 'the always entry, not the per-file rule')
  assert.deepEqual(result.ignored, [SRC])
})

test('an alwaysSelect entry the map cannot resolve forces all and warns', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }])], {
    alwaysSelect: [{ tests: [{ file: SPEC, title: 'renamed away' }] }],
  })
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['function', 'all:always-unknown'])
  assert.ok(result.warnings.some((warning) => /alwaysSelect names .* renamed away/.test(warning)))
})

// --- misc -------------------------------------------------------------------
test('a file outside include is ignored, and named as ignored', () => {
  const result = select(makeMap(), [change('/repo/docs/readme.md')], {
    include: (path) => !path.startsWith('/repo/docs/'),
  })
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [])
  assert.deepEqual(result.reasons, [])
  assert.deepEqual(result.ignored, ['/repo/docs/readme.md'])
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
