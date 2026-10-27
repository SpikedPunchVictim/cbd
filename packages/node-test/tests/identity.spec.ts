import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import {
  existingPattern,
  fitsCommandLine,
  fileOf,
  selectionPattern,
  shardPathFor,
  statusOf,
  titleOf,
} from '../src/identity.js'

test('the title is the full name, with the bare name only as a fallback', () => {
  assert.equal(titleOf({ fullName: 'outer > inner > adds', name: 'adds' }), 'outer > inner > adds')
  assert.equal(titleOf({ name: 'bare' }), 'bare')
  assert.equal(titleOf({ name: '' }), null)
  assert.equal(titleOf(undefined), null)
})

test('a skipped window is skipped; anything but passed is failed', () => {
  assert.equal(statusOf({ passed: true }), 'passed')
  assert.equal(statusOf({ passed: false }), 'failed')
  assert.equal(statusOf({}), 'failed')
  assert.equal(statusOf(undefined), 'failed')
  // A body-level `t.skip()` leaves `passed` true; the caller's flag wins.
  assert.equal(statusOf({ passed: true }, true), 'skipped')
})

// Every reading of a stored title is admitted. The stored string cannot say which
// ` > ` occurrences were separators, and a title may itself contain one; admitting
// the readings can only run an extra test, while guessing one silently skipped the
// test the selection named.
test('the selection pattern joins parts with spaces and escapes regex characters', () => {
  assert.equal(
    selectionPattern(['outer > adds', 'outer > inner > adds (fast)']),
    '^(?:outer > adds|outer adds|outer > inner > adds \\(fast\\)|outer inner > adds \\(fast\\)|outer > inner adds \\(fast\\)|outer inner adds \\(fast\\))$',
  )
})

test('an existing pattern is read in both flag spellings', () => {
  assert.equal(existingPattern(['--test-name-pattern=^a$']), '^a$')
  assert.equal(existingPattern(['--test-name-pattern', '^a$']), '^a$')
  assert.equal(existingPattern(['--test-reporter=tap']), undefined)
})

test('the file is reported from the context', () => {
  assert.equal(fileOf({ filePath: '/repo/a.test.mjs' }), '/repo/a.test.mjs')
  assert.equal(fileOf({}), null)
  assert.equal(fileOf(undefined), null)
})

test('one shard per test file, named from the file and stable', () => {
  const base = '/tmp/cbd/run.ndjson'
  const one = shardPathFor(base, '/repo/tests/one.test.mjs')
  assert.equal(one, shardPathFor(base, '/repo/tests/one.test.mjs'))
  assert.notEqual(one, shardPathFor(base, '/repo/tests/two.test.mjs'))
  assert.ok(one.startsWith('/tmp/cbd/run.one.test.mjs.'))
  assert.ok(one.endsWith('.ndjson'))
})

test('a selection that fits the command line is re-executed', () => {
  assert.equal(fitsCommandLine('node', ['--test-name-pattern=^a$', 'x.test.js'], 'win32'), true)
  assert.equal(fitsCommandLine('node', ['--test-name-pattern=^a$', 'x.test.js'], 'linux'), true)
})

test('a selection past the Windows command-line limit is not re-executed', () => {
  assert.equal(fitsCommandLine('node', [`--test-name-pattern=${'a'.repeat(40_000)}`], 'win32'), false)
})

test('a single argument past the Linux limit is not re-executed', () => {
  assert.equal(fitsCommandLine('node', ['a'.repeat(130_000)], 'linux'), false)
})
