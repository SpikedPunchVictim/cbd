/**
 * `cbd collect` — the policy: select by default, build in-process, never hand a
 * runner an empty filter.
 *
 * The fake runner (`support/repo.ts`) reads the same environment a real adapter
 * reads and writes a real shard, so these tests cover the whole bridge: selection
 * and diff → selection file → child environment → shard → map.
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from '@japa/runner'
import { loadMap } from '@spikedpunch/cbd'
import { inspectorLockPath, resolveInspectorTarget } from '@spikedpunch/cbd/adapter'
import { EXIT } from '../src/cli.js'
import { invoke, prepared, shardText } from './support/repo.js'

interface Logged {
  shard: string
  commit: string
  selection: string | null
  selectionContent: string | null
  inspect: string | null
  allowRemote: string | null
  granularity: string | null
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

  test('the config granularity reaches the test process, and only "group" is set', () => {
    const plain = prepared()
    try {
      invoke(plain.root, 'collect', '--', process.execPath, plain.runner, join(plain.root, 'log.ndjson'), plain.a, plain.spec)
      assert.equal(logOf(join(plain.root, 'log.ndjson')).granularity, null)
    } finally {
      plain.cleanup()
    }

    const grouped = prepared({ config: { granularity: 'group' } })
    try {
      const result = invoke(
        grouped.root,
        'collect',
        '--',
        process.execPath,
        grouped.runner,
        join(grouped.root, 'log.ndjson'),
        grouped.a,
        grouped.spec,
      )
      assert.equal(result.code, EXIT.ok)
      assert.equal(logOf(join(grouped.root, 'log.ndjson')).granularity, 'group')
    } finally {
      grouped.cleanup()
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

  test('a failing run exits with the test command’s status and builds no map', () => {
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
      assert.match(result.err.join('\n'), /no map was built/)
      assert.doesNotMatch(result.out.join('\n'), /^map /m)
    } finally {
      cleanup()
    }
  })

  test('a failing run leaves the existing map untouched', () => {
    const { repo, root, a, spec, runner, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const map = join(mapDir(root), repo.head(), 'map.json')
      const before = readFileSync(map, 'utf8')
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      const result = invoke(
        root,
        'collect',
        '--',
        process.execPath,
        runner,
        join(root, 'log.ndjson'),
        a,
        spec,
        '1',
      )

      assert.equal(result.code, 1)
      assert.match(result.err.join('\n'), /no map was built/)
      assert.equal(readFileSync(map, 'utf8'), before)
    } finally {
      cleanup()
    }
  })

  test('a narrowed run keeps the tests it skipped in the rebuilt map', () => {
    const { repo, root, a, spec, runner, cleanup } = prepared()
    try {
      const b = join(root, 'src', 'b.ts')
      const bSpec = join(root, 'tests', 'b.spec.ts')
      repo.write('src/b.ts', 'export function sub(a, b) {\n  return a - b;\n}\n')
      repo.write('tests/b.spec.ts', "import { sub } from '../src/b.js'\n")
      const head = repo.commit('add b')
      writeFileSync(
        join(root, '.cbd', 'shards', 'run.ndjson'),
        shardText(head, [
          { title: 'adds', file: spec, touches: [[a, 'add@0', 1, 3]] },
          { title: 'reads', file: spec, touches: [[a, 'add@0', 1, 3]] },
          { title: 'subtracts', file: bSpec, touches: [[b, 'sub@0', 1, 3]] },
        ]),
      )
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      const result = invoke(
        root,
        'collect',
        '--',
        process.execPath,
        runner,
        join(root, 'log.ndjson'),
        a,
        spec,
      )

      assert.equal(result.code, EXIT.ok)
      assert.match(result.out.join('\n'), /^selected 2 tests for 1 changed file$/m)
      const titles = loadMap(root, head).map.tests.map((entry) => entry.title).sort()
      assert.deepEqual(titles, ['adds', 'reads', 'subtracts'])
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

test.group('cbd collect --target', () => {
  // The recorder lives in the test process, so the target travels there in the
  // environment the adapter already reads. The CLI's own copy of the value is only
  // for the checks it makes before spawning.
  test('hands the target to the test command, and allow-remote with it', () => {
    const { root, a, spec, runner, cleanup } = prepared()
    try {
      const log = join(root, 'log.ndjson')
      const result = invoke(
        root,
        'collect',
        '--no-select',
        '--no-build',
        '--target',
        '127.0.0.1:9230',
        '--allow-remote',
        '--',
        process.execPath,
        runner,
        log,
        a,
        spec,
      )
      assert.equal(result.code, EXIT.ok, result.err.join('\n'))
      const logged = logOf(log)
      assert.equal(logged.inspect, '127.0.0.1:9230')
      assert.equal(logged.allowRemote, '1')
    } finally {
      cleanup()
    }
  })

  test('a loopback target needs no allow-remote', () => {
    const { root, a, spec, runner, cleanup } = prepared()
    try {
      const log = join(root, 'log.ndjson')
      const result = invoke(
        root,
        'collect',
        '--no-select',
        '--no-build',
        '--target',
        '9230',
        '--',
        process.execPath,
        runner,
        log,
        a,
        spec,
      )
      assert.equal(result.code, EXIT.ok, result.err.join('\n'))
      assert.equal(logOf(log).inspect, '9230')
      assert.equal(logOf(log).allowRemote, null)
    } finally {
      cleanup()
    }
  })

  test('--allow-remote alone is a usage error', () => {
    const { root, cleanup } = prepared()
    try {
      const result = invoke(root, 'collect', '--allow-remote', '--', process.execPath, '-e', '0')
      assert.equal(result.code, EXIT.usage)
      assert.match(result.err.join('\n'), /--allow-remote needs --target/)
    } finally {
      cleanup()
    }
  })

  test('a target that cannot be read is a usage error, and nothing runs', () => {
    const { root, a, spec, runner, cleanup } = prepared()
    try {
      const log = join(root, 'log.ndjson')
      const result = invoke(
        root,
        'collect',
        '--target',
        'not-a-target',
        '--',
        process.execPath,
        runner,
        log,
        a,
        spec,
      )
      assert.equal(result.code, EXIT.usage)
      assert.match(result.err.join('\n'), /not a target/)
      assert.equal(existsSync(log), false, 'the suite must not be spawned')
    } finally {
      cleanup()
    }
  })

  // The attach happens in the test process, where the refusal would arrive as a
  // runner stack trace after the suite had started. Checking first is the point.
  test('a target another collector holds is refused before anything runs', () => {
    const { root, a, spec, runner, cleanup } = prepared()
    const origin = resolveInspectorTarget({ port: 9230 }).origin
    const lock = inspectorLockPath(origin)
    mkdirSync(dirname(lock), { recursive: true })
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, origin, token: 'held' }))
      const log = join(root, 'log.ndjson')
      const result = invoke(
        root,
        'collect',
        '--target',
        '9230',
        '--',
        process.execPath,
        runner,
        log,
        a,
        spec,
      )
      assert.equal(result.code, EXIT.error)
      const err = result.err.join('\n')
      assert.match(err, /already being recorded/)
      assert.doesNotMatch(err, /^\s+at /m, 'the refusal is one line, not a stack trace')
      assert.equal(existsSync(log), false, 'the suite must not be spawned')
    } finally {
      rmSync(lock, { force: true })
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

test.group('cbd collect environment', () => {
  // The child inherits the shell's environment. A selection exported by an earlier
  // run is not one this run asked for, and a mode-all run that quietly recorded a
  // subset wrote a map that under-selects from then on.
  test('a stale CBD_SELECTION does not narrow a run that selected nothing', () => {
    const { root, a, spec, runner, cleanup } = prepared()
    const previous = process.env.CBD_SELECTION
    try {
      const selection = join(root, '.cbd', 'stale.json')
      mkdirSync(dirname(selection), { recursive: true })
      writeFileSync(
        selection,
        JSON.stringify({ version: 2, tests: [{ id: `${spec}::adds`, file: spec, title: 'adds' }] }),
      )
      process.env.CBD_SELECTION = selection

      const log = join(root, 'log.ndjson')
      const result = invoke(
        root,
        'collect',
        '--no-select',
        '--no-build',
        '--',
        process.execPath,
        runner,
        log,
        a,
        spec,
      )
      assert.equal(result.code, EXIT.ok, result.err.join('\n'))
      assert.equal(logOf(log).selection, null, 'the child must not see an inherited selection')
    } finally {
      if (previous === undefined) delete process.env.CBD_SELECTION
      else process.env.CBD_SELECTION = previous
      cleanup()
    }
  })

  // `cbd build` discovers shards by extension, so a path without one is written and
  // then never read: collect reported "nothing recorded" while a valid shard sat on
  // disk.
  test('--shard must name a .ndjson file', () => {
    const { root, cleanup } = prepared()
    try {
      const result = invoke(
        root,
        'collect',
        '--shard',
        'custom/run.txt',
        '--',
        process.execPath,
        '-e',
        '0',
      )
      assert.equal(result.code, EXIT.usage)
      assert.match(result.err.join('\n'), /--shard must name a \.ndjson file/)
    } finally {
      cleanup()
    }
  })

  // The file names a test set for this run only. A failed build used to return
  // before the cleanup, leaving it for nothing to read.
  test('a failed build removes the selection file it wrote', () => {
    const { repo, root, a, spec, runner, cleanup } = prepared()
    const outside = mkdtempSync(join(tmpdir(), 'cbd-collect-env-'))
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')
      const wrapper = join(outside, 'wrapper.mjs')
      writeFileSync(
        wrapper,
        `import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
execFileSync(process.execPath, [process.argv[2], ...process.argv.slice(3)], { stdio: 'inherit' })
appendFileSync(process.env.CBD_SHARD, 'not json\\n')
`,
      )

      const result = invoke(
        root,
        'collect',
        '--',
        process.execPath,
        wrapper,
        join(root, runner),
        join(outside, 'log.ndjson'),
        a,
        spec,
      )

      assert.equal(result.code, EXIT.error)
      const left = readdirSync(join(root, '.cbd')).filter((name) => name.startsWith('selection-'))
      assert.deepEqual(left, [])
    } finally {
      rmSync(outside, { recursive: true, force: true })
      cleanup()
    }
  })
})

// An inherited CBD_INSPECT is the same target by another route — the adapter will
// attach to it — so the CLI's checks have to run for it too, before the suite starts.
test('an inherited CBD_INSPECT is checked like --target', () => {
  const { root, cleanup } = prepared()
  const previous = process.env.CBD_INSPECT
  try {
    process.env.CBD_INSPECT = '10.0.0.5:9229'
    const log = join(root, 'log.ndjson')
    const result = invoke(root, 'collect', '--', process.execPath, '-e', '0')
    assert.equal(result.code, EXIT.usage)
    assert.match(result.err.join('\n'), /allowRemote/)
    assert.equal(existsSync(log), false)
  } finally {
    if (previous === undefined) delete process.env.CBD_INSPECT
    else process.env.CBD_INSPECT = previous
    cleanup()
  }
})
