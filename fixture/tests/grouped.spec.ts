/**
 * Uses `test.group` with `group.setup/teardown` and `group.each.*`, so the
 * bucket logic in A3 has group-scoped activity to reason about — setup that
 * runs once per group must not be attributed to whichever test happened to run
 * first.
 */
import { test } from '@japa/runner'
import { chunk, unique } from '../src/collections.js'
import { range, sum } from '../src/helpers.js'
import { expectDeepEqual, expectEqual } from './support/harness.js'

test.group('grouped arithmetic', (group) => {
  let callCount = 0

  group.setup(() => {
    callCount = 0
  })

  group.each.setup(() => {
    callCount++
  })

  test('sum over a generated range', () => {
    expectEqual(sum(range(5)), 10, 'sum(range(5))')
  })

  test('unique over a generated range', () => {
    expectDeepEqual(unique(range(3)), [0, 1, 2], 'unique(range(3))')
  })

  test('chunk over a generated range', () => {
    expectDeepEqual(chunk(range(4), 3), [[0, 1, 2], [3]], 'chunk(range(4))')
  })

  group.teardown(() => {
    expectEqual(callCount, 3, 'each.setup ran per test')
  })
})
