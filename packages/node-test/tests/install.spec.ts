/**
 * The overlap guard, without a real `node --test` run.
 *
 * The adapter is installed with injected hooks, exactly as the register entry does.
 * Calling two `beforeEach` callbacks before the first `afterEach` is what a
 * concurrent subtree produces; the second must be refused, and the run must not
 * finish with an end record.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { parseShard } from '@spikedpunch/cbd/adapter'
import { installNodeTest } from '../src/install.js'

type Hook = (...args: unknown[]) => unknown

test('a second open window is refused and leaves the shard incomplete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-node-overlap-'))
  const saved = {
    shard: process.env.CBD_SHARD,
    context: process.env.NODE_TEST_CONTEXT,
  }
  try {
    process.env.CBD_SHARD = join(dir, 'run.ndjson')
    process.env.NODE_TEST_CONTEXT = 'child-v8'

    const hooks: { beforeEach?: Hook; afterEach?: Hook; after?: Hook } = {}
    await installNodeTest({
      beforeEach: (fn: Hook) => {
        hooks.beforeEach = fn
        return undefined
      },
      afterEach: (fn: Hook) => {
        hooks.afterEach = fn
        return undefined
      },
      after: (fn: Hook) => {
        hooks.after = fn
        return undefined
      },
    } as never)

    const first = { name: 'one', fullName: 'one', filePath: join(dir, 'a.spec.ts') }
    const second = { name: 'two', fullName: 'two', filePath: join(dir, 'a.spec.ts') }
    hooks.beforeEach!(first)
    assert.throws(
      () => hooks.beforeEach!(second),
      /running tests concurrently/,
      'a concurrent window must be refused, not charged to the first test',
    )
    hooks.afterEach!(first)
    await hooks.after!()

    const shard = join(dir, 'run.ndjson')
    if (existsSync(shard)) {
      assert.equal(
        readFileSync(shard, 'utf8').includes('"type":"end"'),
        false,
        'a refused run must not leave a shard a build would accept',
      )
    }
  } finally {
    for (const [key, value] of [
      ['CBD_SHARD', saved.shard],
      ['NODE_TEST_CONTEXT', saved.context],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

interface InstalledHooks {
  beforeEach: Hook
  afterEach: Hook
  after: Hook
}

/** Install the adapter against a temporary shard, returning the hooks it registered. */
async function installWithShard(
  shard: string,
): Promise<{ hooks: InstalledHooks; restore: () => void }> {
  const saved = {
    shard: process.env.CBD_SHARD,
    context: process.env.NODE_TEST_CONTEXT,
  }
  process.env.CBD_SHARD = shard
  process.env.NODE_TEST_CONTEXT = 'child-v8'
  const hooks: Partial<InstalledHooks> = {}
  await installNodeTest({
    beforeEach: (fn: Hook) => {
      hooks.beforeEach = fn
      return undefined
    },
    afterEach: (fn: Hook) => {
      hooks.afterEach = fn
      return undefined
    },
    after: (fn: Hook) => {
      hooks.after = fn
      return undefined
    },
  } as never)
  return {
    hooks: hooks as InstalledHooks,
    restore: () => {
      for (const [key, value] of [
        ['CBD_SHARD', saved.shard],
        ['NODE_TEST_CONTEXT', saved.context],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

test('a body skip with no afterEach is closed at the next window and at the end', async () => {
  // Node 22 does not call `afterEach` for a test whose body called `t.skip()`.
  // The next `beforeEach` must close that window (instead of calling it
  // concurrency), and the file's `after` must close one left at the end.
  const dir = mkdtempSync(join(tmpdir(), 'cbd-node-skip-'))
  const shard = join(dir, 'run.ndjson')
  const installed = await installWithShard(shard)
  try {
    const filePath = join(dir, 'a.spec.ts')
    const one = {
      name: 'one',
      fullName: 'one',
      filePath,
      skip: (..._args: unknown[]) => 'skipped',
    }
    const two = { name: 'two', fullName: 'two', filePath, passed: true }
    const three = {
      name: 'three',
      fullName: 'three',
      filePath,
      skip: (..._args: unknown[]) => 'skipped',
    }

    installed.hooks.beforeEach(one)
    one.skip('not now')
    installed.hooks.beforeEach(two)
    installed.hooks.afterEach(two)
    installed.hooks.beforeEach(three)
    three.skip('later')
    await installed.hooks.after()

    // `CBD_SHARD` is the base name; the sink appends the test file's name and hash.
    const shards = readdirSync(dir).filter((name) => name.endsWith('.ndjson'))
    assert.equal(shards.length, 1, `expected one shard, got ${shards.join(', ')}`)
    const records = parseShard(readFileSync(join(dir, shards[0]!), 'utf8'), shards[0]!)
    assert.deepEqual(
      records
        .filter((record) => record.type === 'test')
        .map((record) => [record.title, record.status]),
      [
        ['one', 'skipped'],
        ['two', 'passed'],
        ['three', 'skipped'],
      ],
    )
    assert.ok(records.some((record) => record.type === 'end'), 'the shard must be complete')
  } finally {
    installed.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a window the runner never closes refuses the shard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-node-open-'))
  const shard = join(dir, 'run.ndjson')
  const installed = await installWithShard(shard)
  try {
    installed.hooks.beforeEach({
      name: 'one',
      fullName: 'one',
      filePath: join(dir, 'a.spec.ts'),
    })
    await installed.hooks.after()

    const shards = readdirSync(dir).filter((name) => name.endsWith('.ndjson'))
    for (const name of shards) {
      const text = readFileSync(join(dir, name), 'utf8')
      assert.equal(text.includes('"type":"end"'), false, 'no end record for an open window')
      assert.equal(text.includes('"type":"test"'), false, 'no test record without a close')
    }
  } finally {
    installed.restore()
    rmSync(dir, { recursive: true, force: true })
  }
})
