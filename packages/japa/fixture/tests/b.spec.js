import assert from 'node:assert/strict'
import { test } from '@japa/runner'

test('beta-lone', () => {
  assert.ok(true)
})

test.group('beta-group', () => {
  test('beta-grouped', () => {
    assert.ok(true)
  })
})
