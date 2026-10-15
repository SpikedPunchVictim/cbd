/**
 * Contains a skipped test and a test with per-test hooks.
 *
 * The skipped test is deliberate: amendment 5 requires that maps be built from
 * green runs only, and a skipped test produces an empty coverage window. If the
 * shard cannot distinguish "ran and touched nothing" from "did not run", this
 * file is where that shows up.
 */
import { test } from '@japa/runner'
import { add } from '../src/math.js'
import { expectEqual } from './support/harness.js'

test('a test with its own setup and teardown', () => {
  expectEqual(add(1, 2), 3, 'add with hooks')
})
  .setup(() => {})
  .teardown(() => {})

test('this test is skipped and must produce no coverage window', () => {
  throw new Error('a skipped test must never execute its body')
}).skip(true, 'skipped on purpose to exercise the green-runs-only rule')
