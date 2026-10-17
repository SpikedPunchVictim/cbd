/**
 * Fixture file A — exists only to be told apart from B.
 *
 * Deliberately mirrors the target suite's shape: one lone test plus a group, so
 * the probe can tell whether the file is known for grouped tests (which go
 * through `group.tap`) and ungrouped ones (which do not) by the same mechanism.
 */
import assert from 'node:assert/strict'
import { test } from '@japa/runner'

test('a-lone', () => {
  assert.ok(true)
})

test.group('a-group', () => {
  test('a-grouped', () => {
    assert.ok(true)
  })
})
