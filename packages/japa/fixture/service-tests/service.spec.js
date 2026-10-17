/**
 * A japa suite driving the separately started service.
 *
 * Three tests, and the count is the point — each one answers a question the others
 * cannot:
 *
 *   - one drives `storeKey`, and no other test does;
 *   - one drives `fetchKey`, a *different* server function, so a take that was a
 *     running total rather than a window would show `storeKey` in this window too;
 *   - one drives nothing, so a test whose server window is genuinely empty can be
 *     told from a test that was not recorded at all.
 *
 * The base URL arrives in the environment rather than being discovered, because the
 * service is started *before* this process is: the plugin opens the service's
 * coverage source at install time, which is before any of these files is imported.
 * That ordering is not a convenience of the test — it is the reason the window
 * boundaries can stay synchronous (A0 F1).
 */
import assert from 'node:assert/strict'
import { test } from '@japa/runner'

const base = process.env.CBD_FIXTURE_URL

async function call(path) {
  const response = await fetch(`${base}${path}`)
  assert.equal(response.status, 200)
  return response.text()
}

test('the key server stores a key', async () => {
  assert.equal(await call('/store?key=Alpha'), 'stored:alpha')
})

test('the key server reads a key back', async () => {
  assert.equal(await call('/fetch?key=Alpha'), 'alpha')
})

test('a test that drives nothing on the server', () => {
  assert.ok(true)
})
