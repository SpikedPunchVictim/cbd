/**
 * End-to-end tests: the built plugin, real japa, real test files.
 *
 * `adapter.spec.ts` pins the wiring against a stub recorder, which is the right
 * level for "which field does the title come from". It cannot answer the question
 * the package is actually sold on — *does a selection take effect, and does a
 * recorded run name the file a test lives in?* — because both are properties of
 * japa's behaviour rather than of this code. So these spawn a child process
 * running the real thing. A child, because japa's `configure`/`run` are module
 * globals and there is exactly one run per process.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { CBD_SELF_ROOTS } from '@spikedpunch/cbd/adapter'
import { JAPA_SELF_ROOTS } from '../src/self.js'

const BIN = fileURLToPath(new URL('../../bin/e2e.js', import.meta.url))

function runE2e(mode: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [BIN, mode], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** japa's summary line is the count, and japa colour-codes it with escapes. */
function passedCount(stdout: string): number {
  const match = /(\d+) passed/.exec(stdout.replace(/\u001b\[[0-9;]*m/g, ''))
  assert.ok(match !== null, `no "N passed" in output:\n${stdout}`)
  return Number(match[1])
}

type ShardRecord = { type: string; [key: string]: unknown }

function readShard(path: string): ShardRecord[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ShardRecord)
}

// A shared helper the runner entry imports before `configure` runs executes before the
// plugin can start recording. The `register` preload starts it earlier, so those files
// reach the map instead of being unknown to it.
test.group('japa preload e2e', () => {
  const REGISTER = new URL('../src/register.js', import.meta.url).href

  function shardWith(preload: boolean): ShardRecord[] {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-e2e-'))
    try {
      const shard = join(dir, 'shard.ndjson')
      const env: NodeJS.ProcessEnv = { CBD_SHARD: shard }
      if (preload) env.NODE_OPTIONS = `--import ${REGISTER}`
      runE2e('early', env)
      return readShard(shard)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const hasHelper = (records: ShardRecord[]): boolean =>
    records.some(
      (record) =>
        record.type === 'script' && String(record.url).replaceAll('\\', '/').endsWith('/fixture/early/helper.js'),
    )

  test('a module imported before the plugin installs is recorded with the preload', () => {
    assert.ok(hasHelper(shardWith(true)))
  })

  test('a module imported before the plugin installs is absent without the preload', () => {
    assert.ok(!hasHelper(shardWith(false)))
  })

  test('the preload attributes the early execution to load, not to a test', () => {
    const records = shardWith(true)
    const script = records.find(
      (record) =>
        record.type === 'script' && String(record.url).replaceAll('\\', '/').endsWith('/fixture/early/helper.js'),
    )
    assert.ok(script !== undefined, 'the helper has no script record')
    const id = String(script.scriptId)
    const touched = (record: ShardRecord): boolean =>
      id in ((record.touches as Record<string, unknown> | undefined) ?? {})

    assert.ok(records.some((r) => r.type === 'load' && touched(r)), 'load does not hold it')
    assert.deepEqual(
      records.filter((r) => r.type === 'test' && touched(r)).map((r) => r.title),
      [],
    )
  })

  test('the preload is inert when CBD_SHARD is unset', () => {
    const out = runE2e('full', { CBD_SHARD: '', NODE_OPTIONS: `--import ${REGISTER}` })
    assert.equal(passedCount(out), 4)
  })

  test('the plugin joins the preload session instead of starting a second shard', () => {
    const records = shardWith(true)
    assert.equal(records.filter((r) => r.type === 'shard').length, 1)
    assert.equal(records.filter((r) => r.type === 'test').length, 4)
    assert.equal(records.at(-1)?.type, 'end')
  })
})

// A launcher is a Node process that starts the real runner: `pnpm test` and `npm run` are
// both that. `NODE_OPTIONS` reaches it first, so the preload loads there before it loads in
// the runner, and it must leave the recording to the runner.
test.group('japa preload through a launcher', () => {
  const REGISTER = new URL('../src/register.js', import.meta.url).href
  const LAUNCH = 'require("node:child_process").execFileSync(process.execPath, process.argv.slice(1), { stdio: "inherit" })'

  /** `node -e LAUNCH -- node -e LAUNCH -- ... BIN early`: each hop runs the rest as `node <rest>`. */
  function launched(depth: number): ShardRecord[] {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-e2e-'))
    try {
      const shard = join(dir, 'shard.ndjson')
      const hops = Array.from({ length: depth }, () => ['-e', LAUNCH, '--']).flat()
      execFileSync(process.execPath, [...hops, BIN, 'early'], {
        encoding: 'utf8',
        env: { ...process.env, CBD_SHARD: shard, NODE_OPTIONS: `--import ${REGISTER}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return readShard(shard)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const helperScript = (records: ShardRecord[]): boolean =>
    records.some(
      (r) => r.type === 'script' && String(r.url).replaceAll('\\', '/').endsWith('/fixture/early/helper.js'),
    )

  test('the runner records when a launcher loads the preload first', () => {
    const records = launched(1)
    assert.equal(records.filter((r) => r.type === 'shard').length, 1)
    assert.equal(records.filter((r) => r.type === 'test').length, 4)
    assert.ok(helperScript(records), 'the early helper has no script record')
    assert.equal(records.at(-1)?.type, 'end')
  })

  test('the runner records behind two launchers', () => {
    const records = launched(2)
    assert.equal(records.filter((r) => r.type === 'test').length, 4)
    assert.ok(helperScript(records))
  })

  test('a process that never runs japa writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-e2e-'))
    try {
      const shard = join(dir, 'shard.ndjson')
      execFileSync(process.execPath, ['-e', '0'], {
        env: { ...process.env, CBD_SHARD: shard, NODE_OPTIONS: `--import ${REGISTER}` },
        stdio: 'ignore',
      })
      assert.equal(existsSync(shard), false)
      assert.equal(existsSync(`${shard.replace('.ndjson', '')}.service.ndjson`), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a non-adopting process leaves CBD_SHARD for its child', () => {
    const out = execFileSync(
      process.execPath,
      ['-e', 'require("node:child_process").execFileSync(process.execPath, ["-p", "process.env.CBD_SHARD"], { stdio: "inherit" })'],
      {
        encoding: 'utf8',
        env: { ...process.env, CBD_SHARD: 'sentinel.ndjson', NODE_OPTIONS: `--import ${REGISTER}` },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    assert.equal(out.trim(), 'sentinel.ndjson')
  })
})

test.group('japa adapter e2e', () => {
  test('an unselected run runs the whole fixture suite', () => {
    assert.equal(passedCount(runE2e('full')), 4)
  })

  // The product claim, stated as a test: selecting narrows the run.
  test('a selection narrows a real japa run to the selected test', () => {
    assert.equal(passedCount(runE2e('only')), 1)
  })

  test('a recorded run names the file each test was defined in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-e2e-'))
    try {
      const shard = join(dir, 'shard.ndjson')
      runE2e('record', { CBD_SHARD: shard })

      const records = readShard(shard)
      const tests = records.filter((r) => r.type === 'test')

      assert.equal(tests.length, 4)

      // The whole point of A0 F8: the file comes from japa, not from a stack walk
      // or from parsing the test source. Each name is checked against the file it
      // *should* be in, so a shard that merely had some non-null file would fail.
      const fileOf = (title: string): unknown =>
        tests.find((t) => t.title === title)?.file
      for (const title of ['alpha-lone', 'alpha-grouped']) {
        assert.match(String(fileOf(title)), /fixture[\\/]tests[\\/]a\.spec\.js$/, title)
      }
      for (const title of ['beta-lone', 'beta-grouped']) {
        assert.match(String(fileOf(title)), /fixture[\\/]tests[\\/]b\.spec\.js$/, title)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // `cbd-qly`. The adapter and the recorder run inside every window, and a
  // workspace link resolves outside node_modules, so the default prefilter does
  // not hide them here — exactly the install shape this repository uses.
  test("a recorded run contains none of the tool's own files", () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-e2e-'))
    try {
      const shard = join(dir, 'shard.ndjson')
      runE2e('record', { CBD_SHARD: shard })

      // A v2 shard names files once, in its script table; if the tool's own files
      // were recorded at all, this is where they would appear.
      const roots = [...CBD_SELF_ROOTS, ...JAPA_SELF_ROOTS]
      const own: unknown[] = []
      for (const record of readShard(shard)) {
        if (record.type !== 'script') continue
        const url = record.url
        if (typeof url !== 'string') continue
        const file = fileURLToPath(url)
        if (roots.some((root) => file === root || file.startsWith(`${root}/`))) own.push(record)
      }
      assert.deepEqual(own, [], 'the adapter and core must not appear in the shards they write')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a recorded run brackets the suite with a header and a footer', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-e2e-'))
    try {
      const shard = join(dir, 'shard.ndjson')
      runE2e('record', { CBD_SHARD: shard })

      const records = readShard(shard)
      assert.equal(records.at(0)?.type, 'shard')
      assert.equal(records.at(0)?.commit, 'e2e')
      assert.equal(records.at(-1)?.type, 'end')
      assert.equal(records.at(-1)?.tests, 4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
