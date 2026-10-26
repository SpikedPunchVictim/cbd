import assert from 'node:assert/strict'
import { test } from '@japa/runner'

// A top-level side effect: it runs when japa imports this file, whether or not any
// test in it is selected. The e2e reads it to tell "imported" from "merely skipped".
console.log('IMPORTED selected.spec.js')

test('narrow-selected', () => {
  assert.ok(true)
})
