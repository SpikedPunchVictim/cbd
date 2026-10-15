import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import {
  IncompleteShardError,
  parseShard,
  StringSink,
  summarizeShard,
  type ShardRecord,
} from '../src/shard.js'

const HEADER = '{"type":"shard","version":1,"commit":"abc","pid":1,"startedAt":"T0"}'
const TEST_A =
  '{"type":"test","title":"a","file":null,"status":"passed","durationMs":1,"touches":[["/f.ts","add@0",1,2]]}'
const LOAD = '{"type":"load","touches":[["/f.ts","<module>@0",0,9]]}'
const FOOTER = '{"type":"end","tests":1,"finishedAt":"T1"}'

test('a completed shard parses into its records', () => {
  const records = parseShard([HEADER, LOAD, TEST_A, FOOTER].join('\n'))
  assert.equal(records.length, 4)
  assert.equal(records[0]?.type, 'shard')
  assert.equal(records[3]?.type, 'end')
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

test('a shard missing its header is refused', () => {
  assert.throws(() => parseShard([TEST_A, FOOTER].join('\n')), IncompleteShardError)
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
  for (const line of [HEADER, LOAD, TEST_A, FOOTER]) sink.append(line)
  const records = parseShard(sink.text)
  assert.equal(records.length, 4)
})

test('summarizeShard separates tests from the load and between buckets', () => {
  const records: ShardRecord[] = [
    { type: 'shard', version: 1, commit: 'abc', pid: 1, startedAt: 'T0' },
    { type: 'load', touches: [['/f.ts', '<module>@0', 0, 9]] },
    { type: 'between', touches: [['/f.ts', 'timer@0', 3, 3]] },
    { type: 'between', touches: [['/f.ts', 'timer@0', 2, 4]] },
    { type: 'test', title: 'a', file: null, status: 'passed', durationMs: 1, touches: [] },
    { type: 'end', tests: 1, finishedAt: 'T1' },
  ]
  const summary = summarizeShard(records)
  assert.equal(summary.header.commit, 'abc')
  assert.equal(summary.tests.length, 1)
  assert.equal(summary.load.length, 1)
  assert.equal(summary.between.length, 2)
})
