/**
 * Depends on `tests/__snapshots__/golden.spec.ts.snap`. Like the JSON fixture,
 * the snapshot has no code relationship to this test — only a naming one.
 */
import { test } from '@japa/runner'
import { titleCase, truncate } from '../src/strings.js'
import { expectGolden, snapshotPath } from './support/golden.js'
import { expectEqual } from './support/harness.js'

test('titleCase output matches the golden file', () => {
  expectGolden('titleCase/hello world', titleCase('hello world'))
})

test('truncate output matches the golden file', () => {
  expectGolden('truncate/long sentence', truncate('the quick brown fox', 12))
})

test('the golden file lives beside the spec that owns it', () => {
  expectEqual(snapshotPath().endsWith('__snapshots__/golden.spec.ts.snap'), true, 'snapshotPath')
})
