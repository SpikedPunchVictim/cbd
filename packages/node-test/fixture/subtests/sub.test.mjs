import assert from 'node:assert/strict'
import { test } from 'node:test'
import { add, sub } from '../src/math.js'

test('parent', async (t) => {
  assert.equal(add(1, 2), 3)
  await t.test('child one', () => {
    assert.equal(sub(2, 2), 0)
  })
  await t.test('child two', () => {
    assert.equal(add(2, 2), 4)
  })
})

test('sibling', () => {
  assert.equal(add(0, 0), 0)
})
