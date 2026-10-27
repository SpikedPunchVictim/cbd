import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import {
  FileSink,
  IncompleteShardError,
  parseShard,
  ShardVersionError,
  StringSink,
  summarizeShard,
  type ShardRecord,
} from '../src/shard.js'

const HEADER = '{"type":"shard","version":2,"commit":"abc","pid":1,"startedAt":"T0"}'
const SCRIPT =
  '{"type":"script","scriptId":"1","url":"file:///f.js","size":10,"mtimeMs":1}'
const FUNCTION =
  '{"type":"function","scriptId":"1","start":10,"end":20,"name":"add"}'
const TEST_A =
  '{"type":"test","title":"a","file":null,"status":"passed","durationMs":1,"touches":{"1":[[10,20]]}}'
const LOAD = '{"type":"load","touches":{"1":[[0,9]]}}'
const FOOTER = '{"type":"end","tests":1,"finishedAt":"T1"}'

const V1_HEADER = '{"type":"shard","version":1,"commit":"abc","pid":1,"startedAt":"T0"}'

test('a completed shard parses into its records', () => {
  const records = parseShard([HEADER, SCRIPT, FUNCTION, LOAD, TEST_A, FOOTER].join('\n'))
  assert.equal(records.length, 6)
  assert.equal(records[0]?.type, 'shard')
  assert.equal(records[5]?.type, 'end')
})

// A killed run is exactly where the final line is cut mid-record; `--partial` is the
// opt-in for it, so refusing it there defeats the flag.
test('a partial shard whose last line was truncated parses when incomplete is allowed', () => {
  const records = parseShard([HEADER, TEST_A, '{"type":"test","title":"b","fi'].join('\n'), 'shard-1.jsonl', {
    allowIncomplete: true,
  })
  assert.equal(records.length, 2)
})

test('a truncated line before the last is refused even when incomplete is allowed', () => {
  assert.throws(
    () => parseShard([HEADER, '{"type":"test","ti', TEST_A].join('\n'), 'shard-1.jsonl', { allowIncomplete: true }),
    IncompleteShardError,
  )
})

test('a truncated last line is refused when incomplete is not allowed', () => {
  assert.throws(
    () => parseShard([HEADER, TEST_A, '{"type":"test","ti'].join('\n'), 'shard-1.jsonl'),
    IncompleteShardError,
  )
})

// The requirement: a partial run's coverage is not merely incomplete, it is
// wrong — a test that aborted early executed less than it should have.
test('a shard with no end record is refused', () => {
  assert.throws(
    () => parseShard([HEADER, TEST_A].join('\n'), 'shard-1.jsonl'),
    (error: unknown) =>
      error instanceof IncompleteShardError && /interrupted/.test(error.message),
  )
})

// The v1 tuple and the v2 range are both arrays of numbers, so reading one as the
// other yields a well-formed empty map rather than an error. Refusing is the only
// safe answer.
test('a version 1 shard is refused loudly', () => {
  assert.throws(
    () => parseShard([V1_HEADER, TEST_A, FOOTER].join('\n'), 'old.ndjson'),
    (error: unknown) =>
      error instanceof ShardVersionError &&
      /version 1/.test(error.message) &&
      /Re-record/.test(error.message),
  )
})

test('a shard missing its header is refused', () => {
  assert.throws(() => parseShard([TEST_A, FOOTER].join('\n')), IncompleteShardError)
})

// v3 adds the group record; a v2 header cannot have produced one, so a shard
// claiming both is inconsistent. Reading it would silently drop those tests.
test('a version 2 shard carrying a group record is refused', () => {
  const group = '{"type":"group","touches":{},"tests":[]}'
  assert.throws(
    () => parseShard([HEADER, group, FOOTER].join('\n')),
    (error: unknown) =>
      error instanceof IncompleteShardError && /group record/.test(error.message),
  )
})

test('a version 2 shard without group records is still read', () => {
  const records = parseShard([HEADER, TEST_A, FOOTER].join('\n'))
  assert.equal(records.length, 3)
})

test('an empty shard is refused rather than treated as no tests', () => {
  assert.throws(() => parseShard(''), IncompleteShardError)
})

test('a line that is not JSON names the offending line', () => {
  assert.throws(
    () => parseShard([HEADER, '{oops', FOOTER].join('\n'), 'shard-7.jsonl'),
    (error: unknown) =>
      error instanceof IncompleteShardError && /shard-7\.jsonl:2/.test(error.message),
  )
})

test('blank lines between records are tolerated', () => {
  const records = parseShard(`${HEADER}\n\n${TEST_A}\n\n${FOOTER}\n`)
  assert.equal(records.length, 3)
})

test('StringSink round-trips through parseShard', () => {
  const sink = new StringSink()
  for (const line of [HEADER, SCRIPT, FUNCTION, LOAD, TEST_A, FOOTER]) sink.append(line)
  const records = parseShard(sink.text)
  assert.equal(records.length, 6)
})

test('summarizeShard separates tests, the buckets and the tables', () => {
  const records: ShardRecord[] = [
    { type: 'shard', version: 2, commit: 'abc', pid: 1, startedAt: 'T0' },
    { type: 'script', scriptId: '1', url: 'file:///f.js', size: 10, mtimeMs: 1 },
    { type: 'function', scriptId: '1', start: 0, end: 9, name: '' },
    { type: 'function', scriptId: '1', start: 10, end: 20, name: 'add' },
    { type: 'load', touches: { '1': [[0, 9]] } },
    { type: 'between', touches: { '1': [[3, 3]] } },
    { type: 'between', touches: { '1': [[2, 4]] } },
    { type: 'test', title: 'a', file: null, status: 'passed', durationMs: 1, touches: {} },
    { type: 'end', tests: 1, finishedAt: 'T1' },
  ]
  const summary = summarizeShard(records)
  assert.equal(summary.header.commit, 'abc')
  assert.equal(summary.tests.length, 1)
  assert.equal(summary.load.length, 1)
  assert.equal(summary.between.length, 2)
  assert.deepEqual(
    summary.scripts.map((script) => script.url),
    ['file:///f.js'],
  )
  assert.deepEqual(
    summary.functions.map((fn) => fn.start),
    [0, 10],
  )
})

test('a shard with a second header is refused', () => {
  const one = [HEADER, TEST_A, FOOTER].join('\n')
  assert.throws(() => parseShard(`${one}\n${one}`), /second shard header/)
})

test('FileSink.reset starts a new run at the same path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-sink-'))
  const path = join(dir, 'run.ndjson')
  try {
    writeFileSync(path, 'old-run\n')
    const sink = new FileSink(path)
    sink.reset()
    sink.append('{"type":"shard"}')
    assert.equal(readFileSync(path, 'utf8'), '{"type":"shard"}\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
