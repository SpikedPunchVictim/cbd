/**
 * Fixture file B — the control. Same shape as A, different filename, so every
 * observation can be checked against the file it should name rather than merely
 * being non-null.
 */
import assert from 'node:assert/strict'
import { test } from '@japa/runner'

test('b-lone', () => {
  assert.ok(true)
})

test.group('b-group', () => {
  test('b-grouped', () => {
    assert.ok(true)
  })
})
