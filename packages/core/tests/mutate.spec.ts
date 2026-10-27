/**
 * Mutation selection: the `select` safety ladder applied to a mutant range.
 *
 * Each test is one row of ADR-0015's table. The map is built directly rather than
 * from shards: the helper's contract is over the map's indexes, and a shard would
 * only add the recorder's concerns to the assertions.
 */
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { test } from '@japa/runner'
import { MAP_VERSION, type CoverageMap, type FunctionEntry, type TestEntry } from '../src/map.js'
import { mutantTests } from '../src/mutate.js'
import type { TouchRef } from '../src/shard.js'

// `resolve` gives a root that is absolute on the host: a bare '/repo' gains a drive letter on Windows.
const ROOT = resolve('/repo')
const FILE = join(ROOT, 'src', 'a.ts')
const TESTS: TestEntry[] = [
  { title: 'alpha one', file: '/repo/tests/a.spec.ts' },
  { title: 'alpha two', file: '/repo/tests/a.spec.ts' },
  { title: 'beta', file: null },
]

function mapOf(overrides: Partial<CoverageMap> = {}): CoverageMap {
  return {
    version: MAP_VERSION,
    commit: 'c0ffee',
    builtAt: '2026-10-19T00:00:00Z',
    tests: TESTS,
    files: {},
    load: [],
    between: [],
    teardown: [],
    seen: [],
    shards: ['run.ndjson'],
    ...overrides,
  }
}

const entry = (startLine: number, endLine: number, tests: number[]): FunctionEntry => ({
  startLine,
  endLine,
  tests,
})

const touch = (file: string, key: string, startLine: number, endLine: number): TouchRef => [
  file,
  key,
  startLine,
  endLine,
]

test('a line inside a function selects that function\'s tests', () => {
  const map = mapOf({
    files: {
      [FILE]: {
        alpha: entry(10, 20, [0, 1]),
        beta: entry(30, 40, [2]),
      },
    },
    seen: [FILE],
  })
  assert.deepEqual(mutantTests(map, { file: 'src/a.ts', startLine: 15 }, { root: ROOT }), {
    mode: 'subset',
    why: 'function',
    tests: TESTS.slice(0, 2),
  })
})

test('nested functions contribute the union of their tests', () => {
  const map = mapOf({
    files: {
      [FILE]: {
        outer: entry(1, 20, [0]),
        inner: entry(5, 10, [1]),
      },
    },
    seen: [FILE],
  })
  assert.deepEqual(
    mutantTests(map, { file: FILE, startLine: 7 }, { root: ROOT }).tests,
    TESTS.slice(0, 2),
  )
})

test('a range inside overlapping functions is their union, deduplicated', () => {
  const map = mapOf({
    files: {
      [FILE]: {
        outer: entry(10, 40, [0, 1]),
        inner: entry(15, 20, [1, 2]),
      },
    },
    seen: [FILE],
  })
  // Every line is inside `outer`; the overlap also intersects `inner`.
  assert.deepEqual(
    mutantTests(map, { file: FILE, startLine: 14, endLine: 21 }, { root: ROOT }),
    { mode: 'subset', why: 'function', tests: TESTS },
  )
})

test('a line outside every function falls back to every test that touched the file', () => {
  const map = mapOf({
    files: {
      [FILE]: {
        alpha: entry(10, 20, [0, 1]),
        beta: entry(30, 40, [2]),
      },
    },
    seen: [FILE],
  })
  assert.deepEqual(mutantTests(map, { file: FILE, startLine: 25 }, { root: ROOT }), {
    mode: 'subset',
    why: 'file',
    tests: TESTS,
  })
})

test('a range with one line outside the functions is a file-level mutant', () => {
  const map = mapOf({
    files: {
      [FILE]: {
        alpha: entry(10, 20, [0]),
        beta: entry(30, 40, [2]),
      },
    },
    seen: [FILE],
  })
  // Every line is not inside a function: line 25 is top-level. Only the tests
  // that touched a function in the file can be named (`alpha two` is not in
  // those entries); that is the same file-level answer `select` gives.
  assert.deepEqual(mutantTests(map, { file: FILE, startLine: 15, endLine: 35 }, { root: ROOT }), {
    mode: 'subset',
    why: 'file',
    tests: [TESTS[0], TESTS[2]],
  })
})

test('top-level code in a file reached at import time makes the answer all tests', () => {
  const map = mapOf({
    files: { [FILE]: { alpha: entry(10, 20, [0]) } },
    load: [touch(FILE, '<module>@0', 1, 40)],
    seen: [FILE],
  })
  assert.deepEqual(mutantTests(map, { file: FILE, startLine: 1 }, { root: ROOT }), {
    mode: 'all',
    why: 'load',
    tests: [],
  })
  // A file imported at start-up can still have function evidence; a mutant in
  // that function is killable by the tests that executed it in their windows.
  assert.deepEqual(mutantTests(map, { file: FILE, startLine: 15 }, { root: ROOT }), {
    mode: 'subset',
    why: 'function',
    tests: [TESTS[0]],
  })
})

test('a file reached only at import time has no per-test evidence', () => {
  const map = mapOf({ load: [touch(FILE, '<module>@0', 1, 40)], seen: [FILE] })
  assert.deepEqual(mutantTests(map, { file: FILE, startLine: 15 }, { root: ROOT }), {
    mode: 'all',
    why: 'load',
    tests: [],
  })
})

test('teardown code makes the answer all tests', () => {
  const map = mapOf({ teardown: [touch(FILE, 'late@0', 1, 5)], seen: [FILE] })
  assert.deepEqual(mutantTests(map, { file: FILE, startLine: 3 }, { root: ROOT }), {
    mode: 'all',
    why: 'teardown',
    tests: [],
  })
})

test('between code outside every function is all tests by default', () => {
  const map = mapOf({
    files: { [FILE]: { alpha: entry(10, 20, [0]) } },
    between: [touch(FILE, 'poll@0', 10, 20)],
    seen: [FILE],
  })
  // Line 25 is top-level: the map cannot attribute the between execution.
  assert.deepEqual(mutantTests(map, { file: FILE, startLine: 25 }, { root: ROOT }), {
    mode: 'all',
    why: 'between',
    tests: [],
  })
  assert.deepEqual(
    mutantTests(map, { file: FILE, startLine: 25 }, { root: ROOT, betweenPolicy: 'ignore' }),
    { mode: 'subset', why: 'file', tests: [TESTS[0]] },
  )
  // Inside a mapped function, per-test evidence wins, as in `select`.
  assert.deepEqual(mutantTests(map, { file: FILE, startLine: 15 }, { root: ROOT }), {
    mode: 'subset',
    why: 'function',
    tests: [TESTS[0]],
  })
})

test('between code in a file with no per-test evidence is all or none by policy', () => {
  const map = mapOf({ between: [touch(FILE, 'poll@0', 1, 40)], seen: [FILE] })
  assert.deepEqual(mutantTests(map, { file: FILE, startLine: 15 }, { root: ROOT }), {
    mode: 'all',
    why: 'between',
    tests: [],
  })
  assert.deepEqual(
    mutantTests(map, { file: FILE, startLine: 15 }, { root: ROOT, betweenPolicy: 'ignore' }),
    { mode: 'none', why: 'between', tests: [] },
  )
})

test('an unknown file is all tests by default and none when ignored', () => {
  const map = mapOf()
  assert.deepEqual(mutantTests(map, { file: FILE, startLine: 1 }, { root: ROOT }), {
    mode: 'all',
    why: 'unknown-file',
    tests: [],
  })
  assert.deepEqual(
    mutantTests(map, { file: FILE, startLine: 1 }, { root: ROOT, unknownPolicy: 'ignore' }),
    { mode: 'none', why: 'unknown-file', tests: [] },
  )
})

test('a file the map has seen but no test reaches has no candidates', () => {
  const map = mapOf({ seen: [FILE] })
  assert.deepEqual(mutantTests(map, { file: FILE, startLine: 1 }, { root: ROOT }), {
    mode: 'none',
    why: 'untested',
    tests: [],
  })
})

test('a mutant in a test file is refused: it changes the oracle', () => {
  const map = mapOf({ seen: ['/repo/tests/a.spec.ts'] })
  assert.deepEqual(
    mutantTests(map, { file: '/repo/tests/a.spec.ts', startLine: 1 }, { root: ROOT }),
    { mode: 'none', why: 'test-file', tests: [] },
  )
})

test('the range defaults to one line and rejects invalid ranges', () => {
  const map = mapOf({
    files: { [FILE]: { alpha: entry(10, 20, [0]) } },
    seen: [FILE],
  })
  assert.equal(mutantTests(map, { file: FILE, startLine: 15 }, { root: ROOT }).mode, 'subset')
  assert.throws(
    () => mutantTests(map, { file: FILE, startLine: 15, endLine: 10 }, { root: ROOT }),
    /1-based and ordered/,
  )
  assert.throws(
    () => mutantTests(map, { file: FILE, startLine: 0 }, { root: ROOT }),
    /1-based and ordered/,
  )
})

// The module body is a V8 entry spanning the whole file. Counting it as a function
// calls every line covered and places a top-level mutant inside one, so a mutant
// outside every real function answers with the importer alone instead of the
// file-wide answer. `select` excludes the same entry.
test('the module body does not count as a function for the outside check', () => {
  const map = mapOf({
    files: {
      [FILE]: {
        '<module>@0': entry(1, 100, [0]),
        alpha: entry(10, 20, [1]),
      },
    },
    seen: [FILE],
    load: [touch(FILE, '@module', 1, 1)],
  })
  const selection = mutantTests(map, { file: FILE, startLine: 60 })
  assert.equal(selection.mode, 'all')
  assert.equal(selection.why, 'load')
})

// A map that says its evidence is incomplete cannot name a subset for anything.
test('a partial file, or an unhealthy map, runs everything', () => {
  const files = { [FILE]: { alpha: entry(10, 20, [0]) } }
  const partial = mutantTests(
    mapOf({ files, seen: [FILE], partial: [FILE] }),
    { file: FILE, startLine: 12 },
  )
  assert.equal(partial.mode, 'all')
  assert.equal(partial.why, 'partial')

  const unhealthy = mutantTests(
    mapOf({ files, seen: [FILE], unhealthy: ['run.ndjson: 1 window(s) could not be taken'] }),
    { file: FILE, startLine: 12 },
  )
  assert.equal(unhealthy.mode, 'all')
  assert.equal(unhealthy.why, 'unhealthy')
})

// A test that drives a tool over the file, or reads it as text, can kill a mutant
// without executing it — `select` runs those tests for any in-scope change.
test('opaque, read and directory-listing tests are added to a subset', () => {
  const map = mapOf({
    files: { [FILE]: { alpha: entry(10, 20, [0]) } },
    seen: [FILE],
    opaque: { 'spawned a tool': [2] },
    reads: { [FILE]: [1] },
    dirReads: { '/repo/src': [2] },
  })
  const selection = mutantTests(map, { file: FILE, startLine: 12 })
  assert.equal(selection.mode, 'subset')
  assert.deepEqual(
    selection.tests.map((test) => test.title),
    ['alpha one', 'alpha two', 'beta'],
  )
})
