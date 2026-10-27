/**
 * `createCbd(config)` — the five verbs over one bound config (ADR-0003).
 *
 * Real git and real shard files: the verbs are the product surface, so a stub map
 * would prove the wiring but not that `build` writes what `select` later reads.
 */
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { realpath } from '../src/paths.js'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { createCbd } from '../src/factory.js'
import { loadMap, saveMap, type CoverageMap } from '../src/map.js'
import type { Change } from '../src/changes.js'
import type { Selection } from '../src/select.js'
import type { TouchRef } from '../src/shard.js'
import { IncompleteShardError, SHARD_VERSION } from '../src/shard.js'
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
  tests: Array<{
    title: string
    file: string | null
    touches: TouchRef[]
    reads?: string[]
    dirReads?: string[]
  }>,
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
      ...(entry.reads === undefined ? {} : { reads: entry.reads }),
      ...(entry.dirReads === undefined ? {} : { dirReads: entry.dirReads }),
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
  const root = realpath(repo.root)
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
      assert.equal(result.path, join(realpath(repo.root), '.cbd/maps', commit, 'map.json'))
      assert.deepEqual(result.shards, [join('.cbd', 'shards', 'run.ndjson')])

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

  // A killed run leaves a shard with no footer; it is not this commit's evidence,
  // and refusing the whole build for it made one interrupted run poison every
  // later build until the file was removed by hand.
  test('an incomplete shard from another commit does not fail the default build', () => {
    const { repo, cleanup } = prepared()
    try {
      writeShard(repo.root, 'killed.ndjson', `${JSON.stringify({
        type: 'shard', version: SHARD_VERSION, commit: 'deadbeef', pid: 1, startedAt: 'T0',
      })}\n`)
      const cbd = createCbd({ root: repo.root })

      const result = cbd.build()
      assert.equal(result.tests, 2)
      assert.deepEqual(result.shards, [join('.cbd', 'shards', 'run.ndjson')])

      // The same file at this commit is still refused: it is evidence this map
      // would otherwise be built from.
      writeShard(repo.root, 'killed.ndjson', `${JSON.stringify({
        type: 'shard', version: SHARD_VERSION, commit: result.commit, pid: 1, startedAt: 'T0',
      })}\n`)
      assert.throws(() => cbd.build(), /no end record/)
    } finally {
      cleanup()
    }
  })

  test('an incremental build treats a rename as a change to both paths', () => {
    const { repo, commit, cleanup } = prepared()
    try {
      const cbd = createCbd({ root: repo.root })
      cbd.build()
      repo.git(['mv', 'src/a.ts', 'src/b.ts'])
      const renamed = repo.commit('rename a to b')
      assert.notEqual(renamed, commit)
      // The recording at the new commit ran nothing: every base test must be
      // dropped, not carried with evidence for a file that no longer exists.
      writeShard(repo.root, 'after.ndjson', shardText(renamed, []))

      const result = cbd.build({ commit: renamed, incremental: true })
      assert.equal(result.incremental?.base, commit)
      assert.equal(result.incremental?.carried, 0)

      const map = loadMap(repo.root, renamed).map
      assert.equal(map.tests.length, 0)
      assert.ok(map.partial?.some((path) => path.replaceAll('\\', '/').endsWith('/src/a.ts')))
    } finally {
      cleanup()
    }
  })

  test('an incremental build relocates an unchanged function across an insertion above it', () => {
    const repo = tempRepo()
    const root = realpath(repo.root)
    const a = join(root, 'src/a.ts')
    const spec = join(root, 'tests/a.spec.ts')
    try {
      repo.write(
        'src/a.ts',
        [
          'function g() {', // 1
          '  return 1', // 2
          '}', // 3
          '', // 4
          'function f() {', // 5
          '  return 2', // 6
          '}', // 7
        ].join('\n') + '\n',
      )
      repo.write('tests/a.spec.ts', "import { f } from '../src/a.js'\n")
      const base = repo.commit('base')
      writeShard(
        root,
        'run.ndjson',
        shardText(base, [
          { title: 'adds', file: spec, touches: [ref(a, 'f@0', 5, 7)] },
          { title: 'other', file: spec, touches: [ref(a, 'g@0', 1, 3)] },
        ]),
      )
      const cbd = createCbd({ root })
      cbd.build()

      repo.write(
        'src/a.ts',
        [
          'function g() {', // 1
          '  const a = 1', // 2
          '  const b = 2', // 3
          '  return 1', // 4
          '}', // 5
          '', // 6
          'function f() {', // 7
          '  return 2', // 8
          '}', // 9
        ].join('\n') + '\n',
      )
      const mapCommit = repo.commit('map')
      // The select-mode recording ran only `other`; `adds` must be carried with
      // f's range relocated from 5..7 to 7..9.
      writeShard(
        root,
        'after.ndjson',
        shardText(mapCommit, [
          { title: 'other', file: spec, touches: [ref(a, 'g@0', 1, 5)] },
        ]),
      )

      const result = cbd.build({ commit: mapCommit, incremental: true })
      assert.equal(result.incremental?.base, base)
      assert.equal(result.incremental?.carried, 1)

      const map = loadMap(root, mapCommit).map
      assert.deepEqual(map.tests.map((test) => test.title).sort(), ['adds', 'other'])
      const adds = map.tests.findIndex((test) => test.title === 'adds')
      assert.deepEqual(map.files[a]?.['f@0'], { startLine: 7, endLine: 9, tests: [adds] })
      assert.equal(map.partial, undefined)
    } finally {
      repo.cleanup()
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
      const a = join(realpath(repo.root), 'src/a.ts')
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
      assert.equal(result.path, join(realpath(repo.root), 'build/cbd/maps', commit, 'map.json'))
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
      assert.deepEqual(file.files, [join(realpath(repo.root), 'src/a.ts')])

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
      const root = realpath(repo.root)
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
        stats
          .topFiles
          .map((file) => [relative(realpath(repo.root), file.file).replaceAll('\\', '/'), file.tests, file.functions]),
        [['src/a.ts', 2, 1]],
      )
      assert.deepEqual(stats.suites, [{ dir: 'tests', tests: 2 }])
      assert.deepEqual(stats.changed, { files: 0, unknown: [] })
    } finally {
      cleanup()
    }
  })

  test('stats names changes since the map and the files it has never seen', () => {
    const { repo, cleanup } = prepared()
    try {
      const cbd = createCbd({ root: repo.root })
      cbd.build()
      repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')
      repo.write('src/new.ts', 'export const x = 1\n')

      const stats = cbd.stats()
      assert.equal(stats.changed.files, 2)
      assert.deepEqual(stats.changed.unknown, [join('src', 'new.ts')])
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

  test('emitCheck narrows an erased module-scope edit and leaves a real one alone', () => {
    const { repo, a, cleanup } = prepared()
    const toolchain = realpath(mkdtempSync(join(tmpdir(), 'cbd-emit-factory-')))
    try {
      // The project's TypeScript lives next to its tsconfig, outside the repository.
      mkdirSync(join(toolchain, 'node_modules'))
      symlinkSync(
        realpath(fileURLToPath(new URL('../../node_modules/typescript5', import.meta.url))),
        join(toolchain, 'node_modules', 'typescript'),
        'dir',
      )
      const tsconfig = join(toolchain, 'tsconfig.json')
      writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext' } }))
      const pin = (JSON.parse(readFileSync(join(toolchain, 'node_modules/typescript/package.json'), 'utf8')) as { version: string }).version
      const emitCheck = [{ glob: join(dirname(a), '**'), tsconfig, typescript: pin }]
      const original = readFileSync(a, 'utf8')

      const plain = createCbd({ root: repo.root })
      plain.build()
      repo.write('src/a.ts', `${original}export type Id = string\n`)
      assert.deepEqual(plain.select().selection.tests, [0, 1], 'without the opt-in, module scope widens')

      const narrowed = createCbd({ root: repo.root, select: { emitCheck } }).select().selection
      assert.deepEqual(narrowed.tests, [])
      assert.deepEqual(
        narrowed.reasons.map((reason) => reason.kind),
        ['module-scope-unchanged'],
      )

      assert.deepEqual(
        narrowed.reasons,
        [{ kind: 'module-scope-unchanged', file: a, typescript: pin }],
      )

      // A compiler other than the one the tests run with proves nothing: ignore it and say why.
      const wrong = createCbd({
        root: repo.root,
        select: { emitCheck: [{ ...emitCheck[0]!, typescript: '0.0.1' }] },
      }).select().selection
      assert.deepEqual(wrong.tests, [0, 1])
      assert.ok(
        wrong.warnings.some((warning) => /emitCheck skipped for .*: resolved typescript .*, pinned 0\.0\.1/.test(warning)),
        wrong.warnings.join('\n'),
      )

      repo.write('src/a.ts', `${original}export const id = 1\n`)
      const real = createCbd({ root: repo.root, select: { emitCheck } }).select().selection
      assert.deepEqual(real.tests, [0, 1])
      assert.deepEqual(
        real.reasons.map((reason) => reason.kind),
        ['file'],
      )
    } finally {
      rmSync(toolchain, { recursive: true, force: true })
      cleanup()
    }
  })

  test('emitCheck gives no verdict on a what-if change, which has no new text to compare', () => {
    const repo = tempRepo()
    const toolchain = realpath(mkdtempSync(join(tmpdir(), 'cbd-emit-whatif-')))
    try {
      mkdirSync(join(toolchain, 'node_modules'))
      symlinkSync(
        realpath(fileURLToPath(new URL('../../node_modules/typescript5', import.meta.url))),
        join(toolchain, 'node_modules', 'typescript'),
        'dir',
      )
      const tsconfig = join(toolchain, 'tsconfig.json')
      writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext' } }))
      const pin = (JSON.parse(readFileSync(join(toolchain, 'node_modules/typescript/package.json'), 'utf8')) as { version: string }).version
      const root = realpath(repo.root)
      const a = join(root, 'src/a.ts')
      const spec = join(root, 'tests/a.spec.ts')
      repo.write('src/a.ts', 'const limit = 3\nexport function add(a, b) {\n  return a + b + limit\n}\n')
      repo.write('tests/a.spec.ts', "import { add } from '../src/a.js'\n")
      const commit = repo.commit('base')
      writeShard(
        repo.root,
        'run.ndjson',
        shardText(commit, [
          { title: 'adds', file: spec, touches: [ref(a, 'add@0', 2, 4)] },
          { title: 'loads', file: spec, touches: [] },
        ]),
      )
      const emitCheck = [{ glob: join(dirname(a), '**'), tsconfig, typescript: pin }]
      createCbd({ root: repo.root }).build()

      // Line 1 is module scope. Nothing is edited, so the file's text is identical
      // at base and head, and "identical" proves nothing about a change not yet made.
      const line = { start: 1, end: 1 }
      const changes = [{ path: a, status: 'M' as const, hunks: [line], newHunks: [line], insertions: [] }]
      const without = createCbd({ root: repo.root }).select({ commit, changes }).selection
      const withCheck = createCbd({ root: repo.root, select: { emitCheck } }).select({ commit, changes }).selection

      assert.ok(!withCheck.reasons.some((reason) => reason.kind === 'module-scope-unchanged'))
      assert.ok(!withCheck.reasons.some((reason) => reason.kind === 'binding-read'))
      assert.deepEqual(withCheck.reasons, without.reasons)
      assert.deepEqual(withCheck.tests, without.tests)
      assert.deepEqual(withCheck.warnings, without.warnings)
    } finally {
      rmSync(toolchain, { recursive: true, force: true })
      repo.cleanup()
    }
  })

  test('emitCheck escalates an enum edit end to end', () => {
    const repo = tempRepo()
    const toolchain = realpath(mkdtempSync(join(tmpdir(), 'cbd-emit-enum-')))
    try {
      const root = realpath(repo.root)
      const a = join(root, 'src/a.ts')
      const spec = join(root, 'tests/a.spec.ts')
      repo.write('src/a.ts', "export enum Mode {\n  On = 'on',\n}\nexport function add(a, b) {\n  return a + b;\n}\n")
      repo.write('tests/a.spec.ts', "import { add } from '../src/a.js'\n")
      const commit = repo.commit('base')
      writeShard(
        repo.root,
        'run.ndjson',
        shardText(commit, [
          { title: 'adds', file: spec, touches: [ref(a, 'add@0', 4, 6)] },
          { title: 'reads', file: spec, touches: [ref(a, 'add@0', 4, 6)] },
        ]),
      )
      mkdirSync(join(toolchain, 'node_modules'))
      symlinkSync(
        realpath(fileURLToPath(new URL('../../node_modules/typescript5', import.meta.url))),
        join(toolchain, 'node_modules', 'typescript'),
        'dir',
      )
      const tsconfig = join(toolchain, 'tsconfig.json')
      writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext' } }))
      const pin = (JSON.parse(readFileSync(join(toolchain, 'node_modules/typescript/package.json'), 'utf8')) as { version: string }).version
      const emitCheck = [{ glob: join(dirname(a), '**'), tsconfig, typescript: pin }]

      const cbd = createCbd({ root: repo.root, select: { emitCheck } })
      cbd.build()
      repo.write('src/a.ts', "export enum Mode {\n  On = 'on',\n  Off = 'off',\n}\nexport function add(a, b) {\n  return a + b;\n}\n")
      const selection = createCbd({ root: repo.root, select: { emitCheck } }).select().selection
      assert.deepEqual(selection.tests, [0, 1])
      assert.ok(!selection.reasons.some((reason) => reason.kind === 'module-scope-unchanged'))
    } finally {
      rmSync(toolchain, { recursive: true, force: true })
      repo.cleanup()
    }
  })

  test('emitCheck vouches for a load-only file except inside a function that ran at load', () => {
    const repo = tempRepo()
    const toolchain = realpath(mkdtempSync(join(tmpdir(), 'cbd-emit-load-')))
    try {
      const root = realpath(repo.root)
      const a = join(root, 'src/a.ts')
      const b = join(root, 'src/b.ts')
      const spec = join(root, 'tests/a.spec.ts')
      const source = (boot: number, unused: number): string =>
        `export function boot() {\n  return ${String(boot)};\n}\nexport function unused() {\n  return ${String(unused)};\n}\nboot();\n`
      repo.write('src/a.ts', 'export function add(a, b) {\n  return a + b;\n}\n')
      repo.write('src/b.ts', source(1, 1))
      repo.write('tests/a.spec.ts', "import { add } from '../src/a.js'\n")
      const commit = repo.commit('base')
      writeShard(
        repo.root,
        'run.ndjson',
        shardText(
          commit,
          [
            { title: 'adds', file: spec, touches: [ref(a, 'add@0', 1, 3)] },
            { title: 'other', file: spec, touches: [ref(a, 'add@0', 1, 3)] },
          ],
          { buckets: { load: [ref(b, 'boot@0', 1, 3)] } },
        ),
      )
      mkdirSync(join(toolchain, 'node_modules'))
      symlinkSync(
        realpath(fileURLToPath(new URL('../../node_modules/typescript5', import.meta.url))),
        join(toolchain, 'node_modules', 'typescript'),
        'dir',
      )
      const tsconfig = join(toolchain, 'tsconfig.json')
      writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext' } }))
      const pin = (JSON.parse(readFileSync(join(toolchain, 'node_modules/typescript/package.json'), 'utf8')) as { version: string }).version
      const emitCheck = [{ glob: join(dirname(a), '**'), tsconfig, typescript: pin }]

      createCbd({ root: repo.root, select: { emitCheck } }).build()

      repo.write('src/b.ts', source(1, 2))
      const never = createCbd({ root: repo.root, select: { emitCheck } }).select().selection
      assert.deepEqual(never.tests, [])
      assert.deepEqual(never.reasons, [{ kind: 'module-scope-unchanged', file: b, typescript: pin }])

      repo.write('src/b.ts', source(2, 1))
      const ran = createCbd({ root: repo.root, select: { emitCheck } }).select().selection
      assert.ok(!ran.reasons.some((reason) => reason.kind === 'module-scope-unchanged'))
      assert.ok(ran.mode === 'all' || ran.tests.length > 0)
    } finally {
      rmSync(toolchain, { recursive: true, force: true })
      repo.cleanup()
    }
  })

  test('emitCheck narrows a pure initializer only functions read to the tests of those functions', () => {
    const repo = tempRepo()
    const toolchain = realpath(mkdtempSync(join(tmpdir(), 'cbd-emit-binding-')))
    try {
      const root = realpath(repo.root)
      const a = join(root, 'src/a.ts')
      const spec = join(root, 'tests/a.spec.ts')
      const source = (decl: string): string =>
        `${decl}\nexport function reads(s: string) {\n  return U.test(s)\n}\nexport function other() {\n  return 1\n}\n`
      repo.write('src/a.ts', source('const U = /a/'))
      repo.write('tests/a.spec.ts', "import { reads } from '../src/a.js'\n")
      const commit = repo.commit('base')
      writeShard(
        repo.root,
        'run.ndjson',
        shardText(commit, [
          { title: 'reads', file: spec, touches: [ref(a, 'reads@0', 2, 4)] },
          { title: 'other', file: spec, touches: [ref(a, 'other@0', 5, 7)] },
        ]),
      )
      mkdirSync(join(toolchain, 'node_modules'))
      symlinkSync(
        realpath(fileURLToPath(new URL('../../node_modules/typescript5', import.meta.url))),
        join(toolchain, 'node_modules', 'typescript'),
        'dir',
      )
      const tsconfig = join(toolchain, 'tsconfig.json')
      writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext' } }))
      const pin = (JSON.parse(readFileSync(join(toolchain, 'node_modules/typescript/package.json'), 'utf8')) as { version: string }).version
      const emitCheck = [{ glob: join(dirname(a), '**'), tsconfig, typescript: pin }]
      createCbd({ root: repo.root, select: { emitCheck } }).build()

      repo.write('src/a.ts', source('const U = /b/'))
      const plain = createCbd({ root: repo.root }).select().selection
      assert.deepEqual(plain.tests, [0, 1], 'without the opt-in the module-scope rule takes the whole file')

      const narrowed = createCbd({ root: repo.root, select: { emitCheck } }).select().selection
      assert.deepEqual(narrowed.tests, [0])
      assert.deepEqual(narrowed.reasons, [
        { kind: 'binding-read', file: a, binding: 'U', typescript: pin, tests: [0] },
      ])

      repo.write('src/a.ts', source('const U = new RegExp("b")'))
      const impure = createCbd({ root: repo.root, select: { emitCheck } }).select().selection
      assert.deepEqual(impure.tests, [0, 1])
      assert.ok(!impure.reasons.some((reason) => reason.kind === 'binding-read'))

      repo.write('src/a.ts', `${source('const U = /b/')}export { U }\n`)
      const exported = createCbd({ root: repo.root, select: { emitCheck } }).select().selection
      assert.deepEqual(exported.tests, [0, 1])
    } finally {
      rmSync(toolchain, { recursive: true, force: true })
      repo.cleanup()
    }
  })

  test('a root inside the repository resolves only its own changes', () => {
    const repo = tempRepo()
    try {
      const pkg = join(realpath(repo.root), 'pkg')
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

  test('build keeps reads only under the root, inside include, and outside node_modules', () => {
    const repo = tempRepo()
    const root = realpath(repo.root)
    const a = join(root, 'src/a.ts')
    const docs = join(root, 'docs/note.md')
    const dep = join(root, 'node_modules/pkg/index.js')
    const outside = join(dirname(root), 'outside.ts')
    const spec = join(root, 'tests/a.spec.ts')
    try {
      repo.write('src/a.ts', 'export function add(a, b) {\n  return a + b;\n}\n')
      repo.write('docs/note.md', 'docs\n')
      repo.write('tests/a.spec.ts', "import { add } from '../src/a.js'\n")
      const commit = repo.commit('base')
      writeShard(
        root,
        'run.ndjson',
        shardText(commit, [
          {
            title: 'adds',
            file: spec,
            touches: [ref(a, 'add@0', 1, 3)],
            reads: [a, docs, dep, outside],
            dirReads: [join(root, 'src'), join(root, 'node_modules')],
          },
        ]),
      )

      // The map's read scope is the selection's: a change that could not select
      // this test (excluded, above the root, or inside node_modules) is not a
      // dependency the map needs to carry.
      const cbd = createCbd({
        root,
        select: { include: (path) => path.startsWith(join(root, 'src')) },
      })
      cbd.build()
      const loaded = loadMap(root, commit)
      assert.deepEqual(Object.keys(loaded.map.reads ?? {}), [a])
      assert.deepEqual(Object.keys(loaded.map.dirReads ?? {}), [join(root, 'src')])
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
      const root = realpath(repo.root)

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

  test('select keeps the old path of a file renamed out of include', () => {
    const { repo, cleanup } = prepared()
    try {
      const cbd = createCbd({ root: repo.root })
      cbd.build()
      repo.git(['mv', 'src/a.ts', 'archive-a.ts'])
      repo.commit('move a out of src')
      const root = realpath(repo.root)

      const scoped = createCbd({
        root: repo.root,
        select: { include: (path) => path.startsWith(join(root, 'src')) },
      })
      const { selection, selected } = scoped.select()
      // The old path's tests touched code that moved away; the new path is out of
      // scope and must not be what decides it.
      assert.equal(selection.mode, 'subset')
      assert.deepEqual(selected.map((entry) => entry.title).sort(), ['adds', 'reads'])
      assert.deepEqual(selection.ignored, [join(root, 'archive-a.ts')])
    } finally {
      cleanup()
    }
  })

  /**
   * A base older than the map's commit. Everything between them is already in
   * the map, but its hunks are in the base's line numbers: f moves from 5..7 to
   * 15..17 because g grew above it. Matching the base's line 6 against the map
   * points at g, so the test that reaches the changed f is silently dropped.
   */
  test('select --since reads a base older than the map in the map’s coordinates', () => {
    const repo = tempRepo()
    const root = realpath(repo.root)
    const a = join(root, 'src/a.ts')
    const spec = join(root, 'tests/a.spec.ts')
    try {
      repo.write(
        'src/a.ts',
        ['const x = 1', 'function g() {', '  return 1', '}', 'function f() {', '  return 2', '}'].join(
          '\n',
        ) + '\n',
      )
      repo.write('tests/a.spec.ts', "import { f } from '../src/a.js'\n")
      const base = repo.commit('base')

      repo.write(
        'src/a.ts',
        [
          'const x = 1',
          'function g() {',
          ...Array.from({ length: 10 }, (_, i) => `  let p${String(i)} = ${String(i)}`),
          '  return 1',
          '}',
          'function f() {',
          '  return 20',
          '}',
        ].join('\n') + '\n',
      )
      const mapCommit = repo.commit('map')
      writeShard(
        repo.root,
        'run.ndjson',
        shardText(mapCommit, [
          { title: 'tf', file: spec, touches: [ref(a, 'f@0', 15, 17)] },
          { title: 'tg', file: spec, touches: [ref(a, 'g@0', 2, 14)] },
        ]),
      )
      const cbd = createCbd({ root: repo.root })
      cbd.build()

      // Both functions changed between the base and the map commit, so both
      // tests are selected — but only if f's hunk is read at line 16, where the
      // map measured it.
      const result = cbd.select({ since: base })
      assert.equal(result.selection.mode, 'subset')
      assert.deepEqual(result.selected.map((entry) => entry.title).sort(), ['tf', 'tg'])
    } finally {
      repo.cleanup()
    }
  })

  /**
   * Rule 0 asks whether the config a map was built under still matches the one
   * loaded now. A config above `--root` is outside the relative diff, so it is
   * checked against the map's commit directly; comparing it with an older base
   * instead would force the whole suite for a config change the map already
   * contains.
   */
  test('select does not force all for a config change that predates the map', () => {
    const repo = tempRepo()
    const top = realpath(repo.root)
    const app = join(top, 'packages/app')
    const config = join(top, 'cbd.config.json')
    const a = join(app, 'src/a.ts')
    const spec = join(app, 'tests/a.spec.ts')
    try {
      repo.write('cbd.config.json', '{"include":["src/**"]}\n')
      repo.write('packages/app/src/a.ts', 'export const a = 1\n')
      repo.write('packages/app/tests/a.spec.ts', "import { a } from '../src/a.js'\n")
      const base = repo.commit('config v1')

      repo.write('cbd.config.json', '{"include":["src/**","lib/**"]}\n')
      repo.commit('config v2')
      repo.write('packages/app/src/a.ts', 'export const a = 2\n')
      const mapCommit = repo.commit('map')

      writeShard(
        app,
        'run.ndjson',
        shardText(mapCommit, [{ title: 'reads a', file: spec, touches: [ref(a, 'a@0', 1, 1)] }]),
      )
      const cbd = createCbd({ root: app, configFile: config })
      cbd.build()

      const result = cbd.select({ since: base })
      assert.equal(result.selection.mode, 'subset')
      assert.deepEqual(result.selected.map((entry) => entry.title), ['reads a'])
    } finally {
      repo.cleanup()
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

  test('explain on a module-scope line states the load observers select would add', () => {
    const repo = tempRepo()
    try {
      const root = realpath(repo.root)
      const lib = join(root, 'src/lib.ts')
      const other = join(root, 'src/other.ts')
      repo.write(
        'src/lib.ts',
        'export function add(a, b) {\n  return a + b;\n}\nexport const LIMIT = 3\nexport function setup() {}\n',
      )
      repo.write('src/other.ts', 'export function noop() {\n  return 0;\n}\n')
      const commit = repo.commit('base')
      // Two shards both loaded lib.ts; only the first has a test that ran add().
      writeShard(
        repo.root,
        'one.ndjson',
        shardText(
          commit,
          [
            { title: 'adds', file: null, touches: [ref(lib, 'add@0', 1, 3)] },
            { title: 'also one', file: null, touches: [ref(other, 'noop@0', 1, 3)] },
          ],
          { buckets: { load: [ref(lib, 'setup@0', 5, 5)] } },
        ),
      )
      writeShard(
        repo.root,
        'two.ndjson',
        shardText(
          commit,
          [{ title: 'only two', file: null, touches: [ref(other, 'noop@0', 1, 3)] }],
          { buckets: { load: [ref(lib, 'setup@0', 5, 5)] } },
        ),
      )
      const cbd = createCbd({ root: repo.root })
      cbd.build()

      const changes = [
        {
          path: lib,
          status: 'M' as const,
          hunks: [{ start: 4, end: 4 }],
          newHunks: [{ start: 4, end: 4 }],
          insertions: [],
        },
      ]
      const selected = cbd.select({ changes }).selected.length
      const module = cbd.explain('src/lib.ts:4')
      assert.equal(module.selection?.mode, 'subset')
      assert.equal(module.selection?.tests, selected)
      assert.equal(selected, 3)
      assert.deepEqual(module.tests, ['adds'])
      assert.deepEqual(
        module.selection?.reasons.map((reason) => [reason.kind, reason.count]),
        [['file', 3]],
      )

      // A function line is answered by the function, and select agrees.
      const fn = cbd.explain('src/lib.ts:2')
      assert.deepEqual(fn.tests, ['adds'])
      assert.equal(fn.selection?.tests, 1)
      assert.deepEqual(
        fn.selection?.reasons.map((reason) => [reason.kind, reason.count]),
        [['function', 1]],
      )
      // Without a line there is no what-if to run.
      assert.equal(cbd.explain('src/lib.ts').selection, undefined)
    } finally {
      repo.cleanup()
    }
  })

  test('explain answers a file, a line, and a bucket', () => {
    const { repo, a, commit, cleanup } = prepared()
    try {
      const loadedOnly = join(realpath(repo.root), 'src/startup.ts')
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
      const loadedOnly = join(realpath(repo.root), 'src/seen-only.ts')
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

test('stats survives a map with more functions than the argument limit', () => {
  const repo = tempRepo()
  const root = realpath(repo.root)
  try {
    repo.write('src/a.ts', 'export function f() {}\n')
    const commit = repo.commit('base')
    const functions: Record<string, { startLine: number; endLine: number; tests: number[] }> = {}
    for (let index = 0; index < 130_000; index += 1) {
      functions[`f${String(index)}@0`] = { startLine: index + 1, endLine: index + 1, tests: [0] }
    }
    const map: CoverageMap = {
      version: 1,
      commit,
      builtAt: 'T0',
      tests: [{ title: 't', file: join(root, 'tests/a.spec.ts') }],
      files: { [join(root, 'src/a.ts')]: functions },
      load: [],
      between: [],
      teardown: [],
      seen: [join(root, 'src/a.ts'), join(root, 'tests/a.spec.ts')],
      shards: ['s'],
    }
    saveMap(root, map)
    const stats = createCbd({ root }).stats()
    assert.equal(stats.functions, 130_000)
    assert.equal(stats.functionsPerFile.max, 130_000)
  } finally {
    repo.cleanup()
  }
})
