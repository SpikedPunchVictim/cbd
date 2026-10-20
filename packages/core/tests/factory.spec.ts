/**
 * `createCbd(config)` — the five verbs over one bound config (ADR-0003).
 *
 * Real git and real shard files: the verbs are the product surface, so a stub map
 * would prove the wiring but not that `build` writes what `select` later reads.
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { createCbd } from '../src/factory.js'
import { loadMap } from '../src/map.js'
import type { Change } from '../src/changes.js'
import type { Selection } from '../src/select.js'
import type { TouchRef } from '../src/shard.js'
import { IncompleteShardError } from '../src/shard.js'
import { tempRepo, type TempRepo } from './support/git.js'

const ref = (file: string, key: string, start: number, end: number): TouchRef => [
  file,
  key,
  start,
  end,
]

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

/**
 * A v2 shard for the verbs, written from map-coordinate `TouchRef`s.
 *
 * The recorder would produce script ids and byte ranges, and the build resolves
 * them; the factory's tests care about the verbs, not the recording, so this helper
 * does the recording's job: it points each touch at the real file the test wrote and
 * turns the requested lines into offsets. A file a test only *sees* (a load bucket
 * for a module that no test reaches) is created with enough lines to hold it — that
 * is what makes it resolvable and therefore `seen`.
 */
function shardText(
  commit: string,
  tests: Array<{ title: string; file: string | null; touches: TouchRef[] }>,
  options: { buckets?: Partial<Record<'load' | 'between' | 'teardown', TouchRef[]>>; end?: boolean } = {},
): string {
  const records: unknown[] = [{ type: 'shard', version: 2, commit, pid: 1, startedAt: 'T0' }]
  const scripts = new Map<string, { id: string; url: string; size: number; mtimeMs: number }>()
  const texts = new Map<string, string>()
  const functions = new Set<string>()

  const textFor = (file: string, endLine: number): string => {
    const cached = texts.get(file)
    if (cached !== undefined) return cached
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      mkdirSync(dirname(file), { recursive: true })
      text = '// synthetic\n'.repeat(Math.max(endLine, 1))
      writeFileSync(file, text)
    }
    texts.set(file, text)
    return text
  }

  const rowsFor = (touches: TouchRef[]): Record<string, [number, number][]> => {
    const out: Record<string, [number, number][]> = {}
    for (const [file, key, startLine, endLine] of touches) {
      const text = textFor(file, endLine)
      let script = scripts.get(file)
      if (script === undefined) {
        const stat = statSync(file)
        script = {
          id: String(scripts.size + 1),
          url: pathToFileURL(file).href,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        }
        scripts.set(file, script)
        records.push({ type: 'script', scriptId: script.id, url: script.url, size: script.size, mtimeMs: script.mtimeMs })
      }
      const starts = lineStarts(text)
      const lineStart = starts[Math.min(startLine, starts.length) - 1] ?? 0
      // Offset 0 is V8's module body, and the build names it `<module>`. A named
      // function never starts there, so nudge a synthetic one inside line 1.
      const start = lineStart === 0 && text.length > 1 ? 1 : lineStart
      const end = Math.max(start, starts[Math.min(endLine, starts.length) - 1] ?? start)
      const id = `${file}\u0000${String(start)}`
      if (!functions.has(id)) {
        functions.add(id)
        records.push({
          type: 'function',
          scriptId: script.id,
          start,
          end,
          // The map key is `name@ordinal`; the fixture uses `@0` throughout.
          name: key.replace(/@\d+$/, ''),
        })
      }
      ;(out[script.id] ??= []).push([start, end])
    }
    return out
  }

  for (const entry of tests) {
    records.push({
      type: 'test',
      title: entry.title,
      file: entry.file,
      status: 'passed',
      durationMs: 1,
      touches: rowsFor(entry.touches),
    })
  }
  for (const kind of ['load', 'between', 'teardown'] as const) {
    const touches = options.buckets?.[kind]
    if (touches !== undefined) records.push({ type: kind, touches: rowsFor(touches) })
  }
  if (options.end !== false) records.push({ type: 'end', tests: tests.length, finishedAt: 'T1' })
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function writeShard(root: string, name: string, text: string): string {
  const dir = join(root, '.cbd', 'shards')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

/** A repository with one commit and a shard for it: the shape every verb starts from. */
function prepared(): {
  repo: TempRepo
  a: string
  spec: string
  commit: string
  cleanup: () => void
} {
  const repo = tempRepo()
  // The factory canonicalizes its root, and Node reports a `/var` fixture as
  // `/private/var`; the map keys have to be the canonical ones to match.
  const root = realpathSync(repo.root)
  const a = join(root, 'src/a.ts')
  const spec = join(root, 'tests/a.spec.ts')
  repo.write('src/a.ts', 'export function add(a, b) {\n  return a + b;\n}\n')
  repo.write('tests/a.spec.ts', "import { add } from '../src/a.js'\n")
  const commit = repo.commit('base')
  writeShard(
    repo.root,
    'run.ndjson',
    shardText(commit, [
      { title: 'adds', file: spec, touches: [ref(a, 'add@0', 1, 3)] },
      { title: 'reads', file: spec, touches: [ref(a, 'add@0', 1, 3)] },
    ]),
  )
  return { repo, a, spec, commit, cleanup: () => repo.cleanup() }
}

test.group('createCbd', () => {
  test('build merges the shards for the commit and writes a loadable map', () => {
    const { repo, a, commit, cleanup } = prepared()
    try {
      const cbd = createCbd({ root: repo.root })
      const result = cbd.build()

      assert.equal(result.commit, commit)
      assert.equal(result.tests, 2)
      assert.equal(result.files, 1)
      assert.equal(result.path, join(realpathSync(repo.root), '.cbd/maps', commit, 'map.json'))
      assert.deepEqual(result.shards, ['.cbd/shards/run.ndjson'])

      const loaded = loadMap(repo.root, commit)
      assert.deepEqual(Object.keys(loaded.map.files), [a])
      assert.deepEqual(loaded.map.tests.map((entry) => entry.title), ['adds', 'reads'])
    } finally {
      cleanup()
    }
  })

  test('build ignores a shard recorded at another commit unless it is named', () => {
    const { repo, a, commit, cleanup } = prepared()
    try {
      writeShard(repo.root, 'stale.ndjson', shardText('deadbeef', [
        { title: 'stale test', file: null, touches: [ref(a, 'add@0', 1, 3)] },
      ]))
      const cbd = createCbd({ root: repo.root })
      assert.equal(cbd.build().tests, 2, 'the default glob is commit-filtered')

      const explicit = cbd.build({
        shards: [join(repo.root, '.cbd/shards/run.ndjson'), join(repo.root, '.cbd/shards/stale.ndjson')],
      })
      assert.equal(explicit.tests, 3, 'an explicit list is the caller’s choice')
      assert.equal(explicit.commit, commit)
    } finally {
      cleanup()
    }
  })

  test('build refuses an interrupted shard, and --partial is the opt-in', () => {
    const { repo, a, commit, cleanup } = prepared()
    try {
      const partial = writeShard(repo.root, 'killed.ndjson', shardText(commit, [
        { title: 'only', file: null, touches: [ref(a, 'add@0', 1, 3)] },
      ], { end: false }))
      const cbd = createCbd({ root: repo.root })
      assert.throws(() => cbd.build(), (error: unknown) => error instanceof IncompleteShardError)
      assert.throws(() => cbd.build({ shards: [partial] }), /no end record/)

      const result = cbd.build({ shards: [partial], partial: true })
      assert.equal(result.tests, 1)
    } finally {
      cleanup()
    }
  })

  test('stateDir moves both the shards and the map', () => {
    const repo = tempRepo()
    try {
      const a = join(realpathSync(repo.root), 'src/a.ts')
      repo.write('src/a.ts', 'export function add() { return 1 }\n')
      const commit = repo.commit('base')
      const dir = join(repo.root, 'build/cbd/shards')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'run.ndjson'),
        shardText(commit, [{ title: 'adds', file: null, touches: [ref(a, 'add@0', 1, 1)] }]),
      )

      const cbd = createCbd({ root: repo.root, stateDir: 'build/cbd' })
      const result = cbd.build()
      assert.equal(result.path, join(realpathSync(repo.root), 'build/cbd/maps', commit, 'map.json'))
    } finally {
      repo.cleanup()
    }
  })

  test('reaches answers whether one test covers a file or a line', () => {
    const { repo, commit, cleanup } = prepared()
    try {
      const cbd = createCbd({ root: repo.root })
      cbd.build()
      const file = cbd.reaches('adds', 'src/a.ts')
      assert.equal(file.reaches, true)
      assert.equal(file.seen, true)
      assert.deepEqual(file.functions.map((fn) => fn.key), ['add@0'])
      assert.deepEqual(file.files, [join(realpathSync(repo.root), 'src/a.ts')])

      // Inside the function, including its boundaries.
      assert.equal(cbd.reaches('adds', 'src/a.ts:1').reaches, true)
      assert.equal(cbd.reaches('adds', 'src/a.ts:3').reaches, true)
      // Outside every function: the file-level rule answers with the test that
      // touched the file, which is §8.3 rule 5 at line scale.
      assert.equal(cbd.reaches('adds', 'src/a.ts:99').reaches, true)
      // A file the map never saw is not reached, and says it is unknown.
      const unknown = cbd.reaches('adds', 'src/nope.ts')
      assert.equal(unknown.seen, false)
      assert.equal(unknown.reaches, false)
      // A test the recording never ran cannot be resolved.
      assert.throws(() => cbd.reaches('no such test', 'src/a.ts'), /no test titled/)
    } finally {
      cleanup()
    }
  })

  test('reaches refuses a bare title that names tests in more than one file', () => {
    const { repo, spec, commit, cleanup } = prepared()
    try {
      const root = realpathSync(repo.root)
      const other = join(root, 'tests/b.spec.ts')
      writeShard(
        repo.root,
        'run.ndjson',
        shardText(commit, [
          { title: 'same name', file: spec, touches: [ref(join(root, 'src/a.ts'), 'add@0', 1, 3)] },
          { title: 'same name', file: other, touches: [ref(join(root, 'src/a.ts'), 'add@0', 1, 3)] },
        ]),
      )
      const cbd = createCbd({ root: repo.root })
      cbd.build()
      assert.throws(() => cbd.reaches('same name', 'src/a.ts'), /names 2 tests/)
      const chosen = cbd.reaches('same name', 'src/a.ts', { file: other })
      assert.equal(chosen.test.file, other)
      assert.equal(chosen.reaches, true)
    } finally {
      cleanup()
    }
  })

  test('stats reports the function index and the widest files', () => {
    const { repo, cleanup } = prepared()
    try {
      const cbd = createCbd({ root: repo.root })
      cbd.build()
      const stats = cbd.stats()
      assert.equal(stats.functions, 1)
      assert.deepEqual(stats.functionsPerFile, { median: 1, p90: 1, max: 1 })
      assert.deepEqual(stats.testsPerFunction, { median: 2, p90: 2, max: 2 })
      assert.deepEqual(
        stats.topFiles.map((file) => [file.file.replace(`${realpathSync(repo.root)}/`, ''), file.tests, file.functions]),
        [['src/a.ts', 2, 1]],
      )
    } finally {
      cleanup()
    }
  })

  test('select diffs the map’s commit against the worktree and names the tests', () => {
    const { repo, commit, cleanup } = prepared()
    try {
      const cbd = createCbd({ root: repo.root })
      cbd.build()
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      const { selection, changes, map, selected } = cbd.select()
      assert.equal(selection.mode, 'subset')
      assert.deepEqual(
        selection.tests.map((index) => index),
        [0, 1],
      )
      // The indices resolved against the map this call loaded, so a consumer that
      // only has the result can render titles without re-reading the map.
      assert.deepEqual(selected.map((entry) => entry.title), ['adds', 'reads'])
      assert.equal(changes.length, 1)
      assert.equal(map.commit, commit)
      assert.equal(map.distance, 0)
      assert.equal(map.dirty, false)
    } finally {
      cleanup()
    }
  })

  test('a root inside the repository resolves only its own changes', () => {
    const repo = tempRepo()
    try {
      const pkg = join(realpathSync(repo.root), 'pkg')
      const a = join(pkg, 'src/a.ts')
      const spec = join(pkg, 'tests/a.spec.ts')
      repo.write('pkg/src/a.ts', 'export function add(a, b) {\n  return a + b;\n}\n')
      repo.write('pkg/tests/a.spec.ts', "import { add } from '../src/a.js'\n")
      const commit = repo.commit('base')
      writeShard(pkg, 'run.ndjson', shardText(commit, [
        { title: 'adds', file: spec, touches: [ref(a, 'add@0', 1, 3)] },
        { title: 'reads', file: spec, touches: [ref(a, 'add@0', 1, 3)] },
      ]))
      // Outside the root, and untracked: neither the dirty check nor the diff may
      // count it, or a monorepo package could never record a clean map.
      repo.write('other/untracked.ts', 'export const x = 1;\n')

      const cbd = createCbd({ root: pkg })
      cbd.build()
      repo.write('pkg/src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

      const { selection, changes, map } = cbd.select()
      assert.equal(map.dirty, false)
      assert.deepEqual(
        changes.map((change) => change.path),
        [a],
        'git’s paths are relative to the root, not the repository',
      )
      assert.equal(selection.mode, 'subset')
      assert.deepEqual(selection.tests, [0, 1])
    } finally {
      repo.cleanup()
    }
  })

  test('select lists only the changes the config includes', () => {
    const { repo, cleanup } = prepared()
    try {
      const cbd = createCbd({ root: repo.root })
      cbd.build()
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')
      repo.write('docs/note.md', 'docs\n')
      repo.write('pnpm-lock.yaml', 'lockfileVersion: 9\n')
      repo.commit('changed all three')
      const root = realpathSync(repo.root)

      const scoped = createCbd({
        root: repo.root,
        select: { include: (path) => path.endsWith('a.ts') },
      })
      const { changes, selection } = scoped.select()
      assert.deepEqual(
        changes.map((change) => change.path),
        [join(root, 'src/a.ts')],
        'an excluded file is not part of this selection’s question',
      )
      assert.equal(selection.mode, 'subset')

      // `alwaysAll` is the exception (§8.3 rule 1): a lockfile outside include
      // still forces everything, because the config said so explicitly.
      const locked = createCbd({
        root: repo.root,
        select: { include: (path) => path.endsWith('a.ts'), alwaysAll: ['**/pnpm-lock.yaml'] },
      })
      const lockedResult = locked.select()
      assert.deepEqual(lockedResult.changes.map((change) => change.path).sort(), [
        join(root, 'pnpm-lock.yaml'),
        join(root, 'src/a.ts'),
      ])
      assert.equal(lockedResult.selection.mode, 'all')
    } finally {
      cleanup()
    }
  })

  test('a map that is behind HEAD reports its distance, and maxAgeCommits can force all', () => {
    const { repo, cleanup } = prepared()
    try {
      const cbd = createCbd({ root: repo.root })
      const built = cbd.build()
      repo.write('src/other.ts', 'export const other = 1;\n')
      repo.commit('after the map')

      const { map } = cbd.select()
      assert.equal(map.distance, 1)

      const strict = createCbd({ root: repo.root, select: { maxAgeCommits: 0, strict: true } })
      assert.equal(strict.select().selection.mode, 'all')
      assert.match(strict.select().selection.warnings.join(' '), /maxAgeCommits/)

      // The build is still keyed by the commit it named.
      assert.equal(built.commit, map.commit)
    } finally {
      cleanup()
    }
  })

  test('select refuses when there is no map for the commit, and says where it looked', () => {
    const repo = tempRepo()
    try {
      repo.write('src/a.ts', 'export const a = 1;\n')
      repo.commit('base')
      const cbd = createCbd({ root: repo.root })
      assert.throws(() => cbd.select(), /no map in the last 200 commits/)
    } finally {
      repo.cleanup()
    }
  })

  test('explain answers a file, a line, and a bucket', () => {
    const { repo, a, commit, cleanup } = prepared()
    try {
      const loadedOnly = join(realpathSync(repo.root), 'src/startup.ts')
      writeShard(
        repo.root,
        'run.ndjson',
        shardText(
          commit,
          [
            { title: 'adds', file: null, touches: [ref(a, 'add@0', 1, 3)] },
            { title: 'reads', file: null, touches: [ref(a, 'add@0', 1, 3)] },
          ],
          { buckets: { load: [ref(loadedOnly, 'setup@0', 1, 2)] } },
        ),
      )
      const cbd = createCbd({ root: repo.root })
      cbd.build()

      const file = cbd.explain('src/a.ts')
      assert.equal(file.seen, true)
      assert.deepEqual(file.functions.map((fn) => fn.key), ['add@0'])
      assert.deepEqual(file.tests, ['adds', 'reads'])

      const line = cbd.explain('src/a.ts:2')
      assert.equal(line.line, 2)
      assert.deepEqual(line.tests, ['adds', 'reads'])

      const startup = cbd.explain('src/startup.ts')
      assert.deepEqual(startup.buckets, ['load'])
      assert.deepEqual(startup.tests, [])

      const unknown = cbd.explain('src/nope.ts')
      assert.equal(unknown.seen, false)
      assert.deepEqual(unknown.functions, [])
    } finally {
      cleanup()
    }
  })

  test('stats counts what the map knows, including what no test reaches', () => {
    const { repo, a, spec, commit, cleanup } = prepared()
    try {
      const loadedOnly = join(realpathSync(repo.root), 'src/seen-only.ts')
      writeShard(
        repo.root,
        'run.ndjson',
        shardText(
          commit,
          [
            { title: 'adds', file: spec, touches: [ref(a, 'add@0', 1, 3)] },
            { title: 'reads', file: spec, touches: [ref(a, 'add@0', 1, 3)] },
          ],
          {
            buckets: {
              load: [ref(loadedOnly, 'setup@0', 1, 2)],
              teardown: [ref(loadedOnly, 'setup@0', 1, 2)],
            },
          },
        ),
      )
      const cbd = createCbd({ root: repo.root })
      cbd.build()
      const stats = cbd.stats()
      assert.equal(stats.tests, 2)
      assert.equal(stats.files, 1)
      assert.equal(stats.seen, 2)
      assert.equal(stats.untested, 1)
      assert.deepEqual(stats.untestedFiles, [loadedOnly], 'the count and the names agree')
      assert.deepEqual(stats.buckets, { load: 1, between: 0, teardown: 1 })
      assert.equal(stats.testFiles.files, 1)
      assert.equal(stats.testFiles.max, 2)
    } finally {
      cleanup()
    }
  })

  test('verify takes outcomes as data and reports a planted miss', () => {
    const { repo, a, commit, cleanup } = prepared()
    try {
      const cbd = createCbd({ root: repo.root })
      cbd.build()
      repo.write('src/a.ts', 'export function add(a, b) {\n  return a + b + 0;\n}\n')
      const changes: Change[] = [
        { path: a, status: 'M', hunks: [{ start: 2, end: 2 }] },
      ]
      const selection: Selection = {
        mode: 'subset',
        reasons: [],
        tests: [0],
        unmapped: [],
        untested: [],
        ignored: [],
        warnings: [],
        map: { commit, distance: 0, dirty: false, builtAt: 'T0' },
      }
      const groundTruth = new Map<string, TouchRef[]>([
        ['adds', [ref(a, 'add@0', 1, 3)]],
        ['reads', [ref(a, 'add@0', 1, 3)]],
      ])
      const verification = cbd.verify(selection, changes, groundTruth)
      assert.equal(verification.ranEverything, false)
      assert.deepEqual(verification.misses, [{ test: 'reads', file: a, key: 'add@0' }])
    } finally {
      cleanup()
    }
  })
})
