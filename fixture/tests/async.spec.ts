import { test } from '@japa/runner'
import { delayed, mapSeries, withTimeout } from '../src/async-work.js'
import { expectDeepEqual, expectEqual, expectThrows } from './support/harness.js'

test('delayed resolves after the timer fires', async () => {
  expectEqual(await delayed('later', 5), 'later', 'delayed')
})

test('mapSeries preserves order', async () => {
  const out = await mapSeries([1, 2, 3], async (n) => n * 2)
  expectDeepEqual(out, [2, 4, 6], 'mapSeries')
})

// The rejection path schedules a timer that never gets to run — one source of
// activity outside any test window.
test('withTimeout rejects a promise that is too slow', async () => {
  await expectThrowsAsync(() => withTimeout(delayed('slow', 50), 1), /timed out/)
})

async function expectThrowsAsync(fn: () => Promise<unknown>, match: RegExp): Promise<void> {
  try {
    await fn()
  } catch (error) {
    if (error instanceof Error && match.test(error.message)) return
    throw error
  }
  throw new Error('expected the promise to reject, but it resolved')
}

test('withTimeout passes through a fast promise', async () => {
  expectEqual(await withTimeout(delayed('fast', 1), 100), 'fast', 'withTimeout')
})

// Referenced so the import is used; expectThrows covers the sync path.
test('expectThrows handles synchronous throws', () => {
  expectThrows(() => {
    throw new Error('sync')
  }, /sync/)
})
