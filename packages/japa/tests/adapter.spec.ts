/**
 * Unit tests for the japa adapter.
 *
 * The window boundaries are exercised against a stub recorder rather than a real
 * one, because what is being pinned here is the *contract with japa* — which
 * field the title comes from, which field the file comes from, that nothing is
 * awaited — and a real recorder would blur that with inspector behaviour that
 * `packages/core/tests/recorder-e2e.spec.ts` already covers.
 *
 * The two facts these tests exist to protect are both corrections of earlier
 * beliefs (`.explore/A0-japa-hooks.md` F8 and F10):
 *
 *   - the file comes from `meta.fileName`, which japa sets; and
 *   - a test's identity is its **bare** title, because that is what japa filters
 *     on. Recording the qualified name instead would make every emitted filter
 *     match nothing, and a filter matching nothing is a miss.
 */
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { realpath } from '@spikedpunch/cbd/adapter'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import type { Recorder, TestStatus } from '@spikedpunch/cbd/adapter'
import {
  applyTests,
  installJapaAdapter,
  japaWindowHooks,
  statusOf,
  titlesFor,
  type JapaEmitter,
  type JapaListener,
  type JapaTestEndNode,
} from '../src/adapter.js'
import { cbd, type CbdOptions, type JapaPluginApi } from '../src/plugin.js'

type Call = [string, ...unknown[]]

/**
 * Drive the plugin with a stub API.
 *
 * `cbd()` is typed as japa's own `PluginFn` so that a consumer's
 * `configure({ plugins: [cbd()] })` compiles on every supported japa version
 * (`cbd-amq`). That type wants a real `NormalizedConfig` and `Emitter`; this test
 * deliberately supplies the two fields the adapter reads, so the cast is the test's
 * boundary rather than the plugin's.
 */
function runPlugin(options: CbdOptions, api: JapaPluginApi): Promise<void> {
  return (cbd(options) as unknown as (api: JapaPluginApi) => Promise<void>)(api)
}

/** Runs `body` with `CBD_SELECTION` pointing at a file holding `contents`. */
async function withSelection(
  contents: string,
  body: () => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-select-'))
  writeFileSync(join(dir, 'selection.json'), contents)
  const previous = process.env.CBD_SELECTION
  process.env.CBD_SELECTION = join(dir, 'selection.json')
  try {
    await body()
  } finally {
    if (previous === undefined) delete process.env.CBD_SELECTION
    else process.env.CBD_SELECTION = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * A recorder that records. `as unknown as Recorder` because only six members are
 * used and standing up a real one would need an inspector session.
 */
function stubRecorder(drained?: () => Promise<void>): { recorder: Recorder; calls: Call[] } {
  const calls: Call[] = []
  const recorder = {
    testStart: (title: string, file: string | null = null) => calls.push(['testStart', title, file]),
    testEnd: (title: string, status: TestStatus, durationMs?: number) =>
      calls.push(['testEnd', title, status, durationMs]),
    runEnd: () => calls.push(['runEnd']),
    groupEnd: () => calls.push(['groupEnd']),
    close: () => calls.push(['close']),
    drained:
      drained ??
      (() => {
        calls.push(['drained'])
        return Promise.resolve()
      }),
  } as unknown as Recorder
  return { recorder, calls }
}

function fakeEmitter(): {
  emitter: JapaEmitter
  emit(event: string, node?: unknown): void
} {
  const handlers = new Map<string, JapaListener[]>()
  return {
    emitter: {
      on(event: string, listener: JapaListener): unknown {
        handlers.set(event, [...(handlers.get(event) ?? []), listener])
        return undefined
      },
    },
    emit(event: string, node?: unknown): void {
      for (const listener of handlers.get(event) ?? []) {
        ;(listener as unknown as (n?: unknown) => void)(node)
      }
    },
  }
}

function endNode(overrides: Partial<JapaTestEndNode> = {}): JapaTestEndNode {
  return {
    title: { original: 'a test', expanded: 'a test' },
    meta: { fileName: '/repo/tests/a.spec.js' },
    duration: 12,
    hasError: false,
    ...overrides,
  }
}

test.group('statusOf', () => {
  test('a test that ran and passed is passed', () => {
    assert.equal(statusOf(endNode()), 'passed')
  })

  test('a test that failed is failed', () => {
    assert.equal(statusOf(endNode({ hasError: true })), 'failed')
  })

  // The trap this mapping exists for: japa emits start and end for a skipped test
  // with `hasError: false`, so reading hasError alone files a test that never ran
  // as a passing one holding an empty window.
  test('a skipped test is skipped, not passed', () => {
    assert.equal(statusOf(endNode({ isSkipped: true })), 'skipped')
  })

  test('a todo is skipped, because it has no window either', () => {
    assert.equal(statusOf(endNode({ isTodo: true })), 'skipped')
  })

  test('a skipped test that also reports an error is still skipped', () => {
    assert.equal(statusOf(endNode({ isSkipped: true, hasError: true })), 'skipped')
  })
})

test.group('japaWindowHooks', () => {
  test('the window opens with the bare title and japa-supplied file', () => {
    const { recorder, calls } = stubRecorder()
    japaWindowHooks(recorder).onTestStart({
      // Deliberately different, to pin which field is read. They are equal in
      // japa today; the point is that the adapter must not depend on that.
      title: { original: 'delta', expanded: 'gamma delta' },
      meta: { fileName: '/repo/tests/gamma.spec.js' },
    })
    assert.deepEqual(calls, [['testStart', 'delta', '/repo/tests/gamma.spec.js']])
  })

  test('a window opens on the realpath of a spec reached through a symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-link-'))
    try {
      const real = join(dir, 'real.spec.js')
      writeFileSync(real, '')
      const link = join(dir, 'link.spec.js')
      symlinkSync(real, link)
      const { recorder, calls } = stubRecorder()
      japaWindowHooks(recorder).onTestStart({
        title: { original: 'x', expanded: 'x' },
        meta: { fileName: link },
      })
      assert.deepEqual(calls, [['testStart', 'x', realpath(real)]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a node with no fileName opens a window with a null file', () => {
    const { recorder, calls } = stubRecorder()
    japaWindowHooks(recorder).onTestStart({ title: { original: 'x', expanded: 'x' }, meta: {} })
    assert.deepEqual(calls, [['testStart', 'x', null]])
  })

  test('the window closes with the bare title, status and duration', () => {
    const { recorder, calls } = stubRecorder()
    japaWindowHooks(recorder).onTestEnd(
      endNode({ title: { original: 'delta', expanded: 'gamma delta' }, duration: 7 }),
    )
    assert.deepEqual(calls, [['testEnd', 'delta', 'passed', 7]])
  })

  test('both handlers return undefined, so a caller cannot be tempted to await', () => {
    const { recorder } = stubRecorder()
    const hooks = japaWindowHooks(recorder)
    assert.equal(
      hooks.onTestStart({ title: { original: 'x', expanded: 'x' }, meta: {} }),
      undefined,
    )
    assert.equal(hooks.onTestEnd(endNode()), undefined)
  })
})

test.group('installJapaAdapter', () => {
  test('drives a full window through the emitter', () => {
    const { recorder, calls } = stubRecorder()
    const { emitter, emit } = fakeEmitter()
    installJapaAdapter(emitter, [recorder])

    emit('test:start', { title: { original: 'one', expanded: 'one' }, meta: { fileName: '/a.js' } })
    emit('test:end', endNode({ title: { original: 'one', expanded: 'one' }, duration: 3 }))

    assert.deepEqual(calls, [
      ['testStart', 'one', '/a.js'],
      ['testEnd', 'one', 'passed', 3],
    ])
  })

  test('a group boundary closes the window on every recorder', () => {
    const first = stubRecorder()
    const second = stubRecorder()
    const { emitter, emit } = fakeEmitter()
    installJapaAdapter(emitter, [first.recorder, second.recorder])

    emit('group:end', { title: 'a group' })

    assert.deepEqual(first.calls, [['groupEnd']])
    assert.deepEqual(second.calls, [['groupEnd']])
  })

  test('a recorder that throws at a group boundary does not escape the listener', () => {
    const { recorder } = stubRecorder()
    ;(recorder as unknown as { groupEnd: () => void }).groupEnd = () => {
      throw new Error('ENOSPC')
    }
    const { emitter, emit } = fakeEmitter()
    installJapaAdapter(emitter, [recorder])
    const realWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = (() => true) as typeof process.stderr.write
    try {
      assert.doesNotThrow(() => emit('group:end', { title: 'a group' }))
    } finally {
      process.stderr.write = realWrite
    }
  })

  test('runner:end writes the footer, drains and closes, without an explicit finish call', async () => {
    const { recorder, calls } = stubRecorder()
    const { emitter, emit } = fakeEmitter()
    const installed = installJapaAdapter(emitter, [recorder])
    emit('runner:end')
    await installed.finish()
    assert.deepEqual(calls, [['runEnd'], ['drained'], ['close']])
  })

  test('finish is idempotent, so an explicit call after runner:end is harmless', async () => {
    const { recorder, calls } = stubRecorder()
    const { emitter, emit } = fakeEmitter()
    const installed = installJapaAdapter(emitter, [recorder])
    emit('runner:end')
    await Promise.all([installed.finish(), installed.finish()])
    assert.deepEqual(calls, [['runEnd'], ['drained'], ['close']])
  })

  /**
   * The leak that made closing a bug fix rather than a tidy-up.
   *
   * A socket source holds an open `net.Socket`, and an open socket keeps Node's event
   * loop alive. Measured against a real service in `service-e2e.spec.ts`: the recorded
   * run printed its summary, reported every test green, and then hung until the
   * timeout killed it — while the same entry point with no socket directory exited in
   * 0.06s. Output saying a run succeeded, followed by a CI timeout, is a worse failure
   * than a crash.
   *
   * Closed *after* the drains and never before: a closed source cannot answer, so
   * closing early drops the records still in flight rather than merely tidying up.
   */
  test('a source is closed, and only once the records are in', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { recorder, calls } = stubRecorder(async () => {
      calls.push(['drained'])
      await gate
    })
    const { emitter } = fakeEmitter()
    const installed = installJapaAdapter(emitter, [recorder])

    const finishing = installed.finish()
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(
      calls,
      [['runEnd'], ['drained']],
      'the source was closed while its records were still in flight',
    )

    release()
    await finishing
    assert.deepEqual(calls, [['runEnd'], ['drained'], ['close']])
  })

  /**
   * The deferred recorder's records are written when their replies land, so the
   * footer is not in the shard until `drained()` resolves. A `finish` that returned
   * without waiting would let the process exit on a shard with no footer, and
   * `parseShard` treats that as an interrupted run and refuses it — so the whole
   * recording would be discarded, on a run that had looked fine.
   */
  test('finish waits for the drain before it resolves', async () => {
    const calls: Call[] = []
    let entered: boolean = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { recorder } = stubRecorder(async () => {
      entered = true
      await gate
      calls.push(['drained'])
    })
    const { emitter } = fakeEmitter()
    const installed = installJapaAdapter(emitter, [recorder])

    let settled: boolean = false
    const finishing = installed.finish().then(() => {
      settled = true
    })
    // Give anything that *was* going to resolve eagerly every chance to do so.
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(settled, false, 'finish resolved while records were still in flight')
    assert.equal(entered, true, 'the drain should have been started')

    release()
    await finishing
    // This test's own array, so it holds only what its callback pushed — `runEnd` and
    // `close` go to the stub's. That the source *is* closed is pinned separately, by
    // 'a source is closed, and only once the records are in'.
    assert.deepEqual(calls, [['drained']])
  })

  test('a second finish returns the same promise rather than draining twice', async () => {
    let drains = 0
    const { recorder } = stubRecorder(async () => {
      drains += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    const { emitter } = fakeEmitter()
    const installed = installJapaAdapter(emitter, [recorder])

    await Promise.all([installed.finish(), installed.finish(), installed.finish()])
    assert.equal(drains, 1)
  })

  /**
   * Two recorders, one set of boundaries — which is the whole of `cbd-a3v` in one
   * assertion. The service's window for a test is the interval during which that
   * test was running, and only the test runner knows where those intervals begin and
   * end, so both recorders are driven from the same events rather than the service
   * keeping any clock of its own.
   */
  test('every recorder sees the same boundaries', async () => {
    const mine = stubRecorder()
    const service = stubRecorder()
    const { emitter, emit } = fakeEmitter()
    const installed = installJapaAdapter(emitter, [mine.recorder, service.recorder])

    emit('test:start', { title: { original: 'one', expanded: 'one' }, meta: { fileName: '/a.js' } })
    emit('test:end', endNode({ title: { original: 'one', expanded: 'one' }, duration: 3 }))
    await installed.finish()

    assert.deepEqual(mine.calls, service.calls)
    assert.deepEqual(mine.calls, [
      ['testStart', 'one', '/a.js'],
      ['testEnd', 'one', 'passed', 3],
      ['runEnd'],
      ['drained'],
      ['close'],
    ])
  })

  // The one that a fast recorder must not be able to shortcut. `finish` resolves
  // when *every* drain has, or a shard whose target is slower to answer would be
  // read before it was written.
  test('finish waits for the slowest recorder, not the first', async () => {
    const quick = stubRecorder()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = stubRecorder(() => gate)
    const { emitter } = fakeEmitter()
    const installed = installJapaAdapter(emitter, [quick.recorder, slow.recorder])

    let settled: boolean = false
    const finishing = installed.finish().then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(settled, false, 'the quick recorder drained and finish returned anyway')

    release()
    await finishing
    assert.equal(settled, true)
  })
})

test.group('titlesFor', () => {
  const map = {
    tests: [
      { title: 'alpha', file: '/a.js' },
      { title: 'beta', file: '/b.js' },
      { title: 'gamma', file: '/b.js' },
    ],
  }

  test('resolves indices against the map ordering', () => {
    const titles = titlesFor({ tests: [2, 0] } as never, map as never)
    assert.deepEqual(titles, ['gamma', 'alpha'])
  })

  test('drops an index the map has no entry for rather than emitting undefined', () => {
    const titles = titlesFor({ tests: [1, 99] } as never, map as never)
    assert.deepEqual(titles, ['beta'])
  })

  test('an empty selection yields no titles', () => {
    assert.deepEqual(titlesFor({ tests: [] } as never, map as never), [])
  })
})

test.group('applyTests', () => {
  test('writes the filter into japa config', () => {
    const config = { filters: {} }
    applyTests(config, ['alpha', 'beta'])
    assert.deepEqual(config.filters, { tests: ['alpha', 'beta'] })
  })

  test('copies the list rather than aliasing the caller’s array', () => {
    const config = { filters: {} }
    const titles = ['alpha']
    applyTests(config, titles)
    titles.push('beta')
    assert.deepEqual(config.filters, { tests: ['alpha'] })
  })

  // japa reads an empty filter as "no filter" and runs everything, so an empty
  // list must never be used to mean "run nothing".
  test('refuses an empty list instead of silently running the whole suite', () => {
    assert.throws(() => applyTests({ filters: {} }, []), /empty title list/)
  })
})

test.group('cbd plugin', () => {
  test('applies a selection when given one', async () => {
    const config = { filters: {} }
    const { emitter } = fakeEmitter()
    await runPlugin({ only: ['alpha'] }, { config, emitter })
    assert.deepEqual(config.filters, { tests: ['alpha'] })
  })

  test('touches no filter when no selection is given', async () => {
    const config = { filters: {} }
    const { emitter } = fakeEmitter()
    await runPlugin({}, { config, emitter })
    assert.deepEqual(config.filters, {})
  })

  test('an empty CBD_SHARD is unset, not a path', async () => {
    const previous = process.env.CBD_SHARD
    process.env.CBD_SHARD = ''
    try {
      const config = { filters: {} }
      const { emitter } = fakeEmitter()
      // 0.0.1 opened the empty value as a file path and failed the run.
      await runPlugin({}, { config, emitter })
      assert.deepEqual(config.filters, {})
    } finally {
      if (previous === undefined) delete process.env.CBD_SHARD
      else process.env.CBD_SHARD = previous
    }
  })

  test('an empty CBD_COMMIT is unset, and the shard says unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-empty-commit-'))
    const previous = process.env.CBD_COMMIT
    process.env.CBD_COMMIT = ''
    try {
      const shard = join(dir, 'shard.ndjson')
      const config = { filters: {} }
      const { emitter, emit } = fakeEmitter()
      await runPlugin({ shard }, { config, emitter })
      const header = JSON.parse(readFileSync(shard, 'utf8').split('\n')[0]!) as { commit: string }
      assert.equal(header.commit, 'unknown')
      emit('runner:end')
    } finally {
      if (previous === undefined) delete process.env.CBD_COMMIT
      else process.env.CBD_COMMIT = previous
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('enabled: false is inert, selection included', async () => {
    const config = { filters: {} }
    const { emitter } = fakeEmitter()
    await runPlugin({ enabled: false, only: ['alpha'] }, { config, emitter })
    assert.deepEqual(config.filters, {})
  })

  /**
   * `cbd collect` resolves the selection before it spawns this process and passes
   * it as a file, so the automatic case must work without the consumer passing
   * `only`. The explicit option still wins, and a file that cannot be understood
   * must fail rather than mean "run everything" — that is the safe direction but
   * it is not what the caller asked for.
   */
  test('applies the selection file CBD_SELECTION names when no option is given', async () => {
    await withSelection(JSON.stringify({ titles: ['beta'] }), async () => {
      const config = { filters: {} }
      const { emitter } = fakeEmitter()
      await runPlugin({}, { config, emitter })
      assert.deepEqual(config.filters, { tests: ['beta'] })
    })
  })

  test('an explicit only wins over the environment', async () => {
    await withSelection(JSON.stringify({ titles: ['beta'] }), async () => {
      const config = { filters: {} }
      const { emitter } = fakeEmitter()
      await runPlugin({ only: ['alpha'] }, { config, emitter })
      assert.deepEqual(config.filters, { tests: ['alpha'] })
    })
  })

  test('a malformed selection file is an error, not a full run', async () => {
    await withSelection('{}', async () => {
      const config = { filters: {} }
      const { emitter } = fakeEmitter()
      await assert.rejects(runPlugin({}, { config, emitter }), /must contain/)
    })
  })

  test('records a window end to end when given a shard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-'))
    try {
      const shard = join(dir, 'shard.ndjson')
      const config = { filters: {} }
      const { emitter, emit } = fakeEmitter()

      await runPlugin({ shard, commit: 'deadbeef' }, { config, emitter })

      emit('test:start', {
        title: { original: 'alpha', expanded: 'alpha' },
        meta: { fileName: '/repo/tests/a.spec.js' },
      })
      emit('test:end', endNode({ title: { original: 'alpha', expanded: 'alpha' } }))
      emit('runner:end')

      const records = readFileSync(shard, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { type: string; [key: string]: unknown })

      assert.equal(records.at(0)?.type, 'shard')
      assert.equal(records.at(0)?.commit, 'deadbeef')

      const testRecord = records.find((r) => r.type === 'test')
      assert.equal(testRecord?.title, 'alpha')
      assert.equal(testRecord?.file, '/repo/tests/a.spec.js')
      assert.equal(testRecord?.status, 'passed')

      assert.equal(records.at(-1)?.type, 'end')
      assert.equal(records.at(-1)?.tests, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
