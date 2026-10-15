/** Imports through the barrel, so one import pulls in four modules. */
import { test } from '@japa/runner'
import { add, chunk, loadSettings, titleCase } from '../src/index.js'
import { expectDeepEqual, expectEqual } from './support/harness.js'

test('the barrel re-exports working behaviour', () => {
  expectEqual(add(1, 1), 2, 'add via barrel')
  expectEqual(titleCase('via barrel'), 'Via Barrel', 'titleCase via barrel')
})

test('the barrel exposes collections and settings too', () => {
  expectDeepEqual(chunk([1, 2], 1), [[1], [2]], 'chunk via barrel')
  expectEqual(loadSettings().name, 'cbd-fixture', 'settings via barrel')
})
