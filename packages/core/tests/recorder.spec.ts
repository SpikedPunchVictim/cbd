/**
 * The Recorder against a scripted source, so each window can be given an exact
 * payload. The interesting assertions are about *which* take lands in *which*
 * bucket — the bookkeeping that decides what the selector can attribute.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { Recorder } from '../src/recorder.js'
import { recordEnv } from '../src/record.js'
import {
  recordDependency,
  recordDirRead,
  recordOpaque,
  recordRead,
} from '../src/record.js'
import { parseShard, StringSink, summarizeShard } from '../src/shard.js'
import type { ShardRecord, ShardTouch } from '../src/shard.js'
import type {
  PendingTake,
  QueuedSource,
  ScriptInfo,
  Source,
  V8Function,
  V8ScriptCoverage,
} from '../src/types.js'

const MODULE = [
  '// a leading comment, so the first function does not start at offset 0',
  'function alpha() {',
  '  return 1',
  '}',
  'function beta() {',
  '  return 2',
  '}',
  'function gamma() {',
  '  return 3',
  '}',
].join('\n')

interface Tree {
  root: string
  outDir: string
  url: string
  cleanup: () => void
}

function makeTree(): Tree {
  const root = mkdtempSync(join(tmpdir(), 'cbd-recorder-'))
  const outDir = join(root, 'out-nomaps')
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, 'mod.js')
  writeFileSync(file, MODULE)
  return {
    root,
    outDir,
    url: pathToFileURL(file).href,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** A payload naming whole functions, with the counts a window would report. */
function payload(url: string, counts: Record<string, number>): V8ScriptCoverage[] {
  const functions: V8Function[] = []
  for (const [name, count] of Object.entries(counts)) {
    const start = MODULE.indexOf(`function ${name}`)
    const end = MODULE.indexOf('}', start) + 1
    functions.push({
      functionName: name,
      isBlockCoverage: false,
      ranges: [{ startOffset: start, endOffset: end, count }],
    })
  }
  return [{ scriptId: '1', url, functions }]
}

/** The generated range of one function in `MODULE`. */
function rangeOf(name: string): [number, number] {
  const start = MODULE.indexOf(`function ${name}`)
  return [start, MODULE.indexOf('}', start) + 1]
}

/** The function start offsets a projected window holds. */
function startsOf(touch: ShardTouch): number[] {
  return Object.values(touch).flatMap((ranges) => ranges.map(([start]) => start))
}

function holds(touch: ShardTouch, name: string): boolean {
  return startsOf(touch).includes(rangeOf(name)[0])
}

/** Hands out one payload per take, then repeats the last one. */
function scriptedSource(payloads: V8ScriptCoverage[][], info?: ScriptInfo): Source {
  let index = 0
  const next = (): V8ScriptCoverage[] => {
    const value = payloads[Math.min(index, payloads.length - 1)] ?? []
    index += 1
    return value
  }
  return {
    kind: 'scripted',
    supportsSync: true,
    takeSync: next,
    take: async () => next(),
    scripts: () => (info === undefined ? new Map() : new Map([['1', info]])),
    close: () => {},
  }
}

/** The script row a one-test run wrote; `declaration` is the file's own comment, if any. */
function scriptRow(tree: Tree, info?: ScriptInfo, declaration?: string): ShardRecord {
  const withMap =
    declaration === undefined ? MODULE : `${MODULE}\n//# sourceMappingURL=${declaration}\n`
  writeFileSync(join(tree.outDir, 'mod.js'), withMap)
  const source = scriptedSource([payload(tree.url, { alpha: 1 })], info)
  const sink = new StringSink()
  const recorder = new Recorder({ source, sink, commit: 'c0ffee' })
  recorder.runStart()
  recorder.testStart('a', null)
  recorder.testEnd('a', 'passed')
  recorder.runEnd()
  const row = parseShard(sink.text).find((record) => record.type === 'script')
  assert.ok(row !== undefined, 'the run wrote no script row')
  return row
}

function run(tree: Tree, records: string): ShardRecord[] {
  return parseShard(records)
}

test('a script row carries a content hash for the stale check', () => {
  const tree = makeTree()
  try {
    const row = scriptRow(tree)
    assert.equal(row.type, 'script')
    assert.match(
      row.type === 'script' ? (row.hash ?? '') : '',
      /^[0-9a-f]{64}$/,
      'a script row must carry a SHA-256 of the bytes it was recorded against',
    )
  } finally {
    tree.cleanup()
  }
})

test('reads noted in a window belong to that test; reads outside are dropped', () => {
  const tree = makeTree()
  try {
    const sink = new StringSink()
    const recorder = new Recorder({
      source: scriptedSource([payload(tree.url, {})]),
      sink,
      commit: 'c0ffee',
    })
    recorder.runStart()
    recorder.noteRead('/before-any-test')
    recorder.testStart('reads', null)
    recorder.noteRead('/during-test')
    recorder.noteReadDir('/listed-dir')
    recorder.testEnd('reads', 'passed')
    recorder.noteRead('/between-tests')
    recorder.runEnd()

    const testRecord = summarizeShard(parseShard(sink.text, 'reads')).tests[0]
    assert.deepEqual(testRecord?.reads, ['/during-test'])
    assert.deepEqual(testRecord?.dirReads, ['/listed-dir'])
  } finally {
    tree.cleanup()
  }
})

test('reads during a spec scope are recorded as a loadReads record', () => {
  const tree = makeTree()
  try {
    const sink = new StringSink()
    const recorder = new Recorder({
      source: scriptedSource([payload(tree.url, {})]),
      sink,
      commit: 'c0ffee',
    })
    recorder.runStart()
    recorder.specStart('/repo/tests/a.spec.ts')
    recorder.noteRead('/repo/src/a.ts')
    recorder.noteReadDir('/repo/src')
    recorder.testStart('a', '/repo/tests/a.spec.ts')
    recorder.testEnd('a', 'passed')
    recorder.runEnd()

    const records = parseShard(sink.text, 'spec')
    const load = records.find((record) => record.type === 'loadReads')
    assert.deepEqual(load, {
      type: 'loadReads',
      file: '/repo/tests/a.spec.ts',
      reads: ['/repo/src/a.ts'],
      dirReads: ['/repo/src'],
    })
    // The import read is not charged to the first test window as well.
    assert.equal(summarizeShard(records).tests[0]?.reads, undefined)
  } finally {
    tree.cleanup()
  }
})

test('an abandoned window is not recorded and does not leak its reads', () => {
  const tree = makeTree()
  try {
    const sink = new StringSink()
    const recorder = new Recorder({
      source: scriptedSource([payload(tree.url, {})]),
      sink,
      commit: 'c0ffee',
    })
    recorder.runStart()
    // A runner announced a test and then skipped it (Jest's selection pattern does
    // exactly this): nothing should reach the shard for it.
    recorder.testStart('filtered', null)
    recorder.noteRead('/from-the-filtered-test')
    recorder.testAbandon()
    recorder.testStart('ran', null)
    recorder.testEnd('ran', 'passed')
    recorder.runEnd()

    const tests = summarizeShard(parseShard(sink.text, 'abandon')).tests
    assert.deepEqual(tests.map((entry) => entry.title), ['ran'])
    assert.equal(tests[0]?.reads, undefined, 'the abandoned window leaked its reads')
  } finally {
    tree.cleanup()
  }
})

test('the record API reaches the open window, and nothing outside it', () => {
  const tree = makeTree()
  try {
    const sink = new StringSink()
    const recorder = new Recorder({
      source: scriptedSource([payload(tree.url, {})]),
      sink,
      commit: 'c0ffee',
    })
    const endsWith = (suffix: string) => (path: string): boolean => path.endsWith(suffix)

    recorder.runStart()
    recordRead('before-the-window.txt')
    recorder.testStart('declares', null)
    recordRead('relative/read.txt')
    recordDirRead('relative/dir')
    recordDependency(['dep/one.ts', 'dep/two.ts'])
    recordOpaque('spawns a tool')
    recorder.testEnd('declares', 'passed')
    // The window's sink is released with it: a helper running between tests must
    // not charge its work to the test that just ended (it goes to the shard-wide
    // out-of-window scope instead).
    recordRead('after-the-window.txt')
    recordOpaque('after')
    recorder.runEnd()

    const testRecord = summarizeShard(parseShard(sink.text, 'declares')).tests[0]
    assert.equal(testRecord?.reads?.length, 3)
    assert.equal(testRecord?.reads?.some(endsWith('relative/read.txt')), true)
    assert.equal(testRecord?.reads?.some(endsWith('before-the-window.txt')), false)
    assert.equal(testRecord?.reads?.some(endsWith('after-the-window.txt')), false)
    // A declared dependency is a read: the map treats both as "this test needs it".
    assert.equal(testRecord?.reads?.some(endsWith('dep/one.ts')), true)
    assert.equal(testRecord?.reads?.some(endsWith('dep/two.ts')), true)
    assert.equal(testRecord?.dirReads?.some(endsWith('relative/dir')), true)
    assert.deepEqual(testRecord?.opaque, ['spawns a tool'])
  } finally {
    tree.cleanup()
  }
})

test('record calls between tests and after the last test reach the whole shard', () => {
  const tree = makeTree()
  try {
    const sink = new StringSink()
    const recorder = new Recorder({
      source: scriptedSource([payload(tree.url, {})]),
      sink,
      commit: 'c0ffee',
    })
    recorder.runStart()
    recorder.testStart('first', null)
    recorder.testEnd('first', 'passed')
    // A hook between tests: no window is open, but the declaration is real.
    recordRead('between/read.txt')
    recordDirRead('between/dir')
    recordEnv('BETWEEN_FLAG')
    recordOpaque('between opaque')
    recorder.testStart('second', null)
    recorder.testEnd('second', 'passed')
    // A hook after the last test, before the run is closed.
    recordDependency(['after/dep.ts'])
    recordEnv('AFTER_FLAG')
    recorder.runEnd()

    const records = parseShard(sink.text, 'outside')
    const loads = records.filter((record) => record.type === 'loadReads')
    assert.equal(loads.length, 2, 'one record per out-of-window scope')
    const [between, after] = loads
    assert.equal(between?.file, null, 'no test to name: the whole shard')
    assert.equal(between?.reads?.some((p) => p.endsWith('between/read.txt')), true)
    assert.equal(between?.dirReads?.some((p) => p.endsWith('between/dir')), true)
    assert.deepEqual(Object.keys(between?.env ?? {}), ['BETWEEN_FLAG'])
    assert.deepEqual(between?.opaque, ['between opaque'])
    assert.equal(after?.reads?.some((p) => p.endsWith('after/dep.ts')), true)
    assert.deepEqual(Object.keys(after?.env ?? {}), ['AFTER_FLAG'])
    // Not charged to the test windows either side.
    for (const entry of summarizeShard(records).tests) {
      assert.equal(entry.reads, undefined)
      assert.equal(entry.opaque, undefined)
    }
  } finally {
    tree.cleanup()
  }
})

test('each window lands in the bucket it belongs to', async () => {
  const tree = makeTree()
  try {
    const source = scriptedSource([
      // runStart takes nothing: importing the test files is what produces the
      // load activity, and that has already happened by the time it is called.
      payload(tree.url, { alpha: 1 }), // testStart A -> @load (the import window)
      payload(tree.url, { alpha: 1 }), // testEnd A   -> A's window
      payload(tree.url, { gamma: 1 }), // testStart B -> the gap, @between
      payload(tree.url, { beta: 1 }), // testEnd B   -> B's window
      payload(tree.url, {}), // runEnd      -> empty
    ])
    const sink = new StringSink()
    const recorder = new Recorder({
      source,
      sink,
      commit: 'c0ffee',
      scan: { projection: [{ from: tree.outDir, to: tree.root }] },
      pid: 42,
      now: (() => {
        let t = 0
        return () => (t += 10)
      })(),
    })

    recorder.runStart()
    recorder.testStart('alpha runs', null)
    recorder.testEnd('alpha runs', 'passed')
    recorder.testStart('beta runs', null)
    recorder.testEnd('beta runs', 'passed')
    recorder.runEnd()

    const summary = summarizeShard(run(tree, sink.text))
    assert.equal(summary.header.commit, 'c0ffee')
    assert.equal(summary.header.pid, 42)
    // The recorder stores raw ranges now; naming them is the build's job. The
    // offset is the identity, so that is what these assert.
    assert.deepEqual(
      summary.tests.map((t) => [t.title, t.status, startsOf(t.touches)]),
      [
        ['alpha runs', 'passed', [rangeOf('alpha')[0]]],
        ['beta runs', 'passed', [rangeOf('beta')[0]]],
      ],
    )
    assert.deepEqual(summary.load.flatMap(startsOf), [rangeOf('alpha')[0]])
    assert.deepEqual(summary.between.flatMap(startsOf), [rangeOf('gamma')[0]])
  } finally {
    tree.cleanup()
  }
})

test('group granularity takes one window per group and shares it', () => {
  const tree = makeTree()
  try {
    const source = scriptedSource([
      payload(tree.url, { alpha: 1 }), // testStart A -> @load
      payload(tree.url, { beta: 1 }), // groupEnd -> A and B
      payload(tree.url, { gamma: 1 }), // groupEnd -> C
      payload(tree.url, {}), // runEnd -> @teardown
    ])
    let takes = 0
    const take = source.takeSync
    source.takeSync = () => {
      takes += 1
      return take()
    }

    const sink = new StringSink()
    const recorder = new Recorder({
      source,
      sink,
      commit: 'c0ffee',
      granularity: 'group',
      scan: { projection: [{ from: tree.outDir, to: tree.root }] },
    })

    recorder.runStart()
    recorder.testStart('alpha runs', null)
    recorder.testEnd('alpha runs', 'passed')
    recorder.testStart('beta runs', null)
    recorder.testEnd('beta runs', 'passed')
    recorder.groupEnd()
    recorder.testStart('gamma runs', null)
    recorder.testEnd('gamma runs', 'passed')
    recorder.groupEnd()
    recorder.runEnd()

    const records = run(tree, sink.text)
    // The load window, one take per group, and the teardown tail. Nothing at the
    // test boundaries, which is the whole reason for the mode.
    assert.equal(takes, 4)
    assert.equal(records.filter((record) => record.type === 'group').length, 2)
    assert.equal(records.filter((record) => record.type === 'test').length, 0)

    const summary = summarizeShard(records)
    assert.deepEqual(
      summary.tests.map((test) => [test.title, startsOf(test.touches)]),
      [
        ['alpha runs', [rangeOf('beta')[0]]],
        ['beta runs', [rangeOf('beta')[0]]],
        ['gamma runs', [rangeOf('gamma')[0]]],
      ],
    )
    assert.deepEqual(summary.between, [], 'the gap is not a bucket in group mode')
    assert.deepEqual(summary.load.flatMap(startsOf), [rangeOf('alpha')[0]])
  } finally {
    tree.cleanup()
  }
})

test('a group with no boundary flushes into one window at the end', () => {
  const tree = makeTree()
  try {
    // An adapter that never reports a group boundary: without a take at the test
    // boundary either, the run's tests share the window that `runEnd` flushes.
    // Over-selection, never a dropped test.
    const source = scriptedSource([
      payload(tree.url, { alpha: 1 }), // testStart A -> @load
      payload(tree.url, { beta: 1 }), // runEnd flush -> A and B
      payload(tree.url, {}), // @teardown
    ])
    let takes = 0
    const take = source.takeSync
    source.takeSync = () => {
      takes += 1
      return take()
    }

    const sink = new StringSink()
    const recorder = new Recorder({ source, sink, commit: 'c0ffee', granularity: 'group' })
    recorder.runStart()
    recorder.testStart('alpha runs', null)
    recorder.testEnd('alpha runs', 'passed')
    recorder.testStart('beta runs', null)
    recorder.testEnd('beta runs', 'passed')
    recorder.runEnd()

    assert.equal(takes, 3)
    const summary = summarizeShard(run(tree, sink.text))
    assert.deepEqual(
      summary.tests.map((test) => [test.title, startsOf(test.touches)]),
      [
        ['alpha runs', [rangeOf('beta')[0]]],
        ['beta runs', [rangeOf('beta')[0]]],
      ],
    )
  } finally {
    tree.cleanup()
  }
})

test('the end record counts the tests that were recorded', async () => {
  const tree = makeTree()
  try {
    const source = scriptedSource([payload(tree.url, {}), payload(tree.url, {})])
    const sink = new StringSink()
    const recorder = new Recorder({
      source,
      sink,
      commit: 'abc',
      scan: { projection: [{ from: tree.outDir, to: tree.root }] },
    })
    recorder.runStart()
    recorder.testStart('one', null)
    recorder.testEnd('one', 'passed')
    recorder.testStart('two', null)
    recorder.testEnd('two', 'passed')
    recorder.runEnd()

    const footer = parseShard(sink.text).at(-1)
    assert.equal(footer?.type, 'end')
    assert.equal(footer?.type === 'end' ? footer.tests : null, 2)
  } finally {
    tree.cleanup()
  }
})

test('a failed test is still recorded, and says so', async () => {
  const tree = makeTree()
  try {
    const source = scriptedSource([payload(tree.url, {}), payload(tree.url, {}), payload(tree.url, { beta: 1 })])
    const sink = new StringSink()
    const recorder = new Recorder({
      source,
      sink,
      commit: 'abc',
      scan: { projection: [{ from: tree.outDir, to: tree.root }] },
    })
    recorder.runStart()
    recorder.testStart('breaks', null)
    recorder.testEnd('breaks', 'failed')
    recorder.runEnd()

    const [recorded] = summarizeShard(parseShard(sink.text)).tests
    assert.equal(recorded?.status, 'failed')
  } finally {
    tree.cleanup()
  }
})

// japa emits an end for a skipped test but the body never runs, so its window is
// empty. Recording it as 'skipped' is what lets the map builder drop it.
test('a skipped test is recorded with an empty window', async () => {
  const tree = makeTree()
  try {
    const source = scriptedSource([payload(tree.url, {}), payload(tree.url, {}), payload(tree.url, {})])
    const sink = new StringSink()
    const recorder = new Recorder({
      source,
      sink,
      commit: 'abc',
      scan: { projection: [{ from: tree.outDir, to: tree.root }] },
    })
    recorder.runStart()
    recorder.testStart('never runs', null)
    recorder.testEnd('never runs', 'skipped')
    recorder.runEnd()

    const [recorded] = summarizeShard(parseShard(sink.text)).tests
    assert.equal(recorded?.status, 'skipped')
    assert.deepEqual(recorded?.touches, {})
  } finally {
    tree.cleanup()
  }
})

test('an end with no matching start is still recorded rather than dropped', async () => {
  const tree = makeTree()
  try {
    const source = scriptedSource([payload(tree.url, {}), payload(tree.url, {})])
    const sink = new StringSink()
    const recorder = new Recorder({
      source,
      sink,
      commit: 'abc',
      scan: { projection: [{ from: tree.outDir, to: tree.root }] },
    })
    recorder.runStart()
    recorder.testEnd('orphan', 'passed')
    recorder.runEnd()

    const [recorded] = summarizeShard(parseShard(sink.text)).tests
    assert.equal(recorded?.title, 'orphan')
    assert.equal(recorded?.durationMs, 0)
  } finally {
    tree.cleanup()
  }
})

test('empty buckets are not written, so a long run does not bloat its shard', async () => {
  const tree = makeTree()
  try {
    const source = scriptedSource([payload(tree.url, {})])
    const sink = new StringSink()
    const recorder = new Recorder({
      source,
      sink,
      commit: 'abc',
      scan: { projection: [{ from: tree.outDir, to: tree.root }] },
    })
    recorder.runStart()
    recorder.testStart('a', null)
    recorder.testEnd('a', 'passed')
    recorder.runEnd()

    const types = parseShard(sink.text).map((r) => r.type)
    assert.deepEqual(types, ['shard', 'test', 'end'])
  } finally {
    tree.cleanup()
  }
})

test('a source that throws costs its window, not the run', async () => {
  const broken: Source = {
    kind: 'broken',
    supportsSync: true,
    takeSync: () => {
      throw new Error('session is not connected')
    },
    take: async () => {
      throw new Error('session is not connected')
    },
    scripts: () => new Map(),
    close: () => {},
  }
  const sink = new StringSink()
  const recorder = new Recorder({ source: broken, sink, commit: 'abc' })
  recorder.runStart()
  recorder.testStart('a', null)
  recorder.testEnd('a', 'passed')
  recorder.runEnd()

  const records = parseShard(sink.text)
  // The window is empty, not absent, so the run keeps going — but it is counted.
  // An empty window under-selects for that test, and a silently well-formed shard
  // would make the resulting map look trustworthy.
  assert.deepEqual(
    records.map((r) => r.type),
    ['shard', 'test', 'health', 'end'],
  )
  const health = records.find((record) => record.type === 'health')
  assert.equal(health?.type, 'health')
  assert.ok(
    health?.type === 'health' && (health.failedTakes ?? 0) > 0,
    'a lost window must be counted',
  )
})

test('generated text the source could not produce is written as health', () => {
  const source: Source = {
    kind: 'fake',
    supportsSync: true,
    takeSync: () => [],
    take: async () => [],
    scripts: () => new Map(),
    // What a socket source reports after a failed end-of-run `generated` fetch.
    generatedMissing: () => ['7'],
    close: () => {},
  }
  const sink = new StringSink()
  const recorder = new Recorder({ source, sink, commit: 'abc' })
  recorder.runStart()
  recorder.runEnd()

  const records = parseShard(sink.text)
  assert.deepEqual(
    records.map((record) => record.type),
    ['shard', 'health', 'end'],
  )
  const health = records.find((record) => record.type === 'health')
  assert.deepEqual(health?.type === 'health' ? health.generatedMissing : undefined, ['7'])
})

test('a clean run writes no health record', () => {
  const source: Source = {
    kind: 'clean',
    supportsSync: true,
    takeSync: () => [],
    take: async () => [],
    scripts: () => new Map(),
    generatedMissing: () => [],
    close: () => {},
  }
  const sink = new StringSink()
  const recorder = new Recorder({ source, sink, commit: 'abc' })
  recorder.runStart()
  recorder.runEnd()
  assert.deepEqual(
    parseShard(sink.text).map((record) => record.type),
    ['shard', 'end'],
  )
})

// ---------------------------------------------------------------------------
// Request-id correlation: a boundary can belong to more than one test
// ---------------------------------------------------------------------------

/**
 * A queued source whose replies carry the tags a correlated service produces.
 *
 * This is the shape `socketSource().settleTagged()` returns: the ordinary window,
 * the ids in flight for it, and the request-boundary windows the service took on
 * its own account. The recorder's job is to turn those tags into ordinary `test`
 * records, so `buildMap` needs no correlation concept at all.
 */
function taggedSource(
  captures: Array<{
    coverage: V8ScriptCoverage[]
    ids: string[]
    requests: Array<{ ids: string[]; coverage: V8ScriptCoverage[] }>
    reads?: string[]
    dirReads?: string[]
  }>,
): QueuedSource {
  let index = 0
  return {
    kind: 'scripted-tagged',
    supportsSync: false,
    pid: 4242,
    takeSync: () => {
      throw new Error('this source cannot take synchronously')
    },
    take: async () => [],
    dispatch(): PendingTake {
      const seq = index
      const capture = captures[Math.min(index, captures.length - 1)] ?? {
        coverage: [],
        ids: [],
        requests: [],
      }
      index += 1
      return {
        seq,
        settle: () => Promise.resolve(capture.coverage),
        settleTagged: () => Promise.resolve(capture),
      }
    },
    drift: () => ({ windows: 0, maxUs: 0, meanUs: 0, maxDepth: 0, minGapUs: 0 }),
    scripts: () => new Map<string, ScriptInfo>(),
    close: () => {},
  }
}

test('a request window is recorded as the test that sent it, even at another test’s boundary', async () => {
  const tree = makeTree()
  try {
    const source = taggedSource([
      // testStart A -> @load
      { coverage: [], ids: [], requests: [] },
      // testEnd A: the service finished A's request and took its delta; A itself
      // ran nothing else in its own window.
      {
        coverage: [],
        ids: [],
        requests: [{ ids: ['id-a'], coverage: payload(tree.url, { beta: 1 }) }],
      },
      // testStart B -> @between
      { coverage: [], ids: [], requests: [] },
      // testEnd B: B's own window, with A's request still in flight. The service's
      // ordinary take carried that id, so A is credited with it too.
      { coverage: payload(tree.url, { gamma: 1 }), ids: ['id-a'], requests: [] },
      // runEnd -> @teardown, carrying a window nobody owns: @between.
      {
        coverage: [],
        ids: [],
        requests: [{ ids: ['not-a-test-in-this-run'], coverage: payload(tree.url, { alpha: 1 }) }],
      },
    ])
    const sink = new StringSink()
    const recorder = new Recorder({
      source,
      sink,
      commit: 'c0ffee',
      scan: { projection: [{ from: tree.outDir, to: tree.root }] },
      owners: {
        ownerOf: (id) => (id === 'id-a' ? { title: 'a', file: null } : undefined),
      },
    })

    recorder.runStart()
    recorder.testStart('a', null)
    recorder.testEnd('a', 'passed')
    recorder.testStart('b', null)
    recorder.testEnd('b', 'passed')
    recorder.runEnd()
    await recorder.drained()

    const summary = summarizeShard(parseShard(sink.text))
    const a = summary.tests.filter((record) => record.title === 'a')
    assert.equal(
      a.length,
      3,
      'A has its own window, the request window the service attributed to it, and B’s take that still saw it in flight',
    )
    assert.ok(a.some((record) => holds(record.touches, 'beta')))
    assert.ok(
      a.some((record) => holds(record.touches, 'gamma')),
      'the in-flight id on B’s take credits A with the work too',
    )
    assert.ok(
      summary.tests
        .filter((record) => record.title === 'b')
        .every((record) => !holds(record.touches, 'beta')),
      'B must not own the request A sent',
    )
    assert.ok(
      summary.between.some((touch) => holds(touch, 'alpha')),
      'an id no test owns is @between, which escalates rather than vanishing',
    )
  } finally {
    tree.cleanup()
  }
})

// ---------------------------------------------------------------------------
// The deferred half: a source whose window cannot be read when it closes
// ---------------------------------------------------------------------------

/**
 * The same scripted payloads, handed over a boundary that cannot answer in the
 * tick it is crossed.
 *
 * The delay is what makes this a test of waiting rather than of a promise that
 * happened to be resolved already. `dispatched` is incremented synchronously, and
 * that count is itself an assertion: a deferred recorder must cross every boundary
 * at the moment the lifecycle hook calls it, not when its own bookkeeping gets
 * around to it.
 */
function queuedScriptedSource(
  payloads: V8ScriptCoverage[][],
  options: { delayMs?: number; failAt?: number } = {},
): QueuedSource & { dispatched: number } {
  const delayMs = options.delayMs ?? 1
  let index = 0
  const next = (): V8ScriptCoverage[] => {
    const value = payloads[Math.min(index, payloads.length - 1)] ?? []
    index += 1
    return value
  }

  const source = {
    kind: 'scripted-queued',
    supportsSync: false,
    pid: 4242,
    dispatched: 0,
    takeSync: (): V8ScriptCoverage[] => {
      throw new Error('this source cannot take synchronously')
    },
    take: async (): Promise<V8ScriptCoverage[]> => next(),
    dispatch(): PendingTake {
      const seq = source.dispatched
      source.dispatched += 1
      return {
        seq,
        settle: () =>
          new Promise<V8ScriptCoverage[]>((resolve, reject) => {
            setTimeout(() => {
              if (options.failAt === seq) reject(new Error('the instrument socket closed'))
              else resolve(next())
            }, delayMs)
          }),
      }
    },
    // Live rather than a constant, so that a footer built too early is caught by
    // counting rather than by luck: a snapshot taken in `runEnd` would be short by
    // the teardown boundary `runEnd` itself just sent.
    drift: () => ({ windows: source.dispatched, maxUs: 0, meanUs: 0, maxDepth: 1, minGapUs: 0 }),
    scripts: () => new Map<string, ScriptInfo>(),
    close: () => {},
  }
  return source
}

/** The same run, driven through whichever recorder the source selects. */
function driveRecorder(tree: Tree, source: Source): StringSink {
  const sink = new StringSink()
  const recorder = new Recorder({
    source,
    sink,
    commit: 'c0ffee',
    scan: { projection: [{ from: tree.outDir, to: tree.root }] },
    pid: 42,
    now: (() => {
      let t = 0
      return () => (t += 10)
    })(),
  })

  recorder.runStart()
  recorder.testStart('alpha runs', null)
  recorder.testEnd('alpha runs', 'passed')
  recorder.testStart('beta runs', null)
  recorder.testEnd('beta runs', 'passed')
  recorder.runEnd()
  return sink
}

/** The payload sequence both recorders are driven with, in boundary order. */
function sequence(url: string): V8ScriptCoverage[][] {
  return [
    payload(url, { alpha: 1 }), // testStart A -> @load
    payload(url, { alpha: 1 }), // testEnd A
    payload(url, { gamma: 1 }), // testStart B -> @between
    payload(url, { beta: 1 }), // testEnd B
    payload(url, {}), // runEnd -> @teardown, empty
  ]
}

/**
 * The extraction's evidence, and the reason it is a byte comparison rather than a
 * handful of assertions: `@load`, `@between` and `@teardown` are decided by a single
 * boolean with three call sites, and a deferred copy that drifted on any one of them
 * would misfile an entire import phase — which escalates every file rather than
 * under-selecting, so it would look like a conservatism bug rather than a
 * bookkeeping one. Identical output from identical input is the strongest thing
 * that can be said about two recorders sharing one set of rules.
 */
test('a deferred recorder writes exactly what the synchronous one does', async () => {
  const tree = makeTree()
  try {
    const sync = driveRecorder(tree, scriptedSource(sequence(tree.url)))
    const queued = driveRecorder(tree, queuedScriptedSource(sequence(tree.url)))
    // Read after the drain, which is the whole difference between them.
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 25))

    // **Every record but the footer, byte for byte**, and the exception is named
    // rather than waved at. The footer carries the run's boundary drift, which is a
    // fact about the *transport* — a synchronous source answers in the tick it is
    // asked and has no boundary to miss, so it reports none. Stripping it leaves the
    // claim this test was written to make exactly as strong as it was: identical
    // input, identical bookkeeping, whichever strategy the source selects.
    const withoutDrift = (text: string): string => text.replace(/,"drift":\{[^}]*\}/g, '')
    assert.equal(withoutDrift(queued.text), sync.text)
    assert.ok(queued.text.includes('"drift"'), 'the queued run reported no drift at all')
    assert.ok(!sync.text.includes('"drift"'), 'a synchronous source has no boundary to miss')
  } finally {
    tree.cleanup()
  }
})

test('every boundary is crossed when the hook calls it, not when the reply lands', async () => {
  const tree = makeTree()
  try {
    const source = queuedScriptedSource(sequence(tree.url), { delayMs: 5 })
    const sink = driveRecorder(tree, source)

    // Five boundaries, five dispatches, and all of them already sent: the whole
    // run is over and nothing has waited. A recorder that awaited inside a
    // boundary would have sent two by now and be stuck on the third.
    assert.equal(source.dispatched, 5)
    assert.equal(sink.text, '', 'nothing may be written before the drain')

    await new Promise((resolve) => setTimeout(resolve, 60))
    const records = parseShard(sink.text)
    // Each script/function row is written once, immediately before the first
    // window that reports it, so the table interleaves with the windows.
    assert.deepEqual(records.map((r) => r.type), [
      'shard',
      'script',
      'function',
      'load',
      'test',
      'function',
      'between',
      'function',
      'test',
      'end',
    ])
  } finally {
    tree.cleanup()
  }
})

test('the drain resolves only once the footer has been written', async () => {
  const tree = makeTree()
  try {
    const source = queuedScriptedSource(sequence(tree.url), { delayMs: 5 })
    const sink = new StringSink()
    const recorder = new Recorder({
      source,
      sink,
      commit: 'abc',
      scan: { projection: [{ from: tree.outDir, to: tree.root }] },
    })
    recorder.runStart()
    recorder.testStart('a', null)
    recorder.testEnd('a', 'passed')
    recorder.runEnd()

    // Not yet — the footer cannot precede the windows it follows, and reading the
    // shard here finds exactly the state an unawaited drain leaves behind, which
    // `parseShard` refuses as an interrupted run.
    assert.equal(sink.text.includes('"type":"end"'), false, 'the drain has not run yet')

    await recorder.drained()
    assert.equal(parseShard(sink.text).at(-1)?.type, 'end')
    // And it stays resolved, so a second caller does not wait again.
    await recorder.drained()
    assert.equal(parseShard(sink.text).at(-1)?.type, 'end')
  } finally {
    tree.cleanup()
  }
})

/**
 * The footer's drift counts every window, including the one `runEnd` itself sent.
 *
 * Read eagerly in `runEnd` the count would be short by exactly the boundary that call
 * dispatches — the teardown take — because a drift is the distance between a boundary
 * being sent and being received, and that one has not been received yet. One short of
 * five is not a rounding error: it is the number that decides whether the run's windows
 * slid, reported by a run that does not know whether they did.
 */
test('the footer reports the drift of every window, not every window but the last', async () => {
  const tree = makeTree()
  try {
    const source = queuedScriptedSource(sequence(tree.url), { delayMs: 1 })
    const sink = driveRecorder(tree, source)
    await new Promise((resolve) => setTimeout(resolve, 25))

    assert.equal(source.dispatched, 5, 'the fixture no longer takes five windows')
    const footer = parseShard(sink.text).at(-1)
    assert.equal(footer?.type, 'end')
    assert.equal(
      footer?.type === 'end' ? footer.drift?.windows : null,
      source.dispatched,
      'the footer was built before the last window had been read',
    )
  } finally {
    tree.cleanup()
  }
})

/**
 * And a source that cannot miss a boundary reports none.
 *
 * `takeSync` answers in the tick it is asked, so there is no distance between the
 * window the caller meant and the window it got. Writing a zeroed drift there anyway
 * would put a number in the record that means "measured, and it was perfect" where the
 * truth is "not applicable", and the two are read by different code.
 */
test('a synchronous source reports no drift, because it has no boundary to miss', async () => {
  const tree = makeTree()
  try {
    const sink = driveRecorder(tree, scriptedSource(sequence(tree.url)))
    const footer = parseShard(sink.text).at(-1)
    assert.equal(footer?.type, 'end')
    assert.equal(footer?.type === 'end' ? footer.drift : undefined, undefined)
  } finally {
    tree.cleanup()
  }
})

// The socket dies mid-run: some windows are gone and the rest are still real. The
// record has to survive with an empty window, because a lost record is a missing
// test and every file only that test reached would silently escalate.
test('a window that fails is recorded empty rather than dropped', async () => {
  const tree = makeTree()
  try {
    const source = queuedScriptedSource(sequence(tree.url), { delayMs: 1, failAt: 1 })
    const sink = driveRecorder(tree, source)
    await new Promise((resolve) => setTimeout(resolve, 25))

    const records = parseShard(sink.text)
    assert.equal(records.at(-1)?.type, 'end', 'the run must still be complete')
    const tests = summarizeShard(records).tests
    assert.deepEqual(
      tests.map((t) => [t.title, Object.values(t.touches).flat().length]),
      [
        ['alpha runs', 0],
        ['beta runs', 1],
      ],
    )
  } finally {
    tree.cleanup()
  }
})

/**
 * The failure `cbd-a3v.3` was written to prevent, refused at the point where the
 * source is still in hand.
 *
 * A source that can neither take synchronously nor accept a boundary produces
 * empty windows all the way down. Nothing throws, the shard is well-formed, and the
 * map it builds says no test reaches any code — a complete and confident answer
 * that is simply wrong. Refusing to construct the recorder turns that into a
 * message naming the source.
 */
test('a source that can be driven neither way is refused, not recorded as empty', () => {
  const neither: Source = {
    kind: 'take-only',
    supportsSync: false,
    takeSync: () => {
      throw new Error('not synchronous')
    },
    take: async () => [],
    scripts: () => new Map(),
    close: () => {},
  }
  assert.throws(
    () => new Recorder({ source: neither, sink: new StringSink(), commit: 'abc' }),
    /can neither take synchronously nor accept a window boundary/,
  )
})

// `cbd-xnp.2`: identity is the function's range, not its start. Jest's VM wrapper
// and the first function it contains both start at 0; keying by start dropped the
// function.
test('two executed functions that share a start offset keep separate rows', async () => {
  const tree = makeTree()
  try {
    const source = scriptedSource([
      [
        {
          scriptId: '1',
          url: tree.url,
          functions: [
            { functionName: '', isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] },
            { functionName: 'alpha', isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] },
          ],
        },
      ],
    ])
    const sink = new StringSink()
    const recorder = new Recorder({ source, sink, commit: 'c0ffee' })
    recorder.runStart()
    recorder.testStart('a', null)
    recorder.testEnd('a', 'passed')
    recorder.runEnd()
    const records = parseShard(sink.text)
    const rows = records.filter((record) => record.type === 'function')
    assert.deepEqual(
      rows.map((row) => (row.type === 'function' ? [row.start, row.end, row.name] : null)),
      [
        [0, 100, ''],
        [0, 10, 'alpha'],
      ],
    )
    const test = records.find((record) => record.type === 'test')
    assert.equal(test?.type === 'test' ? Object.values(test.touches).flat().length : 0, 2)
  } finally {
    tree.cleanup()
  }
})

// `cbd-n9t.1`: a map the file itself declares is recoverable at build time, so the
// shard must not repeat it — tsc's inline maps are tens of KB per script. A map
// only the loader injected has no on-disk comment and must still be recorded.
test('a map the file declares is not repeated in the shard', async () => {
  const tree = makeTree()
  try {
    const row = scriptRow(tree, { url: tree.url, sourceMapURL: 'mod.js.map' }, 'mod.js.map')
    assert.equal(row.type, 'script')
    assert.equal(
      row.type === 'script' ? row.sourceMapURL : 'wrong record',
      undefined,
      'the file declares this map; repeating it duplicates tens of KB',
    )
  } finally {
    tree.cleanup()
  }
})

test('a loader-injected map with no on-disk comment is recorded', async () => {
  const tree = makeTree()
  try {
    const injected = 'data:application/json;base64,AAAA'
    const row = scriptRow(tree, { url: tree.url, sourceMapURL: injected })
    assert.equal(row.type === 'script' ? row.sourceMapURL : undefined, injected)
  } finally {
    tree.cleanup()
  }
})

test('a file-declared map that differs from the reported one keeps the reported one', async () => {
  const tree = makeTree()
  try {
    const row = scriptRow(tree, { url: tree.url, sourceMapURL: 'reported.map' }, 'on-disk.map')
    assert.equal(row.type === 'script' ? row.sourceMapURL : undefined, 'reported.map')
  } finally {
    tree.cleanup()
  }
})

test('a repeated title in one file is recorded with an ordinal', () => {
  const tree = makeTree()
  try {
    const source = scriptedSource([payload(tree.url, { alpha: 1 })])
    const sink = new StringSink()
    const recorder = new Recorder({ source, sink, commit: 'c0ffee' })
    recorder.runStart()
    recorder.testStart('same', null)
    recorder.testEnd('same', 'passed')
    recorder.testStart('same', null)
    recorder.testEnd('same', 'passed')
    recorder.runEnd()

    const tests = parseShard(sink.text).filter(
      (record): record is Extract<ShardRecord, { type: 'test' }> => record.type === 'test',
    )
    assert.deepEqual(
      tests.map((entry) => entry.ordinal),
      [undefined, 1],
    )
  } finally {
    tree.cleanup()
  }
})

// A source that swallows a per-target failure keeps the surviving targets' coverage
// but has no rejection left for the recorder to count. The count has to travel by
// its own route, or the shard looks healthy while a window is missing.
test('a source that counts its own lost windows reports them as unhealthy', () => {
  const source: Source = {
    kind: 'swallowing',
    supportsSync: true,
    takeSync: () => [],
    take: async () => [],
    scripts: () => new Map(),
    lostTakes: () => 2,
    close: () => {},
  }
  const sink = new StringSink()
  const recorder = new Recorder({ source, sink, commit: 'abc' })
  recorder.runStart()
  recorder.testStart('a', null)
  recorder.testEnd('a', 'passed')
  recorder.runEnd()

  const health = parseShard(sink.text).find((record) => record.type === 'health')
  assert.ok(health?.type === 'health')
  assert.equal(health?.type === 'health' ? health.failedTakes : undefined, 2)
})

// A Recorder driven through two runs must not carry the first run's bookkeeping:
// its test count, its ordinals, its load phase or its failure count.
test('a second run on one recorder starts from zero', () => {
  const source: Source = {
    kind: 'clean',
    supportsSync: true,
    takeSync: () => [],
    take: async () => [],
    scripts: () => new Map(),
    close: () => {},
  }
  const sink = new StringSink()
  const recorder = new Recorder({ source, sink, commit: 'abc' })

  recorder.runStart()
  recorder.testStart('a', null)
  recorder.testEnd('a', 'passed')
  recorder.runEnd()

  recorder.runStart()
  recorder.testStart('b', null)
  recorder.testEnd('b', 'passed')
  recorder.runEnd()

  // `runStart` resets the sink, so the shard is the second run alone.
  const records = parseShard(sink.text)
  assert.equal(records.filter((record) => record.type === 'shard').length, 1)
  const footer = records.find((record) => record.type === 'end')
  assert.equal(footer?.type === 'end' ? footer.tests : undefined, 1)
})

// `recordEnv` names the variables a test consults. The shard keeps a hash of the
// value the window saw — never the value itself — so a changed flag selects the
// declaring test without a file change and without a coverage edge.
test('a declared environment variable is recorded as a hash, never a value', () => {
  const source: Source = {
    kind: 'clean',
    supportsSync: true,
    takeSync: () => [],
    take: async () => [],
    scripts: () => new Map(),
    close: () => {},
  }
  const sink = new StringSink()
  const recorder = new Recorder({ source, sink, commit: 'env' })
  const previous = process.env.CBD_TEST_FLAG
  try {
    process.env.CBD_TEST_FLAG = 'secret-value'
    recorder.runStart()
    recorder.testStart('declares a flag', null)
    recordEnv('CBD_TEST_FLAG')
    recorder.testEnd('declares a flag', 'passed')
    recorder.runEnd()

    const record = parseShard(sink.text).find(
      (value) => value.type === 'test' && value.title === 'declares a flag',
    )
    assert.ok(record?.type === 'test')
    const hashes = record.env
    assert.ok(hashes !== undefined)
    assert.deepEqual(Object.keys(hashes), ['CBD_TEST_FLAG'])
    assert.match(hashes.CBD_TEST_FLAG as string, /^[0-9a-f]{16}$/)
    assert.doesNotMatch(sink.text, /secret-value/)
  } finally {
    if (previous === undefined) delete process.env.CBD_TEST_FLAG
    else process.env.CBD_TEST_FLAG = previous
  }
})

// A `recordEnv` call in a spec's import phase (a module-level read, a hook that runs
// before the first test window) has no open test. It used to reach no recorder at
// all and was dropped without a word; it is now filed with the spec scope, like the
// import-phase reads, and the build attributes it to the spec's tests.
test('a variable declared during the spec import phase is recorded with the spec scope', () => {
  const source: Source = {
    kind: 'clean',
    supportsSync: true,
    takeSync: () => [],
    take: async () => [],
    scripts: () => new Map(),
    close: () => {},
  }
  const sink = new StringSink()
  const recorder = new Recorder({ source, sink, commit: 'env' })
  const previous = process.env.CBD_TEST_SPEC_FLAG
  try {
    process.env.CBD_TEST_SPEC_FLAG = 'secret-value'
    recorder.runStart()
    recorder.specStart('/repo/tests/a.spec.ts')
    recordEnv('CBD_TEST_SPEC_FLAG')
    recorder.testStart('a', '/repo/tests/a.spec.ts')
    recorder.testEnd('a', 'passed')
    recorder.runEnd()

    const load = parseShard(sink.text).find((value) => value.type === 'loadReads')
    assert.ok(load?.type === 'loadReads')
    assert.deepEqual(Object.keys(load.env ?? {}), ['CBD_TEST_SPEC_FLAG'])
    assert.doesNotMatch(sink.text, /secret-value/)
  } finally {
    if (previous === undefined) delete process.env.CBD_TEST_SPEC_FLAG
    else process.env.CBD_TEST_SPEC_FLAG = previous
  }
})

test('a service read taken in the load, between and teardown windows is recorded, not dropped', async () => {
  const source = taggedSource([
    { coverage: [], ids: [], requests: [], reads: ['/svc/startup.json'] },
    { coverage: [], ids: [], requests: [] },
    { coverage: [], ids: [], requests: [], reads: ['/svc/between.json'], dirReads: ['/svc/dir'] },
    { coverage: [], ids: [], requests: [] },
    { coverage: [], ids: [], requests: [], reads: ['/svc/teardown.json'] },
  ])
  const sink = new StringSink()
  const recorder = new Recorder({ source, sink, commit: 'c0ffee' })
  recorder.runStart()
  recorder.testStart('a', null)
  recorder.testEnd('a', 'passed')
  recorder.testStart('b', null)
  recorder.testEnd('b', 'passed')
  recorder.runEnd()
  await recorder.drained()

  const { loadReads } = summarizeShard(parseShard(sink.text))
  assert.deepEqual(
    loadReads.flatMap((record) => record.reads ?? []).sort(),
    ['/svc/between.json', '/svc/startup.json', '/svc/teardown.json'],
  )
  assert.deepEqual(
    loadReads.flatMap((record) => record.dirReads ?? []),
    ['/svc/dir'],
  )
})
