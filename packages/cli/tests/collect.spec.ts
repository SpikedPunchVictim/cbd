/**
 * `cbd collect` — the policy: select by default, build in-process, never hand a
 * runner an empty filter.
 *
 * The fake runner (`support/repo.ts`) reads the same environment a real adapter
 * reads and writes a real shard, so these tests cover the whole bridge: selection
 * and diff → selection file → child environment → shard → map.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { EXIT } from '../src/cli.js'
import { invoke, prepared } from './support/repo.js'

interface Logged {
  shard: string
  commit: string
  selection: string | null
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
      // A v2 shard records each script's size and mtime; editing a recorded file
      // makes the old shard stale and the rebuild refuses it (the map already
      // built for the base commit is untouched — see the next test). This test is
      // about the successful rebuild, so the old shard is dropped.
      rmSync(join(root, '.cbd', 'shards', 'run.ndjson'))
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
      assert.match(logged.selection!, /\.cbd\/selection\.json$/)
      assert.equal(logged.shard.startsWith(`${join(root, '.cbd', 'shards')}/`), true)
      const selection = JSON.parse(readFileSync(logged.selection!, 'utf8')) as {
        titles: string[]
      }
      assert.deepEqual(selection.titles, ['adds', 'reads'])
    } finally {
      cleanup()
    }
  })

  test('a stale earlier shard leaves the existing map untouched rather than failing the run', () => {
    const { repo, root, a, spec, runner, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      // The base shard was recorded against the committed bytes; this edit makes
      // it stale. The map for the base commit is already built and is what
      // selection uses, so the rebuild is refused without failing the suite.
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')
      const log = join(root, 'log.ndjson')

      const result = invoke(root, 'collect', '--', process.execPath, runner, log, a, spec)

      assert.equal(result.code, EXIT.ok, 'a stale shard must not fail the test command')
      assert.match(result.err.join('\n'), /left the map .* unchanged/)
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
