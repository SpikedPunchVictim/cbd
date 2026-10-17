import assert from 'node:assert/strict'
import { test } from '@japa/runner'

test('alpha-lone', () => {
  assert.ok(true)
})

test.group('alpha-group', () => {
  test('alpha-grouped', () => {
    assert.ok(true)
  })
})
