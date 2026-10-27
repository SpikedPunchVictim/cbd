import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { fileOf, shardPathFor, statusOf, titleOf } from '../src/identity.js'

test('the title is the full test name, without the file', () => {
  assert.equal(titleOf({ name: 'adds', fullTestName: 'math > inner > adds' }), 'math > inner > adds')
  // Vitest 3 has no fullTestName: the suite chain is walked instead. Without it,
  // two same-named tests in one file collapse into one map entry.
  assert.equal(
    titleOf({ name: 'adds', suite: { name: 'inner', suite: { name: 'math' } } }),
    'math > inner > adds',
  )
  assert.equal(titleOf({ name: 'adds' }), 'adds')
  assert.equal(titleOf({}), null)
  assert.equal(titleOf(undefined), null)
})

test('the file comes from file.filepath, falling back to its reported name', () => {
  assert.equal(fileOf({ file: { filepath: '/repo/tests/a.spec.ts', name: 'tests/a.spec.ts' } }), '/repo/tests/a.spec.ts')
  assert.equal(fileOf({ file: { name: 'tests/a.spec.ts' } }), 'tests/a.spec.ts')
  assert.equal(fileOf({}), null)
})

test('an outcome the adapter cannot read is failed, never passed', () => {
  assert.equal(statusOf('pass'), 'passed')
  assert.equal(statusOf('fail'), 'failed')
  assert.equal(statusOf('skip'), 'skipped')
  assert.equal(statusOf(undefined), 'failed')
  assert.equal(statusOf('something new'), 'failed')
})

test('one shard per test file, named from the file and stable', () => {
  const base = join('/tmp/cbd', 'run.ndjson')
  const one = shardPathFor(base, '/repo/tests/one.spec.ts')
  const again = shardPathFor(base, '/repo/tests/one.spec.ts')
  const two = shardPathFor(base, '/repo/tests/two.spec.ts')
  assert.equal(one, again)
  assert.notEqual(one, two)
  assert.ok(one.startsWith(join('/tmp/cbd', 'run.one.spec.ts.')))
  assert.ok(one.endsWith('.ndjson'))
  // Same basename, different directory: the hash keeps them apart.
  const sameName = shardPathFor(base, '/repo/a/one.spec.ts')
  assert.notEqual(one, sameName)
})
