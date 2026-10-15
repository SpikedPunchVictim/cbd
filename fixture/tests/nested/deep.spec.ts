/** A spec in a nested directory, importing across two levels of depth. */
import { test } from '@japa/runner'
import { deepAdd, deepValue } from '../../src/nested/deep.js'
import { expectEqual } from '../support/harness.js'

test('deepValue returns its constant', () => {
  expectEqual(deepValue(), 'deep', 'deepValue')
})

test('deepAdd adds from a nested module', () => {
  expectEqual(deepAdd(20, 22), 42, 'deepAdd')
})
