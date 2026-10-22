/**
 * Which recorders a run opens, and where each one writes.
 *
 * `cbd-a3v.3.3`. The interesting behaviour is not the happy path — it is the
 * decision about whether a service exists at all, and what happens when the answer
 * is "yes, but it is not there". That decision is a pure function of the environment
 * and a shard path, so it is exercised here without japa, without an emitter, and
 * for the failure case without any service to be absent.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { SOCKET_DIR_ENV, type Recorder } from '@spikedpunch/cbd/adapter'
import { recordersFor, serviceShardPath } from '../src/plugin.js'

function readShard(path: string): { type: string; [key: string]: unknown }[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; [key: string]: unknown })
}

/** Drives one recorder through a single test, the way the adapter's hooks do. */
async function runOneTest(recorder: Recorder): Promise<void> {
  recorder.testStart('alpha', '/repo/tests/a.spec.js')
  recorder.testEnd('alpha', 'passed', 7)
  await recorder.runEnd()
  await recorder.drained()
}

test.group('serviceShardPath', () => {
  test('puts the suffix before the extension, so both shards sort together', () => {
    assert.equal(serviceShardPath('/tmp/run.ndjson'), '/tmp/run.service.ndjson')
    assert.equal(serviceShardPath('run.jsonl'), 'run.service.jsonl')
  })

  // A dot in a directory name is not an extension, and splicing there would move a
  // path component's name into the tail of the file's.
  test('a dot inside a directory name is left alone', () => {
    assert.equal(serviceShardPath('/tmp/a.b/run'), '/tmp/a.b/run.service')
  })

  test('a path with no extension just gains one', () => {
    assert.equal(serviceShardPath('/tmp/run'), '/tmp/run.service')
  })
})

test.group('recordersFor', () => {
  test('with no socket directory there is only the test process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-recorders-'))
    try {
      const shard = join(dir, 'run.ndjson')
      const recorders = await recordersFor({}, shard, { commit: 'c0ffee' })

      assert.equal(recorders.length, 1)
      await runOneTest(recorders[0] as Recorder)

      const records = readShard(shard)
      assert.equal(records.at(0)?.type, 'shard')
      assert.equal(records.at(0)?.pid, process.pid)
      assert.equal(records.at(-1)?.type, 'end')
      assert.equal(existsSync(serviceShardPath(shard)), false, 'no service shard may be created')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * The failure the epic exists to remove, refused instead of absorbed.
   *
   * A suite driving a separately started server is blind to every server-side file
   * without this. Falling back to the test process alone produces a shard that
   * parses, a map that builds, and a change to a server file that resolves to
   * nothing the map has seen — which escalates to the whole suite. Nothing about
   * that outcome says it was a misconfiguration.
   */
  test('a configured service that is not there is an error, and names the directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-recorders-'))
    try {
      const shard = join(dir, 'run.ndjson')
      await assert.rejects(
        recordersFor({ [SOCKET_DIR_ENV]: dir }, shard, { commit: 'c0ffee' }),
        (error: Error) => {
          assert.match(error.message, /no instrumented service answered/)
          assert.ok(
            error.message.includes(dir),
            `the message must name the directory it looked in: ${error.message}`,
          )
          return true
        },
      )
      // And it leaves nothing half-written for a later reader to trip over.
      assert.equal(existsSync(shard), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // An empty variable is how a shell says "unset" after `CBD_SOCKET_DIR=` in an env
  // file, and treating it as a directory named "" would fail on a run that meant
  // nothing by it.
  test('an empty socket directory means the same as none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-recorders-'))
    try {
      const recorders = await recordersFor(
        { [SOCKET_DIR_ENV]: '' },
        join(dir, 'run.ndjson'),
        { commit: 'c0ffee' },
      )
      assert.equal(recorders.length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('serviceShardPath treats a Windows backslash as a separator', () => {
  assert.equal(
    serviceShardPath('C:\\repo\\.cbd\\shards\\run'),
    'C:\\repo\\.cbd\\shards\\run.service',
  )
  assert.equal(
    serviceShardPath('C:\\repo\\.cbd\\shards\\run.ndjson'),
    'C:\\repo\\.cbd\\shards\\run.service.ndjson',
  )
})
