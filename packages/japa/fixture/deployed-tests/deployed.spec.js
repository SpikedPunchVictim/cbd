/**
 * A suite that drives the deployed service, and runs part of it in process.
 *
 * `cbd-jmn`. Both halves matter, and the first test is the one that is easy to leave
 * out: it imports the CHECKOUT's own build of `handler.ts` and calls it directly, so
 * the test process records a touch for the same logical file the deployed copy is
 * recording for. Those two touches are what has to become one map entry.
 *
 * The build is imported, not the source, because that is the shape a real suite has:
 * the test process runs the repository's compiled output, and its map resolves that
 * output back into the repository's sources with no rule needed.
 *
 * Titles are named at the top of the spec as constants rather than by position here,
 * because the assertions in `deployed-e2e.spec.ts` quote them.
 */
import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { storeKey } from '../deployed/dist/handler.js'

const base = process.env.CBD_FIXTURE_URL

async function call(path) {
  const response = await fetch(`${base}${path}`)
  assert.equal(response.status, 200)
  return response.text()
}

test('the handler is called in this process', () => {
  assert.equal(storeKey('Alpha'), 'stored:alpha')
})

test('the deployed service stores a key', async () => {
  assert.equal(await call('/store?key=Beta'), 'stored:beta')
})

test('the deployed service reads a key back', async () => {
  assert.equal(await call('/fetch?key=Beta'), 'beta')
})
