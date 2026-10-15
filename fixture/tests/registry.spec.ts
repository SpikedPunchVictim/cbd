/** Touches a module with import-time work, so the `@load` bucket is non-empty. */
import { test } from '@japa/runner'
import { loadedAt, lookup, register, size } from '../src/registry.js'
import { expectEqual } from './support/harness.js'

test('the registry starts with import-time state', () => {
  expectEqual(loadedAt > 0, true, 'loadedAt was set at import time')
})

test('register and lookup round-trip', () => {
  const before = size()
  register('answer', '42')
  expectEqual(lookup('answer'), '42', 'lookup')
  expectEqual(size() > before, true, 'size grew')
})
