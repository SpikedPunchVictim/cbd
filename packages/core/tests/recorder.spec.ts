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
import { parseShard, StringSink, summarizeShard } from '../src/shard.js'
import type { ShardRecord } from '../src/shard.js'
import type { Source, V8Function, V8ScriptCoverage } from '../src/types.js'

const MODULE = [
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

/** Hands out one payload per take, then repeats the last one. */
function scriptedSource(payloads: V8ScriptCoverage[][]): Source {
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
    scripts: () => new Map(),
    close: () => {},
  }
}

function run(tree: Tree, records: string): ShardRecord[] {
  return parseShard(records)
}

test('each window lands in the bucket it belongs to', () => {
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
    assert.deepEqual(
      summary.tests.map((t) => [t.title, t.status, t.touches.map((x) => x[1])]),
      [
        ['alpha runs', 'passed', ['alpha@0']],
        ['beta runs', 'passed', ['beta@0']],
      ],
    )
    assert.deepEqual(
      summary.load.map((r) => r[1]),
      ['alpha@0'],
    )
    assert.deepEqual(
      summary.between.map((r) => r[1]),
      ['gamma@0'],
    )
  } finally {
    tree.cleanup()
  }
})

test('the end record counts the tests that were recorded', () => {
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

test('a failed test is still recorded, and says so', () => {
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
test('a skipped test is recorded with an empty window', () => {
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
    assert.deepEqual(recorded?.touches, [])
  } finally {
    tree.cleanup()
  }
})

test('an end with no matching start is still recorded rather than dropped', () => {
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

test('empty buckets are not written, so a long run does not bloat its shard', () => {
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

test('a source that throws costs its window, not the run', () => {
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
  assert.deepEqual(
    records.map((r) => r.type),
    ['shard', 'test', 'end'],
  )
})
