import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import {
  buildMap,
  functionsInFile,
  loadMap,
  mapDir,
  saveMap,
  testsForFunction,
  type ShardInput,
} from '../src/map.js'
import type { ShardRecord, TouchRef } from '../src/shard.js'

const A = '/repo/src/a.ts'
const B = '/repo/src/b.ts'

function shard(name: string, records: ShardRecord[]): ShardInput {
  return { name, records }
}

function header(commit = 'c0ffee'): ShardRecord {
  return { type: 'shard', version: 1, commit, pid: 1, startedAt: 'T0' }
}

/** A second process's shard, so a test can say the pid is provenance and not identity. */
function headerFrom(pid: number, commit = 'c0ffee'): ShardRecord {
  return { type: 'shard', version: 1, commit, pid, startedAt: 'T0' }
}

function testRecord(
  title: string,
  touches: TouchRef[],
  status: 'passed' | 'failed' | 'skipped' = 'passed',
): ShardRecord {
  return { type: 'test', title, file: null, status, durationMs: 1, touches }
}

const end: ShardRecord = { type: 'end', tests: 1, finishedAt: 'T1' }

const ref = (file: string, key: string, start: number, endLine: number): TouchRef => [
  file,
  key,
  start,
  endLine,
]

test('a shard becomes a map keyed by file and function', () => {
  const map = buildMap(
    [
      shard('s1', [
        header(),
        testRecord('adds', [ref(A, 'add@0', 1, 3)]),
        testRecord('multiplies', [ref(A, 'multiply@0', 5, 7)]),
        end,
      ]),
    ],
    { commit: 'c0ffee' },
  )
  assert.deepEqual(Object.keys(map.files), [A])
  assert.deepEqual(Object.keys(map.files[A]!), ['add@0', 'multiply@0'])
  assert.equal(map.tests.length, 2)
})

// The query the tool exists to answer.
test('a function maps back to the tests that reach it', () => {
  const map = buildMap(
    [
      shard('s1', [
        header(),
        testRecord('adds', [ref(A, 'add@0', 1, 3)]),
        testRecord('multiplies', [ref(A, 'add@0', 1, 3), ref(B, 'helper@0', 1, 2)]),
        end,
      ]),
    ],
    { commit: 'c0ffee' },
  )
  assert.deepEqual(
    testsForFunction(map, A, 'add@0').map((t) => t.title),
    ['adds', 'multiplies'],
  )
  assert.deepEqual(
    testsForFunction(map, B, 'helper@0').map((t) => t.title),
    ['multiplies'],
  )
  assert.deepEqual(testsForFunction(map, A, 'neverRan@0'), [])
})

test('two shards merge, and a test appearing in both is recorded once', () => {
  const map = buildMap(
    [
      shard('s1', [header(), testRecord('adds', [ref(A, 'add@0', 1, 3)]), end]),
      shard('s2', [header(), testRecord('adds', [ref(A, 'add@0', 1, 3)]), end]),
    ],
    { commit: 'c0ffee' },
  )
  assert.equal(map.tests.length, 1)
  assert.deepEqual(map.files[A]?.['add@0']?.tests, [0])
  assert.deepEqual(map.shards, ['s1', 's2'])
})

test('line ranges widen when shards disagree, and never narrow', () => {
  const map = buildMap(
    [
      shard('s1', [header(), testRecord('x', [ref(A, 'add@0', 4, 6)]), end]),
      shard('s2', [header(), testRecord('y', [ref(A, 'add@0', 2, 8)]), end]),
    ],
    { commit: 'c0ffee' },
  )
  assert.deepEqual(map.files[A]?.['add@0'], { startLine: 2, endLine: 8, tests: [0, 1] })
})

// Amendment 5. A test that aborted early executed less than it should have, so
// its touches under-select — and under-selection is the one unacceptable failure.
test('a test that did not pass is kept out of the map by default', () => {
  const records: ShardInput[] = [
    shard('s1', [
      header(),
      testRecord('green', [ref(A, 'add@0', 1, 3)], 'passed'),
      testRecord('red', [ref(A, 'multiply@0', 5, 7)], 'failed'),
      testRecord('skipped', [ref(B, 'helper@0', 1, 2)], 'skipped'),
      end,
    ]),
  ]
  const defaulted = buildMap(records, { commit: 'c0ffee' })
  assert.deepEqual(defaulted.tests.map((t) => t.title), ['green'])
  assert.equal(defaulted.files[A]?.['multiply@0'], undefined)
  assert.equal(defaulted.files[B], undefined)

  const permissive = buildMap(records, { commit: 'c0ffee', includeNonGreen: true })
  assert.deepEqual(permissive.tests.map((t) => t.title), ['green', 'red', 'skipped'])
})

test('load and between buckets merge across shards with the widest range', () => {
  const map = buildMap(
    [
      shard('s1', [header(), { type: 'load', touches: [ref(A, '<module>@0', 0, 9)] }, end]),
      shard('s2', [
        header(),
        { type: 'load', touches: [ref(A, '<module>@0', 0, 12)] },
        { type: 'between', touches: [ref(B, 'timer@0', 2, 2)] },
        end,
      ]),
    ],
    { commit: 'c0ffee' },
  )
  assert.deepEqual(map.load, [[A, '<module>@0', 0, 12]])
  assert.deepEqual(map.between, [[B, 'timer@0', 2, 2]])
})

test('the map records which shards produced it', () => {
  const map = buildMap([shard('one.jsonl', [header(), end])], { commit: 'c0ffee' })
  assert.deepEqual(map.shards, ['one.jsonl'])
  assert.equal(map.version, 1)
  assert.equal(map.commit, 'c0ffee')
})

test('saving and loading round-trips, reporting bytes and parse time', () => {
  const root = mkdtempSync(join(tmpdir(), 'cbd-map-'))
  try {
    const built = buildMap(
      [
        shard('s1', [
          header(),
          testRecord('adds', [ref(A, 'add@0', 1, 3)]),
          { type: 'between', touches: [ref(B, 'timer@0', 1, 1)] },
          end,
        ]),
      ],
      { commit: 'c0ffee', builtAt: 'T2' },
    )
    const { path, bytes } = saveMap(root, built)
    assert.equal(path, join(mapDir(root, 'c0ffee'), 'map.json'))
    assert.ok(bytes > 0)

    const loaded = loadMap(root, 'c0ffee')
    assert.equal(loaded.bytes, bytes)
    assert.ok(loaded.parseMs >= 0)
    assert.deepEqual(loaded.map, built)
    assert.deepEqual(
      testsForFunction(loaded.map, A, 'add@0').map((t) => t.title),
      ['adds'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loading a map that is not there fails loudly rather than returning empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'cbd-map-'))
  try {
    assert.throws(() => loadMap(root, 'missing'), /ENOENT|no such file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('functionsInFile lists what the map knows, sorted', () => {
  const map = buildMap(
    [
      shard('s1', [
        header(),
        testRecord('x', [ref(A, 'multiply@0', 5, 7), ref(A, 'add@0', 1, 3)]),
        end,
      ]),
    ],
    { commit: 'c0ffee' },
  )
  assert.deepEqual(functionsInFile(map, A), ['add@0', 'multiply@0'])
  assert.deepEqual(functionsInFile(map, B), [])
})

/**
 * Two shards, one test — the shape a suite driving a separately started service
 * produces, and the reason `cbd-a3v.3` writes the service's coverage to its own
 * shard rather than trying to fit two processes into one.
 *
 * The test process records what the test itself ran; the service's shard records what
 * the service ran while that test was driving it. Both name the test the same way,
 * because both are driven by the same japa hooks. If `buildMap` keyed tests by
 * anything shard-specific, this would produce *two* tests of the same name and a
 * change reaching either would select one of them — under-selecting by exactly the
 * server half, which is the failure this work exists to prevent.
 *
 * The files differ on purpose. Overlapping files would pass whether the maps merged
 * or merely collided, since the second entry would be a duplicate of the first.
 */
test('two shards naming one test union its touches rather than splitting it', () => {
  const map = buildMap(
    [
      shard('test-process', [
        header(),
        testRecord('drives the key server', [ref(A, 'add@0', 1, 3)]),
        end,
      ]),
      shard('service', [
        headerFrom(9001),
        testRecord('drives the key server', [ref(B, 'handle@0', 10, 20)]),
        end,
      ]),
    ],
    { commit: 'c0ffee' },
  )

  assert.equal(map.tests.length, 1, 'one test, recorded twice, is still one test')
  assert.deepEqual(Object.keys(map.files).sort(), [A, B])
  assert.deepEqual(testsForFunction(map, B, 'handle@0').map((t) => t.title), [
    'drives the key server',
  ])
  // And the merged test reaches both halves, which is what makes a change to either
  // file select it.
  assert.deepEqual(
    [...new Set([...functionsInFile(map, A), ...functionsInFile(map, B)])].sort(),
    ['add@0', 'handle@0'],
  )
})

// A shard's pid is provenance, not identity: the merge must not depend on it, or
// two processes could never contribute to one test.
test('the pid in a shard header does not affect the merge', () => {
  const map = buildMap(
    [
      shard('a', [header(), testRecord('x', [ref(A, 'add@0', 1, 3)]), end]),
      shard('b', [headerFrom(4242), testRecord('x', [ref(B, 'helper@0', 1, 2)]), end]),
    ],
    { commit: 'c0ffee' },
  )
  assert.equal(map.tests[0]?.title, 'x')
  assert.deepEqual(Object.keys(map.files[A]!), ['add@0'])
  assert.deepEqual(Object.keys(map.files[B]!), ['helper@0'])
})
