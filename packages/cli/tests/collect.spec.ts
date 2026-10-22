/**
 * `cbd collect` — the policy: select by default, build in-process, never hand a
 * runner an empty filter.
 *
 * The fake runner (`support/repo.ts`) reads the same environment a real adapter
 * reads and writes a real shard, so these tests cover the whole bridge: selection
 * and diff → selection file → child environment → shard → map.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from '@japa/runner'
import { EXIT } from '../src/cli.js'
import { invoke, prepared } from './support/repo.js'

interface Logged {
  shard: string
  commit: string
  selection: string | null
  selectionContent: string | null
}

function logOf(path: string): Logged {
  return JSON.parse(readFileSync(path, 'utf8').trim()) as Logged
}

const mapDir = (root: string): string => join(root, '.cbd', 'maps')

test.group('cbd collect', () => {
  test('selects before the run, passes the selection file, and builds after it', () => {
    const { repo, root, a, spec, runner, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')
      const log = join(root, 'log.ndjson')

      const result = invoke(
        root,
        'collect',
        '--',
        process.execPath,
        runner,
        log,
        a,
        spec,
      )

      assert.equal(result.code, EXIT.ok)
      assert.match(result.out.join('\n'), /^selected 2 tests for 1 changed file$/m)
      assert.match(result.out.join('\n'), /^map \.cbd\/maps\/[0-9a-f]{40}\/map\.json: 2 tests/m)

      const logged = logOf(log)
      assert.equal(logged.commit, repo.head())
      assert.equal(typeof logged.selection, 'string')
      assert.match(logged.selection!, /\.cbd\/selection-collect-[^/]+\.json$/)
      assert.equal(logged.shard.startsWith(`${join(root, '.cbd', 'shards')}/`), true)
      const selection = JSON.parse(logged.selectionContent!) as {
        version: number
        tests: Array<{ id: string; file: string | null; title: string }>
      }
      assert.equal(selection.version, 2)
      assert.deepEqual(
        selection.tests.map((test) => test.title),
        ['adds', 'reads'],
      )
      assert.deepEqual(
        selection.tests.map((test) => test.id),
        [`${spec}::adds`, `${spec}::reads`],
      )
    } finally {
      cleanup()
    }
  })

  test('an older shard for the same commit is not merged into the rebuild', () => {
    const { repo, root, a, spec, runner, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      // The base shard was recorded against the committed bytes; this edit makes
      // it stale. It belongs to an earlier run, so the rebuild must use this run's
      // shard and succeed instead of refusing on the older one.
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')
      const log = join(root, 'log.ndjson')

      const result = invoke(root, 'collect', '--', process.execPath, runner, log, a, spec)

      assert.equal(result.code, EXIT.ok, 'a stale shard must not fail the test command')
      assert.doesNotMatch(result.err.join('\n'), /left the map .* unchanged/)
      assert.match(result.out.join('\n'), /^map .*: 2 tests/m)
      const stats = invoke(root, 'stats')
      assert.equal(stats.code, EXIT.ok)
      assert.match(stats.out[1]!, /^2 tests, 1 file reached/)
    } finally {
      cleanup()
    }
  })

  test('the first run has no map, says so, and records everything', () => {
    const { root, a, spec, runner, cleanup } = prepared()
    try {
      const log = join(root, 'log.ndjson')
      const result = invoke(root, 'collect', '--', process.execPath, runner, log, a, spec)

      assert.equal(result.code, EXIT.ok)
      assert.match(result.err.join('\n'), /no map yet; running the full suite/)
      assert.equal(logOf(log).selection, null)
      assert.match(result.out.join('\n'), /^map \.cbd\/maps\/[0-9a-f]{40}\/map\.json: 2 tests/m)
    } finally {
      cleanup()
    }
  })

  test('--no-select records without a selection', () => {
    const { repo, root, a, spec, runner, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')
      const log = join(root, 'log.ndjson')

      const result = invoke(
        root,
        'collect',
        '--no-select',
        '--',
        process.execPath,
        runner,
        log,
        a,
        spec,
      )

      assert.equal(result.code, EXIT.ok)
      assert.equal(logOf(log).selection, null)
      assert.doesNotMatch(result.out.join('\n'), /^selected/)
    } finally {
      cleanup()
    }
  })

  test('an empty selection runs nothing rather than an empty filter', () => {
    const { root, a, spec, runner, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const log = join(root, 'log.ndjson')

      const result = invoke(root, 'collect', '--', process.execPath, runner, log, a, spec)

      assert.equal(result.code, EXIT.ok)
      assert.equal(result.out[0], 'nothing to run: 0 tests selected for 0 changed files')
      assert.equal(existsSync(log), false, 'the test command was never spawned')
    } finally {
      cleanup()
    }
  })

  test('exits with the test command’s status, but still builds', () => {
    const { root, a, spec, runner, cleanup } = prepared()
    try {
      const log = join(root, 'log.ndjson')
      const result = invoke(
        root,
        'collect',
        '--no-select',
        '--',
        process.execPath,
        runner,
        log,
        a,
        spec,
        '2',
      )

      assert.equal(result.code, 2)
      assert.match(result.err.join('\n'), /the test command exited 2/)
      assert.match(result.out.join('\n'), /^map /m, 'a failing suite still leaves a usable map')
    } finally {
      cleanup()
    }
  })

  test('a killed test command leaves no footer, so no map is built', () => {
    const { root, a, spec, runner, cleanup } = prepared()
    try {
      const result = invoke(
        root,
        'collect',
        '--no-select',
        '--',
        process.execPath,
        runner,
        join(root, 'log.ndjson'),
        a,
        spec,
        '0',
        'SIGKILL',
      )

      assert.equal(result.code, EXIT.error)
      assert.match(result.err.join('\n'), /killed by SIGKILL/)
      assert.equal(existsSync(mapDir(root)), false)
    } finally {
      cleanup()
    }
  })

  test('--no-build writes the shard and no map', () => {
    const { root, a, spec, runner, cleanup } = prepared()
    try {
      const result = invoke(
        root,
        'collect',
        '--no-select',
        '--no-build',
        '--',
        process.execPath,
        runner,
        join(root, 'log.ndjson'),
        a,
        spec,
      )

      assert.equal(result.code, EXIT.ok)
      assert.equal(existsSync(mapDir(root)), false)
      const shards = readdirSync(join(root, '.cbd', 'shards'))
      assert.equal(shards.some((name) => name.startsWith('collect-')), true)
    } finally {
      cleanup()
    }
  })

  test('--shard names the file the runner writes', () => {
    const { root, a, spec, runner, cleanup } = prepared()
    try {
      const log = join(root, 'log.ndjson')
      const result = invoke(
        root,
        'collect',
        '--no-select',
        '--no-build',
        '--shard',
        'custom/run.ndjson',
        '--',
        process.execPath,
        runner,
        log,
        a,
        spec,
      )

      assert.equal(result.code, EXIT.ok)
      const shard = join(root, 'custom', 'run.ndjson')
      assert.equal(logOf(log).shard, shard)
      assert.equal(existsSync(shard), true)
    } finally {
      cleanup()
    }
  })

  test('a command that dies before recording is not reported as a shard', () => {
    const { root, cleanup } = prepared()
    try {
      // A module that cannot load is the shape from the field: the wrapper exits
      // non-zero before the runner ever installs the adapter, so no shard exists.
      const result = invoke(root, 'collect', '--', process.execPath, '-e', 'process.exit(1)')

      assert.equal(result.code, EXIT.error)
      const out = result.out.join('\n')
      assert.doesNotMatch(out, /recorded to/)
      assert.match(out, /no tests ran; nothing recorded/)
      // The build is not attempted, so there is no contradictory "no shards"
      // error and no map for a run that never happened.
      assert.doesNotMatch(result.err.join('\n'), /no shards/)
      assert.doesNotMatch(result.err.join('\n'), /cbd: cbd:/)
      const maps = join(root, '.cbd', 'maps')
      assert.equal(existsSync(maps) ? readdirSync(maps).length : 0, 0)
    } finally {
      cleanup()
    }
  })
  test('collect is only collect with "-- <command>"', () => {
    const { root, cleanup } = prepared()
    try {
      const cases: Array<[string[], RegExp]> = [
        [['collect'], /needs a test command after --/],
        [['collect', '--format', 'json', '--', 'node', 'x'], /does not take --format/],
        [['collect', 'node', 'x'], /needs a test command after --/],
        [['build', '--', 'node'], /only collect takes "-- <command>"/],
      ]
      for (const [argv, message] of cases) {
        const result = invoke(root, ...argv)
        assert.equal(result.code, EXIT.usage, argv.join(' '))
        assert.match(result.err.join('\n'), message, argv.join(' '))
      }
    } finally {
      cleanup()
    }
  })
})

test('builds when the adapter writes a derived shard path', () => {
  const { repo, root, a, spec, runner, cleanup } = prepared()
  try {
    repo.write(
      'derived.mjs',
      `import { execFileSync } from 'node:child_process'
import { renameSync } from 'node:fs'
const [runner, ...args] = process.argv.slice(2)
execFileSync(process.execPath, [runner, ...args], { stdio: 'inherit' })
const base = process.env.CBD_SHARD
renameSync(base, base.replace(/\\.ndjson$/, '.derived.ndjson'))
`,
    )
    const log = join(root, 'derived.log')
    const shard = join(root, '.cbd', 'shards', 'custom.ndjson')
    const result = invoke(
      root,
      'collect',
      '--no-select',
      '--shard',
      shard,
      '--',
      process.execPath,
      join(root, 'derived.mjs'),
      join(root, runner),
      log,
      a,
      spec,
    )
    assert.equal(result.code, EXIT.ok)
    assert.match(result.out.join('\n'), /^recorded 1 shard/m)
    assert.match(result.out.join('\n'), /^map /m)
    assert.equal(existsSync(shard), false, 'only the derived path was written')
  } finally {
    cleanup()
  }
})

test('detects a smaller complete rerun at the same shard path', () => {
  const { repo, root, a, spec, runner, cleanup } = prepared()
  try {
    const log = join(root, 'shrink.log')
    const shard = join(root, '.cbd', 'shards', 'fixed.ndjson')
    mkdirSync(dirname(shard), { recursive: true })
    writeFileSync(shard, 'x'.repeat(200_000))
    const result = invoke(
      root,
      'collect',
      '--no-select',
      '--shard',
      shard,
      '--',
      process.execPath,
      join(root, runner),
      log,
      a,
      spec,
    )
    assert.equal(result.code, EXIT.ok)
    assert.match(result.out.join('\n'), /^recorded 1 shard/m)
    assert.match(result.out.join('\n'), /^map /m)
  } finally {
    cleanup()
  }
})
