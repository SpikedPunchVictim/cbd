import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { normalize } from '../src/normalize.js'
import { inProcessSource } from '../src/source/in-process.js'

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
