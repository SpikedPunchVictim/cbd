/**
 * The four read commands, through their real surface: argv in, exit code and
 * lines out.
 *
 * Real git and a real map, because the contract being tested is not "does the
 * renderer format a struct" — it is that the answer a person sees and the exit
 * code a script branches on come from the same selection. A stubbed factory would
 * leave the wiring between them untested.
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { EXIT } from '../src/cli.js'
import { tempRepo } from './support/git.js'
import { invoke, prepared } from './support/repo.js'

test.group('cbd build', () => {
  test('merges the commit’s shards and reports the map it wrote', () => {
    const { root, cleanup } = prepared()
    try {
      const result = invoke(root, 'build')
      assert.equal(result.code, EXIT.ok)
      assert.match(result.out.join('\n'), /^map \.cbd\/maps\/[0-9a-f]{40}\/map\.json: 2 tests, 1 file from 1 shard/)
      assert.deepEqual(result.err, [])
    } finally {
      cleanup()
    }
  })

  test('--format json is the verb’s result, not a rendering of it', () => {
    const { root, cleanup } = prepared()
    try {
      const result = invoke(root, 'build', '--format', 'json')
      assert.equal(result.code, EXIT.ok)
      const parsed = JSON.parse(result.out.join('\n')) as { tests: number; shards: string[] }
      assert.equal(parsed.tests, 2)
      assert.deepEqual(parsed.shards, ['.cbd/shards/run.ndjson'])
    } finally {
      cleanup()
    }
  })
})

test.group('cbd select', () => {
  test('a changed function selects its tests, and exits 0', () => {
    const { repo, root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      const result = invoke(root, 'select')
      assert.equal(result.code, EXIT.ok)
      assert.ok(result.out.includes('tests/a.spec.ts > adds'))
      assert.ok(result.out.includes('tests/a.spec.ts > reads'))
      assert.match(result.out.at(-1)!, /^2 tests for 1 changed file \(map [0-9a-f]{7}, up to date\)$/)
    } finally {
      cleanup()
    }
  })

  test('no changes is an empty subset, not "all"', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const result = invoke(root, 'select')
      assert.equal(result.code, EXIT.ok)
      assert.match(result.out.at(-1)!, /^0 tests for 0 changed files \(map [0-9a-f]{7}, up to date\)$/)
      assert.doesNotMatch(result.out.join('\n'), /^all tests/)
    } finally {
      cleanup()
    }
  })

  test('a file the map has never seen exits 3 and says why', () => {
    const { repo, root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/other.ts', 'export const other = 1;\n')
      repo.commit('after the map')

      const result = invoke(root, 'select')
      assert.equal(result.code, EXIT.all)
      assert.match(result.out.join('\n'), /all tests: unknown-file \(src\/other\.ts\)/)
      assert.match(result.out.at(-1)!, /^all tests for 1 changed file/)
    } finally {
      cleanup()
    }
  })

  test('--no-worktree compares the map commit with HEAD, not the dirty tree', () => {
    const { repo, root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      assert.match(invoke(root, 'select').out.at(-1)!, /^2 tests for 1 changed file/)
      const head = invoke(root, 'select', '--no-worktree')
      assert.equal(head.code, EXIT.ok)
      assert.match(head.out.at(-1)!, /^0 tests for 0 changed files/)
    } finally {
      cleanup()
    }
  })

  test('--format json carries the selection and the resolved tests', () => {
    const { repo, root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      const result = invoke(root, 'select', '--format', 'json')
      assert.equal(result.code, EXIT.ok)
      const parsed = JSON.parse(result.out.join('\n')) as {
        selection: { mode: string; tests: number[] }
        selected: Array<{ title: string }>
      }
      assert.equal(parsed.selection.mode, 'subset')
      assert.deepEqual(parsed.selection.tests, [0, 1])
      assert.deepEqual(parsed.selected.map((entry) => entry.title), ['adds', 'reads'])
    } finally {
      cleanup()
    }
  })

  test('a config that ignores unknown files turns "all" into an empty subset', () => {
    const { repo, root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/other.ts', 'export const other = 1;\n')
      repo.commit('after the map')
      writeFileSync(join(root, 'cbd.config.json'), JSON.stringify({ unknownPolicy: 'ignore' }))

      const result = invoke(root, 'select')
      assert.equal(result.code, EXIT.ok)
      // Two changes: src/other.ts and the untracked cbd.config.json written above.
      // Untracked files are changes in worktree mode (`cbd-0na.1`).
      assert.match(result.out.at(-1)!, /^0 tests for 2 changed files/)
    } finally {
      cleanup()
    }
  })

  test('an untracked source file is a change and escalates', () => {
    const { repo, root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      // Never added to the index: `git diff` cannot see it, but a select-mode run
      // must not treat the tree as unchanged (`cbd-0na.1`).
      repo.write('src/untracked.ts', 'export const surprise = 1;\n')

      const result = invoke(root, 'select', '--format', 'json')
      assert.equal(result.code, EXIT.all)
      const parsed = JSON.parse(result.out.join('\n')) as {
        selection: { mode: string; ignored: string[] }
        changes: Array<{ path: string }>
      }
      assert.equal(parsed.selection.mode, 'all')
      assert.ok(parsed.changes.some((change) => change.path.endsWith('/src/untracked.ts')))
    } finally {
      cleanup()
    }
  })

  test('a change outside include is named in selection.ignored', () => {
    const { repo, root, cleanup } = prepared()
    try {
      writeFileSync(join(root, 'cbd.config.json'), JSON.stringify({ include: ['src/**'] }))
      repo.write('docs/readme.md', '# docs\n')
      assert.equal(invoke(root, 'build').code, EXIT.ok)

      const result = invoke(root, 'select', '--format', 'json')
      assert.equal(result.code, EXIT.ok)
      const parsed = JSON.parse(result.out.join('\n')) as {
        selection: { ignored: string[] }
      }
      assert.ok(
        parsed.selection.ignored.some((path) => path.endsWith('/docs/readme.md')),
        `expected docs/readme.md in ignored, got ${JSON.stringify(parsed.selection.ignored)}`,
      )

      const text = invoke(root, 'select')
      assert.equal(text.code, EXIT.ok)
      // The config itself is outside include too, and is named rather than hidden.
      assert.match(
        text.out.join('\n'),
        /ignored 2 changed files: cbd\.config\.json, docs\/readme\.md/,
      )
    } finally {
      cleanup()
    }
  })

  test('an alwaysSelect entry is added to a triggered subset', () => {
    const { repo, root, cleanup } = prepared()
    try {
      writeFileSync(
        join(root, 'cbd.config.json'),
        JSON.stringify({
          include: ['src/**'],
          alwaysSelect: [{ tests: ['tests/a.spec.ts > adds'] }],
        }),
      )
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      const result = invoke(root, 'select', '--format', 'json')
      assert.equal(result.code, EXIT.ok)
      const parsed = JSON.parse(result.out.join('\n')) as {
        selection: { mode: string; tests: number[]; reasons: Array<{ kind: string }> }
      }
      assert.equal(parsed.selection.mode, 'subset')
      assert.ok(parsed.selection.reasons.some((reason) => reason.kind === 'always'))
      assert.deepEqual(parsed.selection.tests, [0, 1])
    } finally {
      cleanup()
    }
  })

  test('no map is a failure, not "run all"', () => {
    const repo = tempRepo()
    try {
      repo.write('src/a.ts', 'export const a = 1;\n')
      repo.commit('base')
      const result = invoke(repo.root, 'select')
      assert.equal(result.code, EXIT.error)
      assert.match(result.err.join('\n'), /no map in the last 200 commits/)
      assert.deepEqual(result.out, [])
    } finally {
      repo.cleanup()
    }
  })
})

test.group('cbd explain and stats', () => {
  test('explain names the tests that reach a line and the function they came through', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const result = invoke(root, 'explain', 'src/a.ts:2')
      assert.equal(result.code, EXIT.ok)
      assert.equal(result.out[0], 'src/a.ts:2 — 2 tests')
      assert.match(result.out.join('\n'), /functions: add@0/)
      assert.deepEqual(result.out.slice(-2), ['  adds', '  reads'])
    } finally {
      cleanup()
    }
  })

  test('explain a file outside the map says select would run all', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const result = invoke(root, 'explain', 'src/nope.ts')
      assert.equal(result.code, EXIT.ok)
      assert.match(result.out[0]!, /not in the map: select runs all/)
    } finally {
      cleanup()
    }
  })

  test('reaches answers for one test, and says when the target is unknown', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)

      const yes = invoke(root, 'reaches', 'adds', 'src/a.ts:2')
      assert.equal(yes.code, EXIT.ok)
      assert.match(yes.out[0]!, /^adds \(tests\/a\.spec\.ts\) reaches src\/a\.ts:2$/)
      assert.ok(yes.out.some((line) => line.includes('add@0')))

      const unknown = invoke(root, 'reaches', 'adds', 'src/nope.ts')
      assert.equal(unknown.code, EXIT.ok)
      assert.match(unknown.out[0]!, /does not reach src\/nope\.ts \(file not in the map/)
    } finally {
      cleanup()
    }
  })

  test('reaches needs both a title and a target', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const result = invoke(root, 'reaches', 'adds')
      assert.equal(result.code, EXIT.usage)
      assert.match(result.err.join('\n'), /reaches needs a <test-title>/)
    } finally {
      cleanup()
    }
  })

  test('stats reports the map’s shape', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const result = invoke(root, 'stats')
      assert.equal(result.code, EXIT.ok)
      assert.match(result.out[0]!, /^map [0-9a-f]{7} \(up to date, clean tree, built /)
      assert.equal(result.out[1], '2 tests, 1 file reached, 1 file seen, 0 files untested')
      assert.equal(result.out[2], 'buckets: load 0, between 0, teardown 0')
      assert.equal(result.out[3], 'test files: 1 (median 2, p90 2, max 2)')
      assert.equal(
        result.out[4],
        'code: 1 function in 1 file (per file median 1, p90 1, max 1); ' +
          'tests per function median 2, p90 2, max 2',
      )
      assert.equal(result.out[5], 'most-tested files:')
      assert.equal(result.out[6], '  src/a.ts: 2 tests, 1 function')
      assert.equal(result.out.length, 7, 'no untested section when there is nothing to name')
    } finally {
      cleanup()
    }
  })

  test('stats names the files no test reaches, and says what it cannot name', () => {
    const { root, cleanup } = prepared({ buckets: { load: [['src/seen-only.ts', 'setup@0', 1, 2]] } })
    try {
      // The shard fixture created the file. Rewriting it here would change the
      // bytes its offsets were measured against, and the v2 build refuses such a
      // shard.
      assert.equal(invoke(root, 'build').code, EXIT.ok)

      const result = invoke(root, 'stats')
      assert.equal(result.code, EXIT.ok)
      assert.equal(result.out[1], '2 tests, 1 file reached, 2 files seen, 1 file untested')
      assert.deepEqual(result.out.slice(7), [
        'untested (seen, no test reaches):',
        '  src/seen-only.ts',
        '  a file no run loaded is unknown, not untested: select runs all for it',
      ])
    } finally {
      cleanup()
    }
  })

  test('stats --format json carries every untested file, not just the count', () => {
    const { root, cleanup } = prepared({
      buckets: {
        load: [
          ['src/b-only.ts', 'b@0', 1, 2],
          ['src/a-only.ts', 'a@0', 1, 2],
        ],
      },
    })
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const result = invoke(root, 'stats', '--format', 'json')
      const parsed = JSON.parse(result.out.join('\n')) as {
        untested: number
        untestedFiles: string[]
      }
      assert.equal(parsed.untested, 2)
      assert.deepEqual(parsed.untestedFiles, [
        join(root, 'src/a-only.ts'),
        join(root, 'src/b-only.ts'),
      ])
    } finally {
      cleanup()
    }
  })

  test('explain calls a seen-but-unexecuted file untested rather than unknown', () => {
    const { root, cleanup } = prepared({ buckets: { load: [['src/seen-only.ts', 'setup@0', 1, 2]] } })
    try {
      // The shard fixture created the file. Rewriting it here would change the
      // bytes its offsets were measured against, and the v2 build refuses such a
      // shard.
      assert.equal(invoke(root, 'build').code, EXIT.ok)

      const file = invoke(root, 'explain', 'src/seen-only.ts')
      assert.equal(file.out[0], 'src/seen-only.ts — 0 tests (seen, no test reaches it)')
      assert.equal(file.out[1], '  reached at load')

      const line = invoke(root, 'explain', 'src/seen-only.ts:2')
      assert.equal(line.out[0], 'src/seen-only.ts:2 — 0 tests (seen, no test reaches it)')
      assert.equal(line.out[1], '  reached at load')
      assert.ok(line.out.includes('  nothing in the file was executed'))
      assert.doesNotMatch(line.out.join('\n'), /outside every function/)
    } finally {
      cleanup()
    }
  })
})

test.group('cbd gc', () => {
  /** Makes an old file or directory, so "newest" is the test's decision. */
  const aged = (path: string, hours: number): void => {
    const when = new Date(Date.UTC(2026, 9, 1) + hours * 3_600_000)
    utimesSync(path, when, when)
  }

  test('keeps the newest runs of each pool and reports what it reclaimed', () => {
    const repo = tempRepo()
    try {
      repo.write('src/a.ts', 'export const a = 1\n')
      repo.commit('base')
      const root = realpathSync(repo.root)
      const shards = join(root, '.cbd', 'shards')
      mkdirSync(shards, { recursive: true })
      for (const [index, name] of ['one', 'two', 'three', 'four'].entries()) {
        const path = join(shards, `${name}.ndjson`)
        writeFileSync(path, name)
        aged(path, index)
      }
      const maps = join(root, '.cbd', 'maps')
      for (const [index, name] of ['m1', 'm2', 'm3', 'm4'].entries()) {
        const dir = join(maps, name)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'map.json'), '{}')
        aged(dir, index)
      }

      const result = invoke(root, 'gc', '--keep', '2', '--format', 'json')
      assert.equal(result.code, EXIT.ok)
      assert.deepEqual(JSON.parse(result.out.join('\n')), {
        keep: 2,
        shards: { kept: 2, removed: 2 },
        maps: { kept: 2, removed: 2 },
        // 'one' + 'two' (3 each) and two map.json files (2 each).
        bytes: 10,
      })
      assert.deepEqual(readdirSync(shards).sort(), ['four.ndjson', 'three.ndjson'])
      assert.deepEqual(readdirSync(maps).sort(), ['m3', 'm4'])
    } finally {
      repo.cleanup()
    }
  })

  test('keeps the map select is using, even when newer maps push it out', () => {
    const repo = tempRepo()
    try {
      repo.write('src/a.ts', 'export const a = 1\n')
      const head = repo.commit('base')
      const root = realpathSync(repo.root)
      const maps = join(root, '.cbd', 'maps')
      const current = join(maps, head)
      mkdirSync(current, { recursive: true })
      writeFileSync(join(current, 'map.json'), '{}')
      aged(current, 0)
      for (const [index, name] of ['newer-1', 'newer-2'].entries()) {
        const dir = join(maps, name)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'map.json'), '{}')
        aged(dir, index + 1)
      }

      const result = invoke(root, 'gc', '--keep', '1', '--format', 'json')
      assert.equal(result.code, EXIT.ok)
      assert.deepEqual((JSON.parse(result.out.join('\n')) as { maps: unknown }).maps, {
        kept: 2,
        removed: 1,
      })
      assert.ok(existsSync(join(current, 'map.json')), 'the map select would read survives')
      assert.ok(existsSync(join(maps, 'newer-2')), 'the newest map survives')
      assert.ok(!existsSync(join(maps, 'newer-1')), 'and only the excess is removed')
    } finally {
      repo.cleanup()
    }
  })

  test('an empty state directory is nothing to do, not an error', () => {
    const repo = tempRepo()
    try {
      repo.write('src/a.ts', 'export const a = 1\n')
      repo.commit('base')
      const result = invoke(repo.root, 'gc')
      assert.equal(result.code, EXIT.ok)
      assert.deepEqual(result.out, ['kept 0 shards and 0 maps, nothing to remove'])
    } finally {
      repo.cleanup()
    }
  })

  test('the text line says what was kept and what was freed', () => {
    const repo = tempRepo()
    try {
      repo.write('src/a.ts', 'export const a = 1\n')
      repo.commit('base')
      const shards = join(repo.root, '.cbd', 'shards')
      mkdirSync(shards, { recursive: true })
      writeFileSync(join(shards, 'old.ndjson'), 'x'.repeat(2048))
      aged(join(shards, 'old.ndjson'), 0)
      writeFileSync(join(shards, 'new.ndjson'), 'y')
      aged(join(shards, 'new.ndjson'), 1)

      const result = invoke(repo.root, 'gc', '--keep', '1')
      assert.equal(result.code, EXIT.ok)
      assert.deepEqual(result.out, ['kept 1 shard and 0 maps, removed 1 shard and 0 maps (2 kB)'])
    } finally {
      repo.cleanup()
    }
  })

  test('--keep must be a positive integer', () => {
    const repo = tempRepo()
    try {
      for (const value of ['0', '-1', 'two']) {
        const result = invoke(repo.root, 'gc', '--keep', value)
        assert.equal(result.code, EXIT.usage, `--keep ${value} should be refused`)
        assert.match(result.err.join('\n'), /--keep must be a positive integer/)
        assert.deepEqual(result.out, [])
      }
    } finally {
      repo.cleanup()
    }
  })
})

test.group('the command line itself', () => {
  test('--help explains the commands and the all exit code', () => {
    const repo = tempRepo()
    try {
      const result = invoke(repo.root, '--help')
      assert.equal(result.code, EXIT.ok)
      assert.match(result.out[0]!, /^cbd — run the tests/)
      assert.match(result.out.join('\n'), /exits 0 when it selected a subset and 3/)
    } finally {
      repo.cleanup()
    }
  })

  test('mistakes are usage errors with an explanation, not a stack trace', () => {
    const repo = tempRepo()
    try {
      const cases: Array<[string[], RegExp]> = [
        [[], /missing command/],
        [['nope'], /unknown command "nope"/],
        [['explain'], /needs one <file>/],
        [['build', 'extra'], /unexpected argument "extra"/],
        [['build', '--nope'], /unknown flag --nope/],
        [['build', '--partial=yes'], /does not take a value/],
        [['stats', '--partial'], /does not take --partial/],
        [['select', '--format', 'xml'], /--format must be/],
        [['select', '--format'], /--format needs a value/],
      ]
      for (const [argv, message] of cases) {
        const result = invoke(repo.root, ...argv)
        assert.equal(result.code, EXIT.usage, argv.join(' '))
        assert.match(result.err.join('\n'), message, argv.join(' '))
        assert.deepEqual(result.out, [], argv.join(' '))
      }
    } finally {
      repo.cleanup()
    }
  })

  test('an explicit --config that does not exist is an error; the default may be absent', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      assert.equal(invoke(root, 'stats').code, EXIT.ok, 'the default config is optional')

      const missing = invoke(root, 'stats', '--config', 'nope.json')
      assert.equal(missing.code, EXIT.error)
      assert.match(missing.err.join('\n'), /config file not found/)
    } finally {
      cleanup()
    }
  })
})
