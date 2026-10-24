import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import type { InstrumentScope } from '../src/instrument-protocol.js'
import { normalize } from '../src/normalize.js'
import { inProcessSource } from '../src/source/in-process.js'
import { sourceContract } from './support/source-contract.js'

/** Called from a timer, outside any test window — the `@between` case. */
function backgroundWork(): number {
  return 7
}

test('a take completes synchronously, as the japa adapter requires', async () => {
  const source = await inProcessSource()
  try {
    const payload = source.takeSync()
    assert.ok(Array.isArray(payload))
  } finally {
    source.close()
  }
})

// The delta property (spike S1a). This very file is executing, so the first take
// must see it; an immediate second take, with nothing run in between, must not.
test('taking twice in a row yields a delta, not a running total', async () => {
  const source = await inProcessSource()
  try {
    const first = source.takeSync()
    assert.ok(first.length > 0, 'the first take should see the running test file')

    const selfUrl = import.meta.url
    const second = source.takeSync()
    const stillReported = second.some((script) => script.url === selfUrl)
    assert.equal(stillReported, false, 'the second take must not repeat the first window')
  } finally {
    source.close()
  }
})

test('scriptParsed is wired up, so maps can be discovered', async () => {
  const source = await inProcessSource()
  try {
    source.takeSync()
    const scripts = source.scripts()
    assert.ok(scripts.size > 0, 'no scripts were recorded from Debugger.scriptParsed')
    const self = [...scripts.values()].find((info) => info.url === import.meta.url)
    assert.ok(self, 'this spec file was not reported by scriptParsed')
  } finally {
    source.close()
  }
})

// The `@between` bucket, with a real timer rather than a scripted payload: work
// that runs while no test is on the stack is invisible to the window it happens
// in, and shows up in whichever take comes next.
test('work done on a timer between windows is visible to the next take', async () => {
  const source = await inProcessSource()
  try {
    source.takeSync() // drain, so only the timer lands in the next window

    await new Promise<void>((resolve) => {
      setTimeout(() => {
        backgroundWork()
        resolve()
      }, 5)
    })

    const touched = normalize(source.takeSync(), source, {})
    assert.ok(
      touched.some((touch) => touch.name === 'backgroundWork'),
      `expected backgroundWork in the window, got: ${touched.map((t) => t.name).join(', ')}`,
    )
  } finally {
    source.close()
  }
})

/**
 * One process, one collector.
 *
 * A suite that starts services of its own carries `NODE_OPTIONS`, because that is
 * how the children are instrumented at all (ADR-0005) — which means the injected
 * module is running in this process too. Coverage counters belong to the isolate,
 * so a take from either client resets what the other was about to read: the
 * module's periodic self-snapshot would silently shorten every window this source
 * produces. It publishes an off switch for exactly this case, and the source that
 * is collecting in this process is the one that calls it.
 */
test('stands the injected instrument down when one is running in this process', async () => {
  const scope = globalThis as InstrumentScope
  let stopped = 0
  scope.__cbdInstrument = {
    stop: async () => {
      stopped += 1
      return []
    },
  }
  try {
    const source = await inProcessSource()
    try {
      assert.equal(stopped, 1, 'the module in this process was left collecting')
    } finally {
      source.close()
    }
  } finally {
    delete scope.__cbdInstrument
  }
})

/**
 * Standing down is a handoff.
 *
 * The injected module starts at process birth and its self-snapshots have already
 * taken whatever ran before this source existed. Those counters are reset when
 * taken, so the module gives them back and the source must deliver them in its
 * first window — that window is `@load`, and on a real runner it is the import
 * phase (`cbd-1ci`: a module loaded there and never executed again left no
 * evidence, and a change to it escalated as `unknown-file`).
 *
 * Delivered once, not repeated: a carried script in every window would credit
 * import-time work to whichever test happened to run, which is the opposite error.
 */
test('carries the instrument it stood down into the first window, once', async () => {
  const scope = globalThis as InstrumentScope
  const carried = [
    {
      scriptId: 'carried-1',
      url: 'file:///carried/before.js',
      functions: [
        {
          functionName: '',
          isBlockCoverage: false,
          ranges: [{ startOffset: 0, endOffset: 10, count: 1 }],
        },
      ],
    },
  ]
  scope.__cbdInstrument = {
    stop: async () => carried,
  }
  try {
    const source = await inProcessSource()
    try {
      const first = source.takeSync()
      assert.ok(
        first.some((script) => script.url === 'file:///carried/before.js'),
        'the import-phase coverage the instrument had already taken was discarded',
      )
      const second = source.takeSync()
      assert.equal(
        second.some((script) => script.url === 'file:///carried/before.js'),
        false,
        'carried coverage was delivered a second time',
      )
    } finally {
      source.close()
    }
  } finally {
    delete scope.__cbdInstrument
  }
})

// The shared contract, so the in-process source and the out-of-process one cbd-a3v
// will build are held to the same shape rather than to two private opinions.
sourceContract('in-process', inProcessSource, { supportsSync: true })

// The generated text is fetched for scripts whose map had to travel; a clean run
// produces all of it, so the health signal is empty rather than absent. The absent
// method was indistinguishable from "nothing was missing" on every run.
test('reports no missing generated text on a clean run', async () => {
  const source = await inProcessSource()
  try {
    await source.prepare?.([...source.scripts().keys()])
    assert.deepEqual(source.generatedMissing?.(), [])
  } finally {
    source.close()
  }
})
