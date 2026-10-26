import assert from 'node:assert/strict'
import { test } from '@japa/runner'

console.log('IMPORTED unselected.spec.js')

test('narrow-unselected', () => {
  assert.ok(true)
})
