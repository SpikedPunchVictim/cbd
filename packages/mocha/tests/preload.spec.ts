/**
 * The preload runs in every node process that inherits `NODE_OPTIONS`.
 *
 * That is how the adapter reaches a run nobody edited, and it is also how a test's
 * child process reaches it. Only the runner may write the run's one shard: a child
 * that reset it would erase every test recorded before it started.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
// Compiled, this spec lives in `dist/tests`, so `../src` is `dist/src`.
const AUTO = fileURLToPath(new URL('../src/auto.js', import.meta.url))

/**
 * A runner-shaped process that starts a child and reports its own pid.
 *
 * The child inherits everything the runner has left in its environment — which is
 * the question: whether the preload cleared `CBD_SHARD` before a test could spawn
 * one.
 */
const DRIVER = `import { spawnSync } from 'node:child_process'
const child = spawnSync(process.execPath, ['-e', '0'], { stdio: 'inherit' })
if (child.status !== 0) process.exit(1)
process.stdout.write(String(process.pid))
`

test('a child process spawned by the runner does not touch the shard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-mocha-preload-'))
  const shard = join(dir, 'run.ndjson')
  const driver = join(dir, 'driver.mjs')
  writeFileSync(shard, '')
  writeFileSync(driver, DRIVER)
  try {
    const runner = spawnSync(process.execPath, [driver], {
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        CBD_SHARD: shard,
        CBD_COMMIT: 'c0ffee',
        NODE_OPTIONS: `--import ${AUTO}`,
      },
      encoding: 'utf8',
    })
    assert.equal(runner.status, 0, runner.stderr)

    const [header] = readFileSync(shard, 'utf8').trim().split('\n')
    assert.ok(header !== undefined)
    // The runner's own preload wrote this header. A second process resetting the
    // file would have replaced it with its own pid, which is the loss this test
    // exists for: every record the runner had written would be gone.
    assert.equal((JSON.parse(header) as { pid: number }).pid, Number(runner.stdout))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
