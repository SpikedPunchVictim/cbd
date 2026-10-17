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
    assert.deepEqual(
      records.map((r) => r.type),
      ['shard', 'load', 'test', 'between', 'test', 'end'],
    )
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
      tests.map((t) => [t.title, t.touches.length]),
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
