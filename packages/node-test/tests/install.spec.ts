/**
 * The overlap guard, without a real `node --test` run.
 *
 * The adapter is installed with injected hooks, exactly as the register entry does.
 * Calling two `beforeEach` callbacks before the first `afterEach` is what a
 * concurrent subtree produces; the second must be refused, and the run must not
 * finish with an end record.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
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
