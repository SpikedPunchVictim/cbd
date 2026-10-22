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
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { MAP_VERSION, saveMap, type CoverageMap } from '@spikedpunch/cbd'
import { defaultRoot, parseArgs } from '../src/args.js'
import { EXIT } from '../src/cli.js'
import { tempRepo } from './support/git.js'
import { invoke, prepared, shardText } from './support/repo.js'

test.group('cbd --version', () => {
  test('prints the CLI and core versions, in text and JSON', () => {
    const repo = tempRepo()
    try {
      const cli = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      ) as { version: string }
      const core = JSON.parse(
        readFileSync(new URL('../../../core/package.json', import.meta.url), 'utf8'),
      ) as { version: string }

      const text = invoke(repo.root, '--version')
      assert.equal(text.code, EXIT.ok)
      assert.equal(text.out[0], `cbd ${cli.version} (@spikedpunch/cbd ${core.version})`)

      const json = invoke(repo.root, '--version', '--format', 'json')
      assert.equal(json.code, EXIT.ok)
      const parsed = JSON.parse(json.out.join('\n')) as {
        cli: string
        core: string
        adapterContract: number
        capabilities: string[]
      }
      assert.equal(parsed.cli, cli.version)
      assert.equal(parsed.core, core.version)
      // A consumer refuses select mode when a guard it relies on is missing; the
      // list is the contract, not a parse of the version.
      assert.equal(parsed.adapterContract, 1)
      assert.ok(parsed.capabilities.includes('configChanged'))
      assert.ok(parsed.capabilities.includes('unknownPolicyFor'))

      // `help` wins when both are present, and a positional help is not an error.
      assert.match(invoke(repo.root, '--version', '--help').out[0]!, /^cbd —/)
      assert.match(invoke(repo.root, 'help', '--version').out[0]!, /^cbd —/)
    } finally {
      repo.cleanup()
    }
  })

  test('the shipped bin gives help precedence over --version', () => {
    // The bin answers `--version` before importing the CLI, so its precedence is
    // its own and `run()`'s tests cannot cover it.
    // Compiled, this file lives in `dist/tests`, so the bin is two levels up —
    // the same depth it is from the source `tests` directory.
    const bin = fileURLToPath(new URL('../../bin/cbd.js', import.meta.url))
    for (const argv of [
      ['help', '--version'],
      ['--version', '--help'],
    ]) {
      const result = spawnSync(process.execPath, [bin, ...argv], { encoding: 'utf8' })
      assert.equal(result.status, 0)
      assert.match(result.stdout, /^cbd —/)
    }
  })

  test('--version does not wait for git', () => {
    // A broken git wrapper on PATH must not block a diagnostic command; the
    // shipped bin answers before importing the CLI (and therefore core).
    const shim = mkdtempSync(join(tmpdir(), 'cbd-shim-'))
    try {
      const fake = join(shim, 'git')
      writeFileSync(fake, '#!/bin/sh\nsleep 5\nexit 1\n')
      chmodSync(fake, 0o755)
      const bin = fileURLToPath(new URL('../../bin/cbd.js', import.meta.url))
      const started = Date.now()
      const result = spawnSync(process.execPath, [bin, '--version'], {
        encoding: 'utf8',
        timeout: 4000,
        env: { ...process.env, PATH: `${shim}:${process.env.PATH ?? ''}` },
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /^cbd \d/)
      assert.ok(Date.now() - started < 3000, 'version must not wait for git')
    } finally {
      rmSync(shim, { recursive: true, force: true })
    }
  })
})

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
  test('the root is the nearest config, else the git top level', () => {
    const repo = tempRepo()
    try {
      repo.write('sub/cbd.config.json', '{}\n')
      repo.write('sub/deeper/file.ts', 'export const x = 1\n')
      repo.write('src/a.ts', 'export const a = 1\n')
      repo.commit('base')

      // Roots are canonical: macOS's tmpdir sits behind a symlink.
      assert.equal(
        defaultRoot(join(repo.root, 'sub/deeper')),
        realpathSync(join(repo.root, 'sub')),
      )
      assert.equal(defaultRoot(join(repo.root, 'src')), realpathSync(repo.root))
      // Outside any git repository and without a config, cwd is the answer.
      const loose = mkdtempSync(join(tmpdir(), 'cbd-loose-'))
      try {
        assert.equal(defaultRoot(loose), realpathSync(loose))
      } finally {
        rmSync(loose, { recursive: true, force: true })
      }
    } finally {
      repo.cleanup()
    }
  })

  test('a config above the git root does not capture a nested repository', () => {
    const outer = tempRepo()
    try {
      outer.write('cbd.config.json', '{}\n')
      outer.write('inner/deeper/a.ts', 'export const a = 1\n')
      outer.git(['-C', 'inner', 'init', '-q', '-b', 'main'])
      outer.git(['-C', 'inner', 'config', 'user.email', 'test@example.com'])
      outer.git(['-C', 'inner', 'config', 'user.name', 'CBD Test'])
      outer.git(['-C', 'inner', 'add', '-A'])
      outer.git(['-C', 'inner', 'commit', '-qm', 'inner'])

      // The outer config is above the inner repository's top level; it belongs
      // to another project and must not become the root.
      assert.equal(
        defaultRoot(join(outer.root, 'inner/deeper')),
        realpathSync(join(outer.root, 'inner')),
      )
    } finally {
      outer.cleanup()
    }
  })

  test('select from a subdirectory gives the same answer as from the root', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const fromRoot = invoke(root, 'select')
      const fromSub = invoke(join(root, 'src'), 'select')
      assert.equal(fromSub.code, fromRoot.code)
      assert.deepEqual(fromSub.out, fromRoot.out)
    } finally {
      cleanup()
    }
  })

  test('a changed config forces all and is not ignored', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      writeFileSync(join(root, 'cbd.config.json'), JSON.stringify({ include: ['src/**'] }))

      const result = invoke(root, 'select', '--format', 'json')
      assert.equal(result.code, EXIT.all)
      const parsed = JSON.parse(result.out.join('\n')) as {
        selection: { mode: string; reasons: Array<{ kind: string; why?: string }>; ignored: string[] }
      }
      assert.equal(parsed.selection.mode, 'all')
      assert.ok(
        parsed.selection.reasons.some(
          (reason) => reason.kind === 'all' && reason.why === 'config-changed',
        ),
      )
      assert.ok(
        !parsed.selection.ignored.some((path) => path.endsWith('/cbd.config.json')),
        'the config is claimed by its own rule, not silently ignored',
      )
    } finally {
      cleanup()
    }
  })

  test('a changed function selects its tests, and exits 0', () => {
    const { repo, root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      const result = invoke(root, 'select')
      assert.equal(result.code, EXIT.ok)
      assert.ok(result.out.includes('tests/a.spec.ts > adds'))
      assert.ok(result.out.includes('tests/a.spec.ts > reads'))
      assert.match(
        result.out.at(-1)!,
        /^2 tests for 1 changed file \(map [0-9a-f]{7}, up to date\)(; ~\d+ ms of \d+ ms recorded)?$/,
      )
    } finally {
      cleanup()
    }
  })

  test('--change answers a what-if without touching the tree', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const before = readFileSync(join(root, 'src/a.ts'), 'utf8')

      const result = invoke(root, 'select', '--change', 'src/a.ts:2')
      assert.equal(result.code, EXIT.ok)
      assert.match(result.out.at(-1)!, /^2 tests for 1 changed file/)
      assert.ok(result.out.includes('tests/a.spec.ts > adds'))
      // A what-if is read-only: the file it asks about was never applied.
      assert.equal(readFileSync(join(root, 'src/a.ts'), 'utf8'), before)
    } finally {
      cleanup()
    }
  })

  test('--patch reads a diff with the same reader as --since', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const patch = join(root, 'what-if.diff')
      writeFileSync(
        patch,
        [
          'diff --git a/src/a.ts b/src/a.ts',
          '--- a/src/a.ts',
          '+++ b/src/a.ts',
          '@@ -2 +2 @@',
          '-  return a + b;',
          '+  return b + a;',
          '',
        ].join('\n'),
      )

      const result = invoke(root, 'select', '--patch', patch)
      assert.equal(result.code, EXIT.ok)
      assert.match(result.out.at(-1)!, /^2 tests for 1 changed file/)
      assert.ok(result.out.includes('tests/a.spec.ts > reads'))
    } finally {
      cleanup()
    }
  })

  test('--patch warns when no path it names is inside include', () => {
    const { root, cleanup } = prepared({ config: { include: ['src/**'] } })
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const patch = join(root, 'what-if.diff')
      writeFileSync(
        patch,
        [
          'diff --git a/packages/app/src/a.ts b/packages/app/src/a.ts',
          '--- a/packages/app/src/a.ts',
          '+++ b/packages/app/src/a.ts',
          '@@ -2 +2 @@',
          '-  return a + b;',
          '+  return b + a;',
          '',
        ].join('\n'),
      )

      // This is the shape a diff made at the repository top level has under a
      // nested --root: every resolved path sits one level too deep and is ignored.
      const result = invoke(root, 'select', '--patch', patch)
      assert.equal(result.code, EXIT.ok)
      assert.match(result.err.join('\n'), /none of the paths in .* is inside this project's include/)
      assert.match(result.err.join('\n'), /--patch paths are read relative to /)
      assert.match(result.out.join('\n'), /^0 tests for 0 changed files/m)
      assert.ok(result.out.some((line) => line.startsWith('ignored 1 changed file:')))
    } finally {
      cleanup()
    }
  })

  test('--patch and --since are exclusive; a malformed --change is a usage error', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      for (const argv of [
        ['select', '--since', 'HEAD', '--change', 'src/a.ts:1'],
        ['select', '--change', 'src/a.ts'],
        ['select', '--change', 'src/a.ts:9-3'],
        ['select', '--change', 'src/a.ts:x'],
        ['select', '--order', 'nope'],
      ]) {
        const result = invoke(root, ...argv)
        assert.equal(result.code, EXIT.usage, argv.join(' '))
        if (argv.includes('--order')) {
          assert.match(result.err.join('\n'), /--order accepts only "impact"/)
        }
      }
    } finally {
      cleanup()
    }
  })

  test('--format summary answers in a few lines', () => {
    const { repo, root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      const result = invoke(root, 'select', '--format', 'summary')
      assert.equal(result.code, EXIT.ok)
      assert.deepEqual(result.out.slice(0, 2), ['mode: subset', 'selected: 2 of 2'])
      assert.match(result.out[2]!, /^reasons: function 1/)
      assert.match(result.out.at(-1)!, /^estimate: ~\d+ ms of \d+ ms recorded$/)
      // Short enough that a consumer does not need a jq recipe, and it still
      // carries the map's age.
      assert.ok(result.out.some((line) => /^map: [0-9a-f]{7}, up to date/.test(line)))
    } finally {
      cleanup()
    }
  })

  test('--emit-selection writes the adapter file, and removes a stale one', () => {
    const { repo, root, cleanup } = prepared()
    // Outside the repository: an untracked file inside it is itself a change, and
    // would make this selection `all` for the wrong reason.
    const dir = mkdtempSync(join(tmpdir(), 'cbd-emit-'))
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const file = join(dir, 'selection.json')
      writeFileSync(file, JSON.stringify({ version: 2, tests: [{ id: 'stale', file: null, title: 'x' }] }))
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      const written = invoke(root, 'select', '--emit-selection', file)
      assert.equal(written.code, EXIT.ok)
      const selection = JSON.parse(readFileSync(file, 'utf8')) as {
        version: number
        tests: Array<{ id: string; title: string }>
      }
      assert.equal(selection.version, 2)
      assert.deepEqual(selection.tests.map((test) => test.title), ['adds', 'reads'])
      assert.match(selection.tests[0]!.id, /tests\/a\.spec\.ts::adds$/)

      // An unanswerable selection leaves no file behind: a runner handed the
      // previous run's subset would silently run a fraction of the suite.
      writeFileSync(join(root, 'cbd.config.json'), JSON.stringify({ include: ['src/**'] }))
      const all = invoke(root, 'select', '--emit-selection', file)
      assert.equal(all.code, EXIT.all)
      assert.equal(existsSync(file), false)
      assert.match(all.err.join('\n'), /selection is all; removed the stale/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      cleanup()
    }
  })

  test('--emit-selection-dir writes one file per suite and removes stale ones', () => {
    const { repo, root, cleanup } = prepared()
    const dir = mkdtempSync(join(tmpdir(), 'cbd-suites-'))
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')
      writeFileSync(join(dir, 'other.json'), JSON.stringify({ version: 2, tests: [] }))

      const result = invoke(
        root,
        'select',
        '--emit-selection-dir',
        dir,
        '--suite',
        'one=tests/a.spec.ts',
        '--suite',
        'other=tests/b.spec.ts',
      )
      assert.equal(result.code, EXIT.ok)
      const one = JSON.parse(readFileSync(join(dir, 'one.json'), 'utf8')) as {
        version: number
        tests: Array<{ title: string }>
      }
      assert.equal(one.version, 2)
      assert.deepEqual(one.tests.map((test) => test.title), ['adds', 'reads'])
      // A suite with no selected tests gets no file, and the stale one is gone.
      assert.equal(existsSync(join(dir, 'other.json')), false)
      assert.equal(existsSync(join(dir, '_other.json')), false)
      assert.match(result.err.join('\n'), /wrote 1 suite selection file/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      cleanup()
    }
  })

  test('--emit-selection-dir writes _other.json for tests no suite claims', () => {
    const { repo, root, cleanup } = prepared()
    const dir = mkdtempSync(join(tmpdir(), 'cbd-suites-other-'))
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      const result = invoke(
        root,
        'select',
        '--emit-selection-dir',
        dir,
        '--suite',
        'unmatched=tests/nope.spec.ts',
      )
      assert.equal(result.code, EXIT.ok)
      assert.equal(existsSync(join(dir, 'unmatched.json')), false)
      const other = JSON.parse(readFileSync(join(dir, '_other.json'), 'utf8')) as {
        tests: Array<{ title: string }>
      }
      assert.deepEqual(other.tests.map((test) => test.title), ['adds', 'reads'])
      assert.match(result.err.join('\n'), /matched no suite/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      cleanup()
    }
  })

  test('--emit-selection-dir removes every managed file when the answer is all', () => {
    const { root, cleanup } = prepared()
    const dir = mkdtempSync(join(tmpdir(), 'cbd-suites-all-'))
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      for (const name of ['one.json', 'two.json', '_other.json']) {
        writeFileSync(join(dir, name), JSON.stringify({ version: 2, tests: [] }))
      }

      const result = invoke(
        root,
        'select',
        '--change',
        'src/unknown.ts:1',
        '--emit-selection-dir',
        dir,
        '--suite',
        'one=tests/a.spec.ts',
        '--suite',
        'two=tests/b.spec.ts',
      )
      assert.equal(result.code, EXIT.all)
      assert.equal(existsSync(join(dir, 'one.json')), false)
      assert.equal(existsSync(join(dir, 'two.json')), false)
      assert.equal(existsSync(join(dir, '_other.json')), false)
      assert.match(result.err.join('\n'), /selection is all; removed/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      cleanup()
    }
  })

  test('--suite needs --emit-selection-dir and a valid name', () => {
    const { root, cleanup } = prepared()
    try {
      const missingDir = invoke(root, 'select', '--suite', 'one=tests/**')
      assert.equal(missingDir.code, EXIT.usage)
      assert.match(missingDir.err.join('\n'), /--suite needs --emit-selection-dir/)

      const noSuites = invoke(root, 'select', '--emit-selection-dir', root)
      assert.equal(noSuites.code, EXIT.usage)
      assert.match(noSuites.err.join('\n'), /needs at least one --suite/)

      const badName = invoke(root, 'select', '--emit-selection-dir', root, '--suite', '_other=tests/**')
      assert.equal(badName.code, EXIT.usage)
      assert.match(badName.err.join('\n'), /and not "_other"/)
    } finally {
      cleanup()
    }
  })

  test('--format summary is only for select', () => {
    const { root, cleanup } = prepared()
    try {
      const result = invoke(root, 'build', '--format', 'summary')
      assert.equal(result.code, EXIT.usage)
      assert.match(result.err.join('\n'), /summary is only for select/)
    } finally {
      cleanup()
    }
  })

  test('build --incremental carries untouched tests and marks the rest partial', () => {
    const { repo, root, a, spec, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const base = repo.head()
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')
      const next = repo.commit('second')
      // A select-mode recording: only the test that reached the change ran.
      writeFileSync(
        join(root, '.cbd', 'shards', 'run.ndjson'),
        shardText(next, [{ title: 'adds', file: spec, touches: [[a, 'add@0', 1, 3]] }]),
      )

      const built = invoke(root, 'build', '--incremental', '--format', 'json')
      assert.equal(built.code, EXIT.ok)
      const parsed = JSON.parse(built.out.join('\n')) as {
        tests: number
        incremental?: { base: string; carried: number; partial: number }
      }
      assert.equal(parsed.incremental?.base, base)
      // `reads` used the changed file and was not re-run: it is not guessed at,
      // and the file it used is marked partial.
      assert.equal(parsed.incremental?.carried, 0)
      assert.ok((parsed.incremental?.partial ?? 0) > 0)

      const selected = invoke(root, 'select', '--change', 'src/a.ts:2')
      assert.equal(selected.code, EXIT.all)
      assert.match(selected.out.join('\n'), /partial/)
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
        cbdVersion: string
        selection: { mode: string; tests: number[] }
        selected: Array<{ title: string }>
      }
      assert.equal(parsed.selection.mode, 'subset')
      assert.deepEqual(parsed.selection.tests, [0, 1])
      assert.deepEqual(parsed.selected.map((entry) => entry.title), ['adds', 'reads'])
      assert.match(parsed.cbdVersion, /^\d+\.\d+\.\d+/)
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
      // `--config` from outside the repository: an in-repo config would itself be
      // a change, and a changed config now forces all (`cbd-73r.3`).
      const configDir = mkdtempSync(join(tmpdir(), 'cbd-config-'))
      try {
        const configPath = join(configDir, 'cbd.config.json')
        writeFileSync(configPath, JSON.stringify({ unknownPolicy: 'ignore' }))

        const result = invoke(root, 'select', '--config', configPath)
        assert.equal(result.code, EXIT.ok)
        assert.match(result.out.at(-1)!, /^0 tests for 1 changed file/)
      } finally {
        rmSync(configDir, { recursive: true, force: true })
      }
    } finally {
      cleanup()
    }
  })

  test('unknownPolicyFor ignores an unknown path and warns about a stale glob', () => {
    const { repo, root, cleanup } = prepared()
    const configDir = mkdtempSync(join(tmpdir(), 'cbd-config-'))
    try {
      const config = join(configDir, 'cbd.config.json')
      writeFileSync(
        config,
        JSON.stringify({
          unknownPolicyFor: [
            { paths: ['tools/**'], policy: 'ignore' },
            { paths: ['gone/**'], policy: 'ignore' },
          ],
        }),
      )
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('tools/new.ts', 'export const x = 1\n')

      const result = invoke(root, 'select', '--config', config, '--format', 'json')
      assert.equal(result.code, EXIT.ok, result.err.join('\n'))
      const parsed = JSON.parse(result.out.join('\n')) as {
        selection: { mode: string; ignored: string[]; warnings: string[] }
      }
      assert.equal(parsed.selection.mode, 'subset')
      assert.ok(parsed.selection.ignored.some((path) => path.endsWith('/tools/new.ts')))
      assert.ok(
        parsed.selection.warnings.some((warning) =>
          /unknownPolicyFor\[0\].*tools\/\*\*/.test(warning),
        ),
      )
      assert.ok(
        parsed.selection.warnings.some((warning) => /unknownPolicyFor\[1\].*stale/.test(warning)),
      )
    } finally {
      rmSync(configDir, { recursive: true, force: true })
      cleanup()
    }
  })

  test('a config outside --root still forces all', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      // A map under the sub-root, so `--root pkg` can select at all.
      mkdirSync(join(root, 'pkg'), { recursive: true })
      cpSync(join(root, '.cbd'), join(root, 'pkg/.cbd'), { recursive: true })
      // The config sits above --root, outside the relative diff.
      const config = join(root, 'cbd.config.json')
      writeFileSync(config, '{}\n')

      const result = invoke(
        root,
        '--root',
        'pkg',
        '--config',
        config,
        'select',
        '--format',
        'json',
      )
      assert.equal(result.code, EXIT.all)
      const parsed = JSON.parse(result.out.join('\n')) as {
        selection: { mode: string; reasons: Array<{ kind: string; why?: string }>; ignored: string[] }
      }
      assert.equal(parsed.selection.mode, 'all')
      assert.ok(
        parsed.selection.reasons.some(
          (reason) => reason.kind === 'all' && reason.why === 'config-changed',
        ),
      )
      assert.ok(!parsed.selection.ignored.includes(config))
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
    const configDir = mkdtempSync(join(tmpdir(), 'cbd-config-'))
    try {
      // An external config: an in-repo one is itself a change, and now forces all.
      const configPath = join(configDir, 'cbd.config.json')
      writeFileSync(configPath, JSON.stringify({ include: ['src/**'] }))
      repo.write('docs/readme.md', '# docs\n')
      assert.equal(invoke(root, 'build').code, EXIT.ok)

      const result = invoke(root, 'select', '--config', configPath, '--format', 'json')
      assert.equal(result.code, EXIT.ok)
      const parsed = JSON.parse(result.out.join('\n')) as {
        selection: { ignored: string[] }
      }
      assert.ok(
        parsed.selection.ignored.some((path) => path.endsWith('/docs/readme.md')),
        `expected docs/readme.md in ignored, got ${JSON.stringify(parsed.selection.ignored)}`,
      )

      const text = invoke(root, 'select', '--config', configPath)
      assert.equal(text.code, EXIT.ok)
      assert.match(text.out.join('\n'), /ignored 1 changed file: docs\/readme\.md/)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
      cleanup()
    }
  })

  test('a declared non-JS input selects the test file it feeds', () => {
    const { repo, root, cleanup } = prepared()
    const configDir = mkdtempSync(join(tmpdir(), 'cbd-config-'))
    try {
      const configPath = join(configDir, 'cbd.config.json')
      writeFileSync(
        configPath,
        JSON.stringify({
          include: ['src/**'],
          // A migration is outside include and unknown to the map; the declaration
          // is what makes it select the suite that exercises it.
          alwaysSelect: [
            { tests: ['tests/a.spec.ts'], when: ['db/migrations/**'] },
          ],
        }),
      )
      assert.equal(invoke(root, 'build', '--config', configPath).code, EXIT.ok)
      repo.write('db/migrations/001.sql', 'create table keys (id text primary key);\n')

      const result = invoke(root, 'select', '--config', configPath, '--format', 'json')
      assert.equal(result.code, EXIT.ok)
      const parsed = JSON.parse(result.out.join('\n')) as {
        selection: { mode: string; tests: number[]; reasons: Array<{ kind: string }>; ignored: string[] }
      }
      assert.equal(parsed.selection.mode, 'subset')
      assert.deepEqual(parsed.selection.tests, [0, 1])
      assert.ok(parsed.selection.reasons.some((reason) => reason.kind === 'always'))
      assert.equal(parsed.selection.ignored.includes(join(root, 'db/migrations/001.sql')), false)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
      cleanup()
    }
  })

  test('an alwaysSelect entry is added to a triggered subset', () => {
    const { repo, root, cleanup } = prepared()
    const configDir = mkdtempSync(join(tmpdir(), 'cbd-config-'))
    try {
      const configPath = join(configDir, 'cbd.config.json')
      writeFileSync(
        configPath,
        JSON.stringify({
          include: ['src/**'],
          alwaysSelect: [{ tests: ['tests/a.spec.ts > adds'] }],
        }),
      )
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      const result = invoke(root, 'select', '--config', configPath, '--format', 'json')
      assert.equal(result.code, EXIT.ok)
      const parsed = JSON.parse(result.out.join('\n')) as {
        selection: { mode: string; tests: number[]; reasons: Array<{ kind: string }> }
      }
      assert.equal(parsed.selection.mode, 'subset')
      assert.ok(parsed.selection.reasons.some((reason) => reason.kind === 'always'))
      assert.deepEqual(parsed.selection.tests, [0, 1])
    } finally {
      rmSync(configDir, { recursive: true, force: true })
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

  test('reaches --batch answers mutant rows and checks the named killers', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const rows = join(root, 'rows.json')
      writeFileSync(
        rows,
        JSON.stringify([
          { file: 'src/a.ts', lines: [2, 2], killers: ['adds', 'not-a-test'] },
          { file: 'src/a.ts', find: 'return a + b' },
          { file: 'src/nope.ts', lines: [1, 1] },
        ]),
      )

      const result = invoke(root, 'reaches', '--batch', rows, '--format', 'json')
      assert.equal(result.code, EXIT.ok)
      const parsed = JSON.parse(result.out.join('\n')) as {
        results: Array<{
          file: string
          start: number
          end: number
          seen: boolean
          tests: Array<{ title: string }>
          killers: Array<{ title: string; reaches: boolean }>
        }>
      }
      assert.equal(parsed.results.length, 3)
      assert.deepEqual(
        parsed.results[0]!.tests.map((test) => test.title),
        ['adds', 'reads'],
      )
      assert.deepEqual(parsed.results[0]!.killers, [
        { title: 'adds', reaches: true },
        { title: 'not-a-test', reaches: false },
      ])
      // `find` resolves to the same line as the explicit range.
      assert.equal(parsed.results[1]!.start, 2)
      assert.equal(parsed.results[1]!.killers.length, 0)
      // An unknown file is not "no tests": selection would run everything.
      assert.equal(parsed.results[2]!.seen, false)
      assert.deepEqual(parsed.results[2]!.tests, [])
    } finally {
      cleanup()
    }
  })

  test('reaches --batch validates the rows and takes no positional arguments', () => {
    const { root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      const bad = join(root, 'bad.json')
      writeFileSync(bad, JSON.stringify([{ file: 'src/a.ts', lines: [3, 1] }]))
      assert.equal(invoke(root, 'reaches', '--batch', bad).code, EXIT.usage)
      assert.equal(
        invoke(root, 'reaches', 'adds', 'src/a.ts', '--batch', bad).code,
        EXIT.usage,
      )
      writeFileSync(bad, JSON.stringify([{ file: 'src/a.ts', find: 'not there' }]))
      const missing = invoke(root, 'reaches', '--batch', bad)
      assert.equal(missing.code, EXIT.usage)
      assert.match(missing.err.join('\n'), /find text is not in/)
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
      assert.equal(result.out[5], 'suites: tests (2)')
      assert.equal(result.out[6], 'since the map: no in-scope changes')
      assert.equal(result.out[7], 'most-tested files:')
      assert.equal(result.out[8], '  src/a.ts: 2 tests, 1 function')
      assert.equal(result.out.length, 9, 'no untested section when there is nothing to name')
    } finally {
      cleanup()
    }
  })

  test('stats names in-scope changes since the map, and the unknown ones', () => {
    const { repo, root, cleanup } = prepared()
    try {
      assert.equal(invoke(root, 'build').code, EXIT.ok)
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')
      repo.write('src/new.ts', 'export const x = 1\n')

      const result = invoke(root, 'stats')
      assert.equal(result.code, EXIT.ok)
      const line = result.out.find((entry) => entry.startsWith('since the map:'))
      assert.ok(line !== undefined, `expected a change line, got:\n${result.out.join('\n')}`)
      assert.match(line, /2 in-scope files changed/)
      assert.match(line, /1 file unknown to the map/)
      assert.match(line, /src\/new\.ts/)
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
      assert.deepEqual(result.out.slice(9), [
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

  test('resolves a relative mapsDir against the root, not the invoking directory', () => {
    const repo = tempRepo()
    try {
      repo.write('src/a.ts', 'export const a = 1\n')
      repo.commit('base')
      const root = realpathSync(repo.root)
      const shared = join(root, 'shared-maps')
      for (const name of ['m1', 'm2', 'm3']) {
        const dir = join(shared, name)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'map.json'), '{}')
      }
      writeFileSync(join(root, 'cbd.config.json'), JSON.stringify({ mapsDir: 'shared-maps' }))

      // The config's path is relative; `mapDir` and `gc` must resolve it against
      // the repository even when the command runs from a subdirectory.
      const result = invoke(join(root, 'src'), 'gc', '--root', root, '--keep', '1', '--format', 'json')
      assert.equal(result.code, EXIT.ok)
      assert.equal(
        (JSON.parse(result.out.join('\n')) as { maps: { removed: number } }).maps.removed,
        2,
      )
      assert.deepEqual(readdirSync(shared).sort(), ['m3'])
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

test.group('cbd flaky', () => {
  const mapAt = (
    root: string,
    commit: string,
    builtAt: string,
    status: 'passed' | 'failed',
  ): CoverageMap => ({
    version: MAP_VERSION,
    commit,
    builtAt,
    tests: [{ title: 't', file: join(root, 'tests/a.spec.ts'), status }],
    files: { [join(root, 'src/a.ts')]: { 'f@0': { startLine: 1, endLine: 2, tests: [0] } } },
    load: [],
    between: [],
    teardown: [],
    seen: [join(root, 'src/a.ts'), join(root, 'tests/a.spec.ts')],
    shards: ['shard'],
  })

  test('reports a flip only when nothing the test reached changed', () => {
    const repo = tempRepo()
    const root = realpathSync(repo.root)
    try {
      repo.write('src/a.ts', 'export function f() {\n  return 1;\n}\n')
      repo.write('tests/a.spec.ts', "import { f } from '../src/a.js'\n")
      repo.write('README.md', 'one\n')
      const a = repo.commit('a')
      repo.write('README.md', 'two\n')
      const b = repo.commit('b')
      repo.write('src/a.ts', 'export function f() {\n  return 2;\n}\n')
      repo.write('README.md', 'three\n')
      const c = repo.commit('c')

      saveMap(root, mapAt(root, a, '2026-01-01T00:00:00.000Z', 'passed'))
      saveMap(root, mapAt(root, b, '2026-01-02T00:00:00.000Z', 'failed'))
      saveMap(root, mapAt(root, c, '2026-01-03T00:00:00.000Z', 'passed'))

      const json = invoke(root, 'flaky', '--format', 'json')
      assert.equal(json.code, EXIT.ok)
      const parsed = JSON.parse(json.out.join('\n')) as {
        maps: number
        flaky: Array<{ title: string; flips: Array<{ from: { commit: string }; to: { commit: string } }> }>
      }
      assert.equal(parsed.maps, 3)
      assert.equal(parsed.flaky.length, 1)
      assert.equal(parsed.flaky[0]!.title, 't')
      assert.equal(parsed.flaky[0]!.flips.length, 1, 'the flip with a changed source is not flaky')
      assert.equal(parsed.flaky[0]!.flips[0]!.from.commit, a)
      assert.equal(parsed.flaky[0]!.flips[0]!.to.commit, b)

      const text = invoke(root, 'flaky')
      assert.equal(text.code, EXIT.ok)
      assert.match(text.out[0]!, /^flaky: 1 test changed outcome with no relevant change across 3 maps$/)
      assert.match(text.out[1]!, /tests\/a\.spec\.ts > t: passed at [0-9a-f]{7} -> failed at [0-9a-f]{7}/)
    } finally {
      repo.cleanup()
    }
  })
})

test('an explicit --root is canonicalized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-root-'))
  const link = `${dir}-link`
  try {
    symlinkSync(dir, link)
    const parsed = parseArgs(['--root', link, 'select'], dir)
    assert.equal(parsed.root, realpathSync(dir))
  } finally {
    rmSync(link, { force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})
