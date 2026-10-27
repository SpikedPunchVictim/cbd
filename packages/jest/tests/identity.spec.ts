import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { shardPathFor, statusOf, titleOf } from '../src/identity.js'

const root = { name: 'ROOT_DESCRIBE_BLOCK' }

test('the title is the describe path plus the test name, without the synthetic root', () => {
  assert.equal(
    titleOf({
      name: 'adds',
      parent: { name: 'inner', parent: { name: 'outer', parent: root } },
    }),
    'outer > inner > adds',
  )
  assert.equal(titleOf({ name: 'bare', parent: root }), 'bare')
  assert.equal(titleOf({ parent: root }), null)
  assert.equal(titleOf(undefined), null)
})

test('a skipped or todo test is skipped even with no errors; errors mean failed', () => {
  assert.equal(statusOf({ mode: 'skip' }), 'skipped')
  assert.equal(statusOf({ mode: 'todo' }), 'skipped')
  assert.equal(statusOf({ errors: [new Error('x')] }), 'failed')
  assert.equal(statusOf({ errors: [] }), 'passed')
  assert.equal(statusOf(undefined), 'passed')
})

test('one shard per test file, named from the file and stable', () => {
  const base = join('/tmp/cbd', 'run.ndjson')
  const one = shardPathFor(base, '/repo/tests/one.test.js')
  assert.equal(one, shardPathFor(base, '/repo/tests/one.test.js'))
  assert.notEqual(one, shardPathFor(base, '/repo/tests/two.test.js'))
  assert.ok(one.startsWith(join('/tmp/cbd', 'run.one.test.js.')))
  assert.ok(one.endsWith('.ndjson'))
})
