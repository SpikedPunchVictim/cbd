/**
 * Exercises every hook CBD.md §13 names, so the probe can answer whether each
 * one exists in the installed japa 5.4.0 and in what order they fire.
 *
 * Uses node:assert rather than japa's `assert`, because that comes from a
 * separate plugin (@japa/assert) and is not part of this probe's question.
 */
import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { addOne, double } from '../lib/under-test.js'

test('alpha', () => {
  assert.equal(addOne(1), 2)
})

test('beta', async () => {
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(double(3), 6)
})

// `test.setup` / `test.teardown` are chainable on the returned Test instance.
test('zeta', () => {
  assert.equal(addOne(3), 4)
})
  .setup(() => {})
  .teardown(() => {})

test.group('gamma', (group) => {
  group.setup(() => {})
  group.teardown(() => {})
  group.each.setup(() => {})
  group.each.teardown(() => {})

  test('delta', () => {
    assert.equal(addOne(2), 3)
  })

  test('epsilon', () => {
    assert.equal(double(2), 4)
  })
})
