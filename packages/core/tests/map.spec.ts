/**
 * The merge half of a build, against already-resolved shards.
 *
 * Resolution has its own spec (`resolve.spec.ts`) because it needs a real tree of
 * generated files; everything here is about what the map does once the touches are
 * in its coordinates — merging, widening, non-green exclusion, and the queries.
 */
import assert from 'node:assert/strict'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import {
  functionsForTest,
  functionsInFile,
  loadMap,
  mapDir,
  carryMap,
  mergeShards,
  saveMap,
  testsForFunction,
  testsForLine,
} from '../src/map.js'
import type { ResolvedShard, ResolvedTest } from '../src/resolve.js'
import type { ShardHeader, TouchRef } from '../src/shard.js'
import { select } from '../src/select.js'

const A = '/repo/src/a.ts'
const B = '/repo/src/b.ts'

function header(commit = 'c0ffee', pid = 1): ShardHeader {
  return { type: 'shard', version: 2, commit, pid, startedAt: 'T0' }
}

/** A second process's shard, so a test can say the pid is provenance and not identity. */
function headerFrom(pid: number, commit = 'c0ffee'): ShardHeader {
  return header(commit, pid)
}

function shard(
  name: string,
  tests: ResolvedTest[],
  buckets: { load?: TouchRef[]; between?: TouchRef[]; teardown?: TouchRef[] } = {},
): ResolvedShard {
  return {
    name,
    header: header(),
    tests,
    load: buckets.load ?? [],
    between: buckets.between ?? [],
    teardown: buckets.teardown ?? [],
  }
}

function testRecord(
  title: string,
  touches: TouchRef[],
  status: 'passed' | 'failed' | 'skipped' = 'passed',
): ResolvedTest {
  return { title, file: null, status, durationMs: 1, touches }
}

const ref = (file: string, key: string, start: number, endLine: number): TouchRef => [
  file,
  key,
  start,
  endLine,
]

test('a shard becomes a map keyed by file and function', () => {
  const map = mergeShards(
    [
      shard('s1', [
        testRecord('adds', [ref(A, 'add@0', 1, 3)]),
        testRecord('multiplies', [ref(A, 'multiply@0', 5, 7)]),
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
  const map = mergeShards(
    [
      shard('s1', [
        testRecord('adds', [ref(A, 'add@0', 1, 3)]),
        testRecord('multiplies', [ref(A, 'add@0', 1, 3), ref(B, 'helper@0', 1, 2)]),
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

// `cbd-2ev`: the blast radius question is per line, not per function.
test('a line maps to the tests that reach it, and the file is the fallback', () => {
  const map = mergeShards(
    [
      shard('s1', [
        testRecord('adds', [ref(A, 'add@0', 10, 12)]),
        testRecord('multiplies', [ref(A, 'multiply@0', 20, 22), ref(B, 'helper@0', 1, 2)]),
      ]),
    ],
    { commit: 'c0ffee' },
  )

  // Inside a function, boundaries included.
  assert.deepEqual(testsForLine(map, A, 10).map((t) => t.title), ['adds'])
  assert.deepEqual(testsForLine(map, A, 22).map((t) => t.title), ['multiplies'])
  // Between functions — an import or a top-level constant — the whole file's tests.
  assert.deepEqual(testsForLine(map, A, 15).map((t) => t.title), ['adds', 'multiplies'])
  // A file the map has never seen has no opinion to offer.
  assert.deepEqual(testsForLine(map, '/repo/src/unknown.ts', 1), [])
})

test('a line inside nested functions is the union, not the innermost', () => {
  const map = mergeShards(
    [
      shard('s1', [
        testRecord('outer only', [ref(A, 'outer@0', 1, 30)]),
        testRecord('inner too', [ref(A, 'inner@4', 10, 12)]),
      ]),
    ],
    { commit: 'c0ffee' },
  )
  assert.deepEqual(testsForLine(map, A, 11).map((t) => t.title), ['outer only', 'inner too'])
  assert.deepEqual(testsForLine(map, A, 20).map((t) => t.title), ['outer only'])
})

test('two shards merge, and a test appearing in both is recorded once', () => {
  const map = mergeShards(
    [
      shard('s1', [testRecord('adds', [ref(A, 'add@0', 1, 3)])]),
      shard('s2', [testRecord('adds', [ref(A, 'add@0', 1, 3)])]),
    ],
    { commit: 'c0ffee' },
  )
  assert.equal(map.tests.length, 1)
  assert.deepEqual(map.files[A]?.['add@0']?.tests, [0])
  assert.deepEqual(map.shards, ['s1', 's2'])
})

test('line ranges widen when shards disagree, and never narrow', () => {
  const map = mergeShards(
    [
      shard('s1', [testRecord('x', [ref(A, 'add@0', 4, 6)])]),
      shard('s2', [testRecord('y', [ref(A, 'add@0', 2, 8)])]),
    ],
    { commit: 'c0ffee' },
  )
  assert.deepEqual(map.files[A]?.['add@0'], { startLine: 2, endLine: 8, tests: [0, 1] })
})

// Amendment 5. A test that aborted early executed less than it should have, so
// its touches under-select — and under-selection is the one unacceptable failure.
test('a test that did not pass is kept out of the map by default', () => {
  const records: ResolvedShard[] = [
    shard('s1', [
      testRecord('green', [ref(A, 'add@0', 1, 3)], 'passed'),
      testRecord('red', [ref(A, 'multiply@0', 5, 7)], 'failed'),
      testRecord('skipped', [ref(B, 'helper@0', 1, 2)], 'skipped'),
    ]),
  ]
  const defaulted = mergeShards(records, { commit: 'c0ffee' })
  assert.deepEqual(defaulted.tests.map((t) => t.title), ['green'])
  assert.equal(defaulted.files[A]?.['multiply@0'], undefined)
  assert.equal(defaulted.files[B], undefined)

  const permissive = mergeShards(records, { commit: 'c0ffee', includeNonGreen: true })
  assert.deepEqual(permissive.tests.map((t) => t.title), ['green', 'red', 'skipped'])
})

test('load and between buckets merge across shards with the widest range', () => {
  const map = mergeShards(
    [
      shard('s1', [], { load: [ref(A, '<module>@0', 0, 9)] }),
      shard('s2', [], {
        load: [ref(A, '<module>@0', 0, 12)],
        between: [ref(B, 'timer@0', 2, 2)],
      }),
    ],
    { commit: 'c0ffee' },
  )
  assert.deepEqual(map.load, [[A, '<module>@0', 0, 12]])
  assert.deepEqual(map.between, [[B, 'timer@0', 2, 2]])
})

test('a service shard attributes load only to the tests that touched it', () => {
  // The adapters open a window for every test on the service recorder too, so a
  // shard that names a test is not evidence the test observed the service.
  const service: ResolvedShard = {
    name: 'service',
    header: { ...header(), role: 'service' },
    tests: [
      testRecord('over HTTP', [ref(A, 'route@0', 1, 3)]),
      testRecord('in this process', []),
    ],
    load: [ref(A, '<module>@0', 0, 9)],
    between: [],
    teardown: [],
  }
  const map = mergeShards([service], { commit: 'c0ffee' })
  assert.deepEqual(map.shardTests?.[0], [0])
  assert.deepEqual(map.loadShards?.[A], [0])
})

test('a test shard attributes load to every test in the process', () => {
  const map = mergeShards(
    [shard('s1', [testRecord('adds', [ref(A, 'add@0', 1, 3)]), testRecord('reads', [])], {
      load: [ref(B, '<module>@0', 0, 9)],
    })],
    { commit: 'c0ffee' },
  )
  assert.deepEqual(map.shardTests?.[0], [0, 1])
  assert.deepEqual(map.loadShards?.[B], [0])
})

test('reads and directory reads merge per file', () => {
  const map = mergeShards(
    [
      shard('s1', [
        { ...testRecord('reads', []), reads: [A, '/repo/data.json'], dirReads: ['/repo/specs'] },
      ]),
      shard('s2', [{ ...testRecord('lists', []), reads: [A] }]),
    ],
    { commit: 'c0ffee' },
  )
  assert.deepEqual(map.reads, { [A]: [0, 1], '/repo/data.json': [0] })
  assert.deepEqual(map.dirReads, { '/repo/specs': [0] })
})

test('the map records which shards produced it', () => {
  const map = mergeShards([shard('one.jsonl', [])], { commit: 'c0ffee' })
  assert.deepEqual(map.shards, ['one.jsonl'])
  assert.equal(map.version, 1)
  assert.equal(map.commit, 'c0ffee')
})

test('saving and loading round-trips, reporting bytes and parse time', () => {
  const root = mkdtempSync(join(tmpdir(), 'cbd-map-'))
  try {
    const built = mergeShards(
      [
        shard('s1', [testRecord('adds', [ref(A, 'add@0', 1, 3)])], {
          between: [ref(B, 'timer@0', 1, 1)],
        }),
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

test('mapsDir puts the map where a shared checkout can find it', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cbd-map-root-')))
  const shared = realpathSync(mkdtempSync(join(tmpdir(), 'cbd-map-shared-')))
  try {
    const built = mergeShards([shard('s1', [testRecord('adds', [ref(A, 'add@0', 1, 3)])])], {
      commit: 'c0ffee',
      builtAt: 'T2',
    })
    const { path } = saveMap(root, built, '.cbd', shared)
    assert.equal(path, join(shared, 'c0ffee', 'map.json'))
    // The default layout is untouched when mapsDir is absent.
    assert.equal(mapDir(root, 'c0ffee'), join(root, '.cbd', 'maps', 'c0ffee'))

    const loaded = loadMap(root, 'c0ffee', '.cbd', shared)
    assert.deepEqual(loaded.map, built)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(shared, { recursive: true, force: true })
  }
})

test('carryMap carries untouched tests and marks what it could not', () => {
  const DATA = '/repo/data/schema.json'
  const DATA2 = '/repo/data/other.json'
  const base = mergeShards(
    [
      shard('s1', [
        { ...testRecord('adds', [ref(A, 'add@0', 1, 3)]), file: '/repo/tests/a.spec.ts' },
        {
          ...testRecord('reads', [ref(A, 'add@0', 1, 3)]),
          file: '/repo/tests/a.spec.ts',
          reads: [DATA],
        },
        {
          ...testRecord('other', [ref(B, 'b@0', 1, 2)]),
          file: '/repo/tests/b.spec.ts',
          reads: [DATA2],
        },
      ]),
    ],
    { commit: 'c0ffee', builtAt: 'T1' },
  )
  // The incremental run recorded only `adds`; `reads` used a changed file and was
  // not re-run, `other` used only unchanged files.
  const next = mergeShards(
    [shard('s2', [{ ...testRecord('adds', [ref(A, 'add@0', 1, 3)]), file: '/repo/tests/a.spec.ts' }])],
    { commit: 'beef', builtAt: 'T2' },
  )

  const carried = carryMap(base, next, new Set([A]))
  assert.deepEqual(carried.tests.map((test) => test.title), ['adds', 'other'])
  assert.deepEqual(carried.carried, { base: 'c0ffee', tests: 1 })
  // The dropped test's evidence is poisoned, not guessed at: the file it used,
  // the data it read, and the spec it lived in.
  assert.deepEqual(carried.partial, [A, DATA, '/repo/tests/a.spec.ts'].sort())
  // The carried test keeps its evidence on the unchanged file, re-indexed.
  assert.deepEqual(carried.files[B]?.['b@0']?.tests, [1])
  assert.deepEqual(carried.reads, { [DATA2]: [1] })
  assert.ok(carried.shards.includes('carried:c0ffee'))
  // Buckets belong to the new run only; the old process is gone.
  assert.deepEqual(carried.load, [])
})

test('a later incremental build keeps the partial files an earlier one admitted', () => {
  const DATA = '/repo/data/schema.json'
  const SPEC = '/repo/tests/a.spec.ts'
  const base = mergeShards(
    [
      shard('s1', [
        { ...testRecord('reads', [ref(A, 'add@0', 1, 3)]), file: SPEC, reads: [DATA] },
        { ...testRecord('other', [ref(B, 'b@0', 1, 2)]), file: '/repo/tests/b.spec.ts' },
      ]),
    ],
    { commit: 'c0ffee', builtAt: 'T1' },
  )
  // The first incremental run dropped `reads` because its data file changed. The
  // second recorded nothing, so it cannot heal what the first one admitted it did
  // not know — the marker has to survive the chain, or a change to the data file
  // would answer with a subset that silently omits the test.
  const second = carryMap(
    base,
    mergeShards([shard('s2', [])], { commit: 'beef', builtAt: 'T2' }),
    new Set([DATA]),
  )
  assert.deepEqual(second.partial, [A, DATA, SPEC].sort())

  const third = carryMap(
    second,
    mergeShards([shard('s3', [])], { commit: 'f00d', builtAt: 'T3' }),
    new Set(),
  )
  assert.deepEqual(third.partial, [A, DATA, SPEC].sort())

  const answer = select(third, [{ path: DATA, status: 'M', hunks: [] }])
  assert.equal(answer.mode, 'all')
  assert.ok(answer.reasons.some((reason) => reason.kind === 'all' && reason.why === 'partial'))
})

test('a dropped opaque test keeps its marker instead of vanishing', () => {
  const SPEC = '/repo/tests/a.spec.ts'
  const base = mergeShards(
    [
      shard('s1', [
        {
          ...testRecord('drives a cli', [ref(A, 'add@0', 1, 3)]),
          file: SPEC,
          opaque: ['spawns the tool'],
        },
        { ...testRecord('other', [ref(B, 'b@0', 1, 2)]), file: '/repo/tests/b.spec.ts' },
      ]),
    ],
    { commit: 'c0ffee', builtAt: 'T1' },
  )
  // The recording changed A without re-running the opaque test: its window is
  // stale, but the declaration that it depends on something invisible is not.
  const carried = carryMap(
    base,
    mergeShards([shard('s2', [])], { commit: 'beef', builtAt: 'T2' }),
    new Set([A]),
  )
  assert.deepEqual(carried.tests.map((test) => test.title), ['other', 'drives a cli'])
  assert.equal(carried.files[A], undefined, 'stale coverage is not carried')
  assert.deepEqual(carried.opaque, { 'spawns the tool': [1] })
  assert.ok(carried.partial?.includes(A))

  // Any in-scope change still selects it, including one it never touched.
  const answer = select(carried, [{ path: B, status: 'M', hunks: [{ start: 1, end: 2 }] }])
  assert.equal(answer.mode, 'subset')
  assert.deepEqual(
    answer.tests.map((index) => carried.tests[index]!.title).sort(),
    ['drives a cli', 'other'],
  )
})

// `cbd-0na.5`: absolute paths made a recording work only in the worktree that
// made it. The map stores them relative to its root and resolves them on load.
test('a map saved in one checkout resolves in a second checkout of the same commit', () => {
  // Canonical roots, as `createCbd` uses: a recorded module URL resolves through
  // symlinks, so `/var` vs `/private/var` must not decide whether a path is inside.
  const first = realpathSync(mkdtempSync(join(tmpdir(), 'cbd-map-first-')))
  const second = realpathSync(mkdtempSync(join(tmpdir(), 'cbd-map-second-')))
  try {
    const source = join(first, 'src/a.ts')
    const spec = join(first, 'tests/a.spec.ts')
    const built = mergeShards(
      [
        shard(
          's1',
          [{ ...testRecord('adds', [ref(source, 'add@0', 1, 3)]), file: spec }],
          { load: [ref(source, '<module>@0', 0, 9)] },
        ),
      ],
      { commit: 'c0ffee' },
    )
    saveMap(first, built)

    const stored = JSON.parse(
      readFileSync(join(mapDir(first, 'c0ffee'), 'map.json'), 'utf8'),
    ) as { files: Record<string, unknown>; tests: Array<{ file: string | null }>; seen: string[] }
    assert.deepEqual(Object.keys(stored.files), ['src/a.ts'])
    assert.equal(stored.tests[0]?.file, 'tests/a.spec.ts')
    assert.deepEqual(stored.seen, ['src/a.ts'])

    mkdirSync(mapDir(second, 'c0ffee'), { recursive: true })
    copyFileSync(
      join(mapDir(first, 'c0ffee'), 'map.json'),
      join(mapDir(second, 'c0ffee'), 'map.json'),
    )

    const loaded = loadMap(second, 'c0ffee')
    assert.deepEqual(Object.keys(loaded.map.files), [join(second, 'src/a.ts')])
    assert.equal(loaded.map.tests[0]?.file, join(second, 'tests/a.spec.ts'))
    assert.deepEqual(loaded.map.seen, [join(second, 'src/a.ts')])
    assert.deepEqual(
      testsForFunction(loaded.map, join(second, 'src/a.ts'), 'add@0').map((entry) => entry.title),
      ['adds'],
    )
  } finally {
    rmSync(first, { recursive: true, force: true })
    rmSync(second, { recursive: true, force: true })
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

test('functionsForTest is the inverse of the function index', () => {
  const map = mergeShards(
    [
      shard('s1', [
        testRecord('adds', [ref(A, 'add@0', 1, 3), ref(B, 'helper@0', 1, 2)]),
        testRecord('multiplies', [ref(A, 'multiply@0', 5, 7)]),
      ]),
    ],
    { commit: 'c0ffee' },
  )
  assert.deepEqual(
    functionsForTest(map, 0).map((fn) => [fn.file, fn.key, fn.startLine, fn.endLine]),
    [
      [A, 'add@0', 1, 3],
      [B, 'helper@0', 1, 2],
    ],
  )
  assert.deepEqual(
    functionsForTest(map, 1).map((fn) => fn.key),
    ['multiply@0'],
  )
  assert.deepEqual(functionsForTest(map, 99), [])
})

test('functionsInFile lists what the map knows, sorted', () => {
  const map = mergeShards(
    [
      shard('s1', [
        testRecord('x', [ref(A, 'multiply@0', 5, 7), ref(A, 'add@0', 1, 3)]),
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
 * because both are driven by the same japa hooks. If the merge keyed tests by
 * anything shard-specific, this would produce *two* tests of the same name and a
 * change reaching either would select one of them — under-selecting by exactly the
 * server half, which is the failure this work exists to prevent.
 *
 * The files differ on purpose. Overlapping files would pass whether the maps merged
 * or merely collided, since the second entry would be a duplicate of the first.
 */
test('two shards naming one test union its touches rather than splitting it', () => {
  const map = mergeShards(
    [
      {
        ...shard('test-process', [testRecord('drives the key server', [ref(A, 'add@0', 1, 3)])]),
        header: headerFrom(9001),
      },
      {
        ...shard('service', [testRecord('drives the key server', [ref(B, 'handle@0', 10, 20)])]),
        header: headerFrom(9002),
      },
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
  const map = mergeShards(
    [
      shard('a', [testRecord('x', [ref(A, 'add@0', 1, 3)])]),
      {
        ...shard('b', [testRecord('x', [ref(B, 'helper@0', 1, 2)])]),
        header: headerFrom(4242),
      },
    ],
    { commit: 'c0ffee' },
  )
  assert.equal(map.tests[0]?.title, 'x')
  assert.deepEqual(Object.keys(map.files[A]!), ['add@0'])
  assert.deepEqual(Object.keys(map.files[B]!), ['helper@0'])
})

test('same title and file stay distinct with an ordinal', () => {
  const file = '/repo/tests/x.spec.ts'
  const map = mergeShards(
    [
      shard('s1', [
        { title: 'same', file, status: 'passed', durationMs: 1, touches: [ref(A, 'a@0', 1, 1)] },
        {
          title: 'same',
          file,
          ordinal: 1,
          status: 'passed',
          durationMs: 1,
          touches: [ref(A, 'b@0', 1, 1)],
        },
      ]),
    ],
    { commit: 'c0ffee' },
  )
  assert.equal(map.tests.length, 2)
  assert.deepEqual(
    map.tests.map((entry) => [entry.title, entry.file, entry.ordinal]),
    [
      ['same', file, undefined],
      ['same', file, 1],
    ],
  )
  // Each occurrence keeps its own coverage; a function reached only by the
  // second does not pull the first into the answer.
  assert.deepEqual(testsForFunction(map, A, 'a@0').map((entry) => entry.ordinal), [undefined])
  assert.deepEqual(testsForFunction(map, A, 'b@0').map((entry) => entry.ordinal), [1])
})
