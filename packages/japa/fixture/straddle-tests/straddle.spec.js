/**
 * A japa suite whose second test leaves the service working.
 *
 * `cbd-a3v.3.5`. The request is awaited and its response asserted like any other, so
 * the test itself is unremarkable — what is remarkable is that the service's side of
 * it is not finished when the test ends. Nothing here waits for that, because a real
 * test cannot: the work happens in another process, after the response, and the runner
 * knows nothing about it.
 *
 * **It is the second test, not the first, and that is deliberate.** The first window of
 * a run costs far more than the others — every script the service has parsed comes back
 * with it, and the recorder normalizes the lot in the tick that opens it — so the first
 * test's recorded duration is dominated by setup rather than by the test. A deferred
 * call with a sane delay lands inside that window however it is tuned, which would make
 * the fixture measure the wrong thing.
 *
 * The tests on either side drive nothing at all, so whatever window the leftover work
 * lands in, it is not the window of a test that could have caused it.
 */
import assert from 'node:assert/strict'
import { test } from '@japa/runner'

const base = process.env.CBD_FIXTURE_URL

test.group('a test that leaves work behind', () => {
  /**
   * Inert, and long enough that the run's first take is behind it.
   *
   * The first take of the service is the expensive one — every script it parsed
   * comes back, and `takePreciseCoverage` is cold — measured at about 7ms on this
   * fixture. The boundary after it is dispatched as soon as this test ends, so an
   * instant first test puts two boundaries inside that cost and the drift test
   * measures start-up, not the steady state it is about. The wait is the fixture
   * choosing its regime, the same way the 400ms test chooses where the sweep lands.
   */
  test('a test that drives nothing first', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(true)
  })

  test('a test that leaves the server working', async () => {
    const response = await fetch(`${base}/tick?afterMs=${process.env.CBD_TICK_MS ?? '250'}`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'ticked')
  })

  /**
   * Long enough to be a window rather than a gap, and that is the whole reason it is
   * here. The runner's inter-test gap is around ten milliseconds; the tests around it
   * take a hundred. Leftover work released on a timer therefore lands in whichever
   * *test* is open when it runs, almost never in the gap — and this test holds one open
   * long enough that the landing point is decided by the fixture rather than by a race.
   */
  test('a test that drives nothing after, but takes a while about it', async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.ok(true)
  })
})
