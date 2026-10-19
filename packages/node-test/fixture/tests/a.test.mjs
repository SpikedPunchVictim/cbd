import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { add, sub } from '../src/math.js'

describe('outer', () => {
  test('passes', () => {
    assert.equal(add(1, 2), 3)
  })

  test('fails', () => {
    assert.equal(add(1, 1), 3)
  })

  test.skip('skipped', () => {
    // Statically skipped: the adapter must open no window for it.
  })

  describe('inner', () => {
    test('nested passes', () => {
      assert.equal(sub(2, 2), 0)
    })
  })
})

test('body skip', (t) => {
  // The runner reports this as skipped, but `passed` stays true; the adapter must
  // not record it as a green window.
  t.skip('not now')
  assert.equal(add(1, 1), 2)
})
