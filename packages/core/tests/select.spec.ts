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
import { fileDefinesTests, select, verify, type Selection } from '../src/select.js'

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
/** A file a test reads as text; it executes no code, so coverage cannot place it. */
const DATA = '/repo/data/schema.json'
/** A directory a test lists. */
const LISTED = '/repo/specs'

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
    reads: { [DATA]: [1] },
    dirReads: { [LISTED]: [2] },
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

// --- rule 0: the config file (`cbd-73r.3`) ----------------------------------
test('rule 0: a changed config file forces mode: all', () => {
  const config = '/repo/cbd.config.json'
  const result = select(makeMap(), [change(config)], {
    configFile: config,
    include: () => false,
  })
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:config-changed'])
  assert.deepEqual(result.ignored, [], 'the config is claimed, not ignored')
})

test('rule 0: renaming the config away also forces all', () => {
  const config = '/repo/cbd.config.json'
  const result = select(
    makeMap(),
    [{ path: '/repo/old-config.json', status: 'R', from: config, hunks: [] }],
    { configFile: config },
  )
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:config-changed'])
})

test('rule 0: configChanged names the config once and leaves other files their reasons', () => {
  const config = '/repo/cbd.config.json'
  const result = select(makeMap(), [change(config), change(SRC, [{ start: 2, end: 2 }])], {
    configFile: config,
    configChanged: true,
  })
  assert.equal(result.mode, 'all')
  // One reason, for the file that changed the config — not one per changed file.
  assert.deepEqual(
    result.reasons
      .filter((reason) => reason.kind === 'all')
      .map((reason) => (reason.kind === 'all' ? reason.file : undefined)),
    [config],
  )
  assert.ok(
    result.reasons.some((reason) => reason.kind === 'function' && reason.file === SRC),
    `expected SRC's own reason, got: ${reasonKinds(result).join(', ')}`,
  )
})

test('rule 0: configChanged forces all even when the config is not in the change list', () => {
  // A base leg can report the config as changed without the config appearing in
  // the changes the selector is given.
  const config = '/repo/cbd.config.json'
  const result = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }])], {
    configFile: config,
    configChanged: true,
  })
  assert.equal(result.mode, 'all')
  assert.deepEqual(
    result.reasons
      .filter((reason) => reason.kind === 'all')
      .map((reason) => (reason.kind === 'all' ? reason.file : undefined)),
    [config],
  )
})

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

// --- opaque dependencies ----------------------------------------------------
test('a test that declared an opaque dependency is selected by any in-scope change', () => {
  const map = makeMap({ opaque: { 'spawns a tool': [2] } })
  const result = select(map, [change(DATA, [{ start: 1, end: 1 }])])
  assert.equal(result.mode, 'subset')
  // Test 1 reads the data file; test 2's dependency is invisible, so the marker
  // is its only answer — it cannot be narrowed to a path.
  assert.deepEqual(result.tests, [1, 2])
  assert.deepEqual(reasonKinds(result), ['read', 'opaque'])
})

test('an opaque dependency on a clean tree selects nothing', () => {
  const result = select(makeMap({ opaque: { 'spawns a tool': [2] } }), [])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [])
})

// --- partial (incremental) maps ---------------------------------------------
test('a change to a partial file forces all, and says why', () => {
  const map = makeMap({ partial: [SRC] })
  const result = select(map, [change(SRC, [{ start: 2, end: 2 }])])
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:partial'])
})

test('a partial directory covers every file under it', () => {
  const map = makeMap({ partial: [LISTED] })
  const result = select(map, [change(`${LISTED}/new.ts`, [{ start: 1, end: 1 }])])
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:partial'])
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

// A re-export barrel has a load touch but no function index. A change to it used
// to stop at the file's observed readers: removing an export breaks every test
// that imported the module, whether or not it also read the file as text.
test('rule 2: a read-answered @load barrel still selects the tests that loaded it', () => {
  const BARREL = '/repo/src/barrel.ts'
  const map = makeMap({
    load: [[BARREL, '<module>@0', 0, 9]],
    reads: { [BARREL]: [1] },
    loadShards: { [BARREL]: [0] },
    shardTests: [[0, 1, 2]],
  })
  const result = select(map, [change(BARREL, [{ start: 5, end: 6 }])])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [0, 1, 2])
  assert.deepEqual(reasonKinds(result), ['read', 'file'])
})

test('rule 2: deleting a read-answered @load barrel selects the load observers', () => {
  const BARREL = '/repo/src/barrel.ts'
  const map = makeMap({
    load: [[BARREL, '<module>@0', 0, 9]],
    reads: { [BARREL]: [1] },
    loadShards: { [BARREL]: [0] },
    shardTests: [[0, 1, 2]],
  })
  const result = select(map, [change(BARREL, [], 'D')])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [0, 1, 2])
})

test('rule 8: deleting a @load module selects the tests that loaded it', () => {
  const map = makeMap({
    load: [[SRC, '<module>@0', 0, 30]],
    loadShards: { [SRC]: [0] },
    shardTests: [[0, 1, 2]],
  })
  // The function index names 0 and 1; test 2 never called into SRC but loaded it.
  const result = select(map, [change(SRC, [], 'D')])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [0, 1, 2])
  assert.deepEqual(reasonKinds(result), ['file'])
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

// `cbd-73r.1`: one hunk can contain module scope and a function's first line.
// Treating the whole hunk as the function's dropped the binding readers.
test('rule 5: a single hunk spanning module scope and a function widens too', () => {
  // Line 4 is between functions; line 5 is `multiply`'s first line.
  const result = select(makeMap(), [change(SRC, [{ start: 4, end: 5 }])])
  assert.deepEqual(reasonKinds(result), ['function', 'file'])
  assert.deepEqual(result.tests, [0, 1])
})

test('rule 5: a deletion hunk spanning the boundary widens too', () => {
  // The new side is empty: lines 4–5 were deleted. The old-side range still
  // contains module scope (line 4) and `multiply`'s first line (5).
  const result = select(makeMap(), [
    { path: SRC, status: 'M', hunks: [{ start: 4, end: 5 }], newHunks: [] },
  ])
  assert.deepEqual(reasonKinds(result), ['function', 'file'])
  assert.deepEqual(result.tests, [0, 1])
})

test('rule 5: a module-body range does not cover the file for the outside check', () => {
  // A module body can be a `files` entry when a test imported it dynamically;
  // its V8 range is the whole file, so treating it as a function would hide the
  // module-scope answer again.
  const base = makeMap()
  const map = {
    ...base,
    files: {
      ...base.files,
      [SRC]: {
        ...base.files[SRC]!,
        '<module>@0': { startLine: 0, endLine: 20, tests: [2] },
      },
    },
  }
  const result = select(map, [change(SRC, [{ start: 4, end: 4 }])])
  assert.deepEqual(reasonKinds(result), ['function', 'file'])
  assert.deepEqual(result.tests, [0, 1, 2])
})

test('rule 4: a module-body observer is selected for a change inside a function', () => {
  // A test that dynamically imported the module can read an export whose
  // declaration changed, without calling the function. The module body must stay
  // in `hit` even though it is excluded from the coverage check.
  const base = makeMap()
  const map = {
    ...base,
    files: {
      ...base.files,
      [SRC]: {
        ...base.files[SRC]!,
        '<module>@0': { startLine: 0, endLine: 20, tests: [2] },
      },
    },
  }
  const result = select(map, [change(SRC, [{ start: 2, end: 2 }])])
  assert.deepEqual(result.tests, [0, 2])
})

test('rule 5: a replacement that adds a line at a function start widens', () => {
  // `cbd-73r.1` follow-up: old line 1 is the function's first line, but the new
  // side has two lines, so the added one may be module scope.
  const result = select(makeMap(), [
    {
      path: SRC,
      status: 'M',
      hunks: [{ start: 1, end: 1 }],
      newHunks: [{ start: 1, end: 2 }],
    },
  ])
  assert.deepEqual(reasonKinds(result), ['function', 'file'])
  assert.deepEqual(result.tests, [0, 1])
})

test('rule 5: adding a line inside a function body does not widen', () => {
  const result = select(makeMap(), [
    {
      path: SRC,
      status: 'M',
      hunks: [{ start: 2, end: 2 }],
      newHunks: [{ start: 2, end: 3 }],
    },
  ])
  assert.deepEqual(reasonKinds(result), ['function'])
  assert.deepEqual(result.tests, [0])
})

test('rule 5: a hunk wholly inside a function does not widen', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 2, end: 3 }])])
  assert.deepEqual(reasonKinds(result), ['function'])
  assert.deepEqual(result.tests, [0])
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

// --- reads ---------------------------------------------------------------
test('a change to a read file selects the tests that read it', () => {
  const result = select(makeMap(), [change(DATA, [{ start: 1, end: 1 }])])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [1])
  assert.deepEqual(result.reasons, [{ kind: 'read', file: DATA, tests: [1] }])
})

test('a change under a listed directory selects the test that listed it', () => {
  const result = select(makeMap(), [change(`${LISTED}/new.spec.ts`, [{ start: 1, end: 1 }])])
  assert.deepEqual(result.tests, [2])
  assert.deepEqual(reasonKinds(result), ['read'])
})

test('readers compose with the function rule', () => {
  const map = makeMap({ reads: { [SRC]: [2] } })
  const result = select(map, [change(SRC, [{ start: 2, end: 2 }])])
  assert.deepEqual(result.tests, [0, 2])
  assert.deepEqual(reasonKinds(result), ['read', 'function'])
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
  assert.deepEqual(result.ignored, [], 'claimed by the entry, not silently ignored')
})

test('an alwaysSelect entry the map cannot resolve forces all and warns', () => {
  const result = select(makeMap(), [change(SRC, [{ start: 2, end: 2 }])], {
    alwaysSelect: [{ tests: [{ file: SPEC, title: 'renamed away' }] }],
  })
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['function', 'all:always-unknown'])
  assert.ok(result.warnings.some((warning) => /alwaysSelect names .* renamed away/.test(warning)))
})

// --- rule 7 override: unknownPolicyFor -----------------------------------
test('unknownPolicyFor ignores an unknown file, reports it, and names the entry', () => {
  const result = select(makeMap(), [change('/repo/tools/new.ts', [{ start: 1, end: 1 }])], {
    unknownPolicyFor: [{ paths: ['/repo/tools/**'], policy: 'ignore' }],
  })
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [])
  assert.deepEqual(result.ignored, ['/repo/tools/new.ts'])
  assert.ok(
    result.warnings.some((warning) =>
      /unknownPolicyFor\[0\].*\/repo\/tools\/\*\*/.test(warning),
    ),
    `expected the entry in the warning, got: ${result.warnings.join(' | ')}`,
  )
})

test('unknownPolicyFor all still forces mode: all', () => {
  const result = select(makeMap(), [change('/repo/tools/new.ts', [{ start: 1, end: 1 }])], {
    unknownPolicyFor: [{ paths: ['/repo/tools/**'], policy: 'all' }],
  })
  assert.equal(result.mode, 'all')
  assert.deepEqual(reasonKinds(result), ['all:unknown-file'])
})

test('unknownPolicyFor uses the first matching entry', () => {
  const result = select(makeMap(), [change('/repo/tools/new.ts', [{ start: 1, end: 1 }])], {
    unknownPolicyFor: [
      { paths: ['/repo/tools/**'], policy: 'all' },
      { paths: ['/repo/**'], policy: 'ignore' },
    ],
  })
  assert.equal(result.mode, 'all')
})

test('unknownPolicyFor does not apply to a file the map knows', () => {
  const result = select(makeMap(), [change(HELPER, [{ start: 1, end: 1 }])], {
    unknownPolicyFor: [{ paths: ['/repo/**'], policy: 'ignore' }],
  })
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.tests, [2])
  assert.deepEqual(reasonKinds(result), ['function'])
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

test('order impact runs the changed function before a reader and keeps the set', () => {
  // Test 0 reads DATA; test 1 executes the changed function in SRC. Map order is
  // [0, 1], so a different order proves the ranking rather than a coincidence.
  const map = makeMap({ reads: { [DATA]: [0] } })
  const changes = [change(DATA), change(SRC, [{ start: 5, end: 5 }])]

  const plain = select(map, changes, {})
  const ordered = select(map, changes, { order: 'impact' })
  assert.deepEqual(plain.tests, [0, 1])
  assert.deepEqual(ordered.tests, [1, 0])
  assert.deepEqual(
    [...ordered.tests].sort((a, b) => a - b),
    [...plain.tests].sort((a, b) => a - b),
    'ordering must not change which tests are selected',
  )
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

test('a load-only helper that defines tests hands off to the load rule', () => {
  const HELPER = '/repo/tests/helpers/contract.ts'
  const base = makeMap()
  const map = makeMap({
    load: [[HELPER, '<module>@0', 0, 5]],
    seen: [...base.seen, HELPER],
  })
  const changed = change(HELPER, [{ start: 1, end: 1 }])

  const fallback = select(map, [changed], { definesTests: () => true })
  assert.equal(fallback.mode, 'all')
  assert.deepEqual(reasonKinds(fallback), ['all:load'])

  const attributed = select(
    makeMap({
      load: [[HELPER, '<module>@0', 0, 5]],
      seen: [...base.seen, HELPER],
      loadShards: { [HELPER]: [0] },
      shardTests: [[0, 1]],
    }),
    [changed],
    { definesTests: () => true },
  )
  assert.equal(attributed.mode, 'subset')
  assert.deepEqual(attributed.tests, [0, 1])
  assert.deepEqual(reasonKinds(attributed), ['file'])
})

test('compensating hunks do not cancel the module-scope widening', () => {
  const map = makeMap({
    files: {
      [SRC]: {
        'f@0': { startLine: 1, endLine: 6, tests: [0] },
        'g@0': { startLine: 8, endLine: 10, tests: [1] },
        'h@0': { startLine: 12, endLine: 14, tests: [2] },
      },
    },
  })
  // One line deleted inside f, one inserted above g: file totals are equal, but
  // g's own hunk changed its line count and may have moved module scope.
  const result = select(map, [
    {
      path: SRC,
      status: 'M',
      hunks: [
        { start: 2, end: 3 },
        { start: 8, end: 8 },
      ],
      newHunks: [
        { start: 2, end: 2 },
        { start: 8, end: 9 },
      ],
      insertions: [],
      newInsertions: [],
      hunkEdits: [
        { oldStart: 2, oldCount: 2, newStart: 2, newCount: 1 },
        { oldStart: 8, oldCount: 1, newStart: 8, newCount: 2 },
      ],
    },
  ])
  assert.equal(result.mode, 'subset')
  assert.ok(result.tests.includes(2), 'the module-scope reader (test 2) must be selected')
})

test('verify reads the new side and checks a pure insertion', () => {
  const map = makeMap()
  const info = { commit: 'c0ffee', distance: 0, dirty: false, builtAt: 'T0' }
  const notSelected: Selection = {
    mode: 'subset',
    reasons: [],
    tests: [0],
    unmapped: [],
    untested: [],
    ignored: [],
    warnings: [],
    map: info,
  }
  const insertion: Change = {
    path: SRC,
    status: 'M',
    hunks: [],
    newHunks: [],
    insertions: [8],
    newInsertions: [9],
  }
  const missed = verify(
    notSelected,
    map,
    [insertion],
    new Map([['multiplies', [[SRC, 'multiply@0', 9, 9]]]]),
  )
  assert.equal(missed.checked, 1, 'a pure insertion is checked, not skipped')
  assert.deepEqual(missed.misses.map((miss) => miss.test), ['multiplies'])

  const shifted: Change = {
    path: SRC,
    status: 'M',
    hunks: [{ start: 5, end: 5 }],
    newHunks: [{ start: 9, end: 9 }],
  }
  const selected: Selection = { ...notSelected, tests: [1] }
  const ok = verify(
    selected,
    map,
    [shifted],
    new Map([['multiplies', [[SRC, 'multiply@0', 9, 9]]]]),
  )
  assert.equal(ok.checked, 1)
  assert.deepEqual(ok.misses, [])
})
