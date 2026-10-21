/**
 * `select --since <base>` where the base predates the map's commit.
 *
 * The change between the base and the map is already recorded in the map, but git
 * reports it in the base's line numbers. Matching those against the map's function
 * ranges names whatever now occupies the old lines. These are the shapes that
 * broke: a function moved above, a deletion, a deletion sharing a file with an
 * ordinary hunk, a base newer than or divergent from the map, and a trigger that
 * changed only between the base and the map.
 */
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { createCbd } from '../src/factory.js'
import { MAP_VERSION, saveMap, type CoverageMap } from '../src/map.js'
import { tempRepo } from './support/git.js'

const BASE = [
  'const x = 1', // 1
  'function g() {', // 2
  '  return 1', // 3
  '}', // 4
  'function f() {', // 5
  '  return 2', // 6
  '}', // 7
].join('\n') + '\n'

/** f's body line is deleted; nothing else changes. */
const DELETED = [
  'const x = 1',
  'function g() {',
  '  return 1',
  '}',
  'function f() {',
  '}',
].join('\n') + '\n'

/** The same deletion, sharing the file with an ordinary hunk in g. */
const DELETED_WITH_HUNK = [
  'const x = 1',
  'function g() {',
  '  return 11',
  '}',
  'function f() {',
  '}',
].join('\n') + '\n'

/** Ten lines inserted inside g; f is unchanged but now sits at 15..17. */
const MOVED = [
  'const x = 1',
  'function g() {',
  ...Array.from({ length: 10 }, (_, i) => `  let p${String(i)} = ${String(i)}`),
  '  return 1',
  '}',
  'function f() {',
  '  return 2',
  '}',
].join('\n') + '\n'

/** 1-based ranges of each simple `function name() { ... }` block. */
function functionRanges(text: string): Map<string, { startLine: number; endLine: number }> {
  const lines = text.split('\n')
  const ranges = new Map<string, { startLine: number; endLine: number }>()
  for (let start = 0; start < lines.length; start += 1) {
    const match = /^function (\w+)\(\) \{/.exec(lines[start]!)
    if (match === null) continue
    for (let end = start + 1; end < lines.length; end += 1) {
      if (lines[end] !== '}') continue
      ranges.set(match[1]!, { startLine: start + 1, endLine: end + 1 })
      start = end
      break
    }
  }
  return ranges
}

/**
 * A handcrafted map at `commit`, in the line numbers of the file currently on disk.
 *
 * `fn` is the function a test reaches; a test with no function (an alwaysSelect
 * oracle) still belongs in the registry but contributes no coverage entry.
 */
function writeMap(
  root: string,
  commit: string,
  source: string,
  spec: string,
  tests: Array<{ title: string; fn?: string }>,
): void {
  const ranges = functionRanges(readFileSync(source, 'utf8'))
  const functions: Record<string, { startLine: number; endLine: number; tests: number[] }> = {}
  tests.forEach((entry, index) => {
    if (entry.fn === undefined) return
    const range = ranges.get(entry.fn)
    assert.ok(range !== undefined, `the map commit must define ${entry.fn}`)
    functions[entry.fn] = { ...range, tests: [index] }
  })
  const map: CoverageMap = {
    version: MAP_VERSION,
    commit,
    builtAt: '2026-01-01T00:00:00.000Z',
    tests: tests.map((entry) => ({
      id: `${spec}::${entry.title}`,
      title: entry.title,
      file: spec,
    })),
    files: { [source]: functions },
    load: [],
    between: [],
    teardown: [],
    seen: [source],
    shards: ['since'],
    shardTests: [tests.map((_, index) => index)],
  }
  saveMap(root, map, '.cbd')
}

test.group('select --since coordinates', (group) => {
  group.each.timeout(120_000)

  test('a deletion between the base and the map selects the function it was deleted from', () => {
    const repo = tempRepo()
    const root = realpathSync(repo.root)
    const source = join(root, 'src/a.ts')
    const spec = join(root, 'tests/a.spec.ts')
    try {
      repo.write('src/a.ts', BASE)
      repo.write('tests/a.spec.ts', "import { f } from '../src/a.js'\n")
      const base = repo.commit('base')
      repo.write('src/a.ts', DELETED)
      const mapCommit = repo.commit('map')
      writeMap(root, mapCommit, source, spec, [
        { title: 'tf', fn: 'f' },
        { title: 'tg', fn: 'g' },
      ])

      // The deletion is a zero-length new-side range; its point (after line 5)
      // is inside f at the map commit.
      const result = createCbd({ root }).select({ since: base })
      assert.equal(result.selection.mode, 'subset')
      assert.deepEqual(result.selected.map((entry) => entry.title), ['tf'])
    } finally {
      repo.cleanup()
    }
  })

  test('a deletion sharing a file with an ordinary hunk does not vanish from the selection', () => {
    const repo = tempRepo()
    const root = realpathSync(repo.root)
    const source = join(root, 'src/a.ts')
    const spec = join(root, 'tests/a.spec.ts')
    try {
      repo.write('src/a.ts', BASE)
      repo.write('tests/a.spec.ts', "import { f } from '../src/a.js'\n")
      const base = repo.commit('base')
      repo.write('src/a.ts', DELETED_WITH_HUNK)
      const mapCommit = repo.commit('map')
      writeMap(root, mapCommit, source, spec, [
        { title: 'tf', fn: 'f' },
        { title: 'tg', fn: 'g' },
      ])

      // g's hunk alone used to be the whole answer: the deletion had no new-side
      // range and the file-level fallback does not fire while any hunk remains.
      const result = createCbd({ root }).select({ since: base })
      assert.equal(result.selection.mode, 'subset')
      assert.deepEqual(result.selected.map((entry) => entry.title).sort(), ['tf', 'tg'])
    } finally {
      repo.cleanup()
    }
  })

  test('a function moved between the base and the map is found after it moves again in the worktree', () => {
    const repo = tempRepo()
    const root = realpathSync(repo.root)
    const source = join(root, 'src/a.ts')
    const spec = join(root, 'tests/a.spec.ts')
    try {
      repo.write('src/a.ts', BASE)
      repo.write('tests/a.spec.ts', "import { f } from '../src/a.js'\n")
      const base = repo.commit('base')
      repo.write('src/a.ts', MOVED)
      const mapCommit = repo.commit('map')
      writeMap(root, mapCommit, source, spec, [
        { title: 'tf', fn: 'f' },
        { title: 'tg', fn: 'g' },
      ])
      // f is at 15..17 in the map; the worktree edits its body at line 16.
      repo.write('src/a.ts', MOVED.replace('  return 2', '  return 20'))

      const result = createCbd({ root }).select({ since: base })
      assert.equal(result.selection.mode, 'subset')
      assert.deepEqual(result.selected.map((entry) => entry.title).sort(), ['tf', 'tg'])
    } finally {
      repo.cleanup()
    }
  })

  test('a base newer than the map still selects the worktree change through the map leg', () => {
    const repo = tempRepo()
    const root = realpathSync(repo.root)
    const source = join(root, 'src/a.ts')
    const spec = join(root, 'tests/a.spec.ts')
    try {
      repo.write('src/a.ts', BASE)
      repo.write('tests/a.spec.ts', "import { f } from '../src/a.js'\n")
      repo.commit('base')
      repo.write('src/a.ts', MOVED)
      const mapCommit = repo.commit('map')
      writeMap(root, mapCommit, source, spec, [
        { title: 'tf', fn: 'f' },
        { title: 'tg', fn: 'g' },
      ])
      repo.write('src/a.ts', MOVED.replace('  return 2', '  return 20'))
      const newer = repo.commit('after the map')

      // The base is a descendant of the map's commit, so the base leg is a reverse
      // two-tree diff; the map-to-worktree leg still sees the edit in map lines.
      const result = createCbd({ root }).select({ since: newer, commit: mapCommit })
      assert.notEqual(result.selection.mode, 'all')
      assert.ok(
        result.selected.some((entry) => entry.title === 'tf'),
        `tf was dropped: ${result.selected.map((entry) => entry.title).join(', ') || 'none'}`,
      )
    } finally {
      repo.cleanup()
    }
  })

  test('a base on a divergent branch does not hide the worktree change', () => {
    const repo = tempRepo()
    const root = realpathSync(repo.root)
    const source = join(root, 'src/a.ts')
    const spec = join(root, 'tests/a.spec.ts')
    try {
      repo.write('src/a.ts', BASE)
      repo.write('tests/a.spec.ts', "import { f } from '../src/a.js'\n")
      repo.commit('base')
      repo.git(['checkout', '-q', '-b', 'side'])
      repo.write('src/a.ts', BASE.replace('  return 1', '  return 99'))
      repo.commit('side')
      repo.git(['checkout', '-q', 'main'])

      repo.write('src/a.ts', BASE.replace('  return 1', '  return 11'))
      const mapCommit = repo.commit('map')
      writeMap(root, mapCommit, source, spec, [
        { title: 'tf', fn: 'f' },
        { title: 'tg', fn: 'g' },
      ])
      repo.write('src/a.ts', BASE.replace('  return 1', '  return 11').replace('  return 2', '  return 20'))

      // The two trees are compared directly, not through a merge base.
      const result = createCbd({ root }).select({ since: 'side' })
      assert.notEqual(result.selection.mode, 'all')
      assert.ok(
        result.selected.some((entry) => entry.title === 'tf'),
        `tf was dropped: ${result.selected.map((entry) => entry.title).join(', ') || 'none'}`,
      )
      assert.equal(result.map.commit, mapCommit)
    } finally {
      repo.cleanup()
    }
  })

  test('an alwaysSelect trigger that changed only between the base and the map still fires', () => {
    const repo = tempRepo()
    const root = realpathSync(repo.root)
    const source = join(root, 'src/a.ts')
    const spec = join(root, 'tests/a.spec.ts')
    try {
      repo.write('src/a.ts', BASE)
      repo.write('tests/a.spec.ts', "import { f } from '../src/a.js'\n")
      repo.write('schema/type.txt', 'v1\n')
      const base = repo.commit('base')
      repo.write('schema/type.txt', 'v2\n')
      const mapCommit = repo.commit('map')
      writeMap(root, mapCommit, source, spec, [
        { title: 'code', fn: 'f' },
        { title: 'oracle' },
      ])

      // The trigger is outside include, so it survives the scope filter only
      // through claimedByWhen; the alwaysSelect entry then fires on it.
      const cbd = createCbd({
        root,
        select: {
          include: (path) => path.endsWith('a.ts'),
          alwaysSelect: [
            {
              tests: [{ file: spec, title: 'oracle' }],
              when: [join(root, 'schema/**')],
            },
          ],
        },
      })
      const result = cbd.select({ since: base })
      assert.equal(result.selection.mode, 'subset')
      assert.deepEqual(result.selected.map((entry) => entry.title), ['oracle'])
    } finally {
      repo.cleanup()
    }
  })
})

// --- histories ------------------------------------------------------------

interface Program {
  module: string[]
  functions: Array<{ name: string; body: string[] }>
}

type Edit = { name: string; apply: (program: Program) => void }

const ORIGINAL: Program = {
  module: ['const x = 1'],
  functions: [
    { name: 'g', body: ['return 1'] },
    { name: 'f', body: ['let a = 1', 'return a'] },
  ],
}

/**
 * The edit kinds a change to one file can have. They are applied to a structured
 * program so a pair can compose (the deletion plus an edit is the shape that
 * exposed the bug).
 */
const EDITS: Edit[] = [
  {
    name: 'insert above f',
    apply: (program) => program.functions.find((fn) => fn.name === 'g')!.body.push('const pad = 0'),
  },
  {
    name: 'edit g',
    apply: (program) => {
      const g = program.functions.find((fn) => fn.name === 'g')!
      g.body[0] = 'return 10'
    },
  },
  {
    name: 'edit f',
    apply: (program) => {
      const f = program.functions.find((fn) => fn.name === 'f')!
      f.body[0] = 'let a = 9'
    },
  },
  {
    name: 'delete from f',
    apply: (program) => program.functions.find((fn) => fn.name === 'f')!.body.pop(),
  },
  {
    name: 'edit module',
    apply: (program) => {
      program.module[0] = 'const x = 2'
    },
  },
  {
    name: 'reorder functions',
    apply: (program) => program.functions.reverse(),
  },
]

function copyProgram(program: Program): Program {
  return {
    module: [...program.module],
    functions: program.functions.map((fn) => ({ name: fn.name, body: [...fn.body] })),
  }
}

function render(program: Program): string {
  const lines = [...program.module]
  for (const fn of program.functions) {
    lines.push(`function ${fn.name}() {`, ...fn.body.map((line) => `  ${line}`), '}')
  }
  return lines.join('\n') + '\n'
}

test.group('select --since histories', (group) => {
  group.each.timeout(120_000)

  /**
   * For every small history, every test whose function body differs between the
   * base and the worktree must be selected. Over-selection is allowed; a miss is
   * not. Ground truth matches functions by name, so it is blind to renames and to
   * whole-function add/delete, which these histories do not produce.
   */
  test('every pair of edits in one leg, and every pair across the legs, is complete', () => {
    const cases: Array<{ label: string; map: Program; work: Program }> = []

    // Pairs within the base leg: the deletion plus an ordinary hunk is one.
    for (let first = 0; first < EDITS.length; first += 1) {
      for (let second = first; second < EDITS.length; second += 1) {
        const map = copyProgram(ORIGINAL)
        EDITS[first]!.apply(map)
        EDITS[second]!.apply(map)
        cases.push({
          label: `base leg: ${EDITS[first]!.name} + ${EDITS[second]!.name}`,
          map,
          work: map,
        })
      }
    }

    // One edit between base and map, another between the map and the worktree.
    for (const first of EDITS) {
      for (const second of EDITS) {
        const map = copyProgram(ORIGINAL)
        first.apply(map)
        const work = copyProgram(map)
        second.apply(work)
        cases.push({ label: `legs: ${first.name} then ${second.name}`, map, work })
      }
    }


    const repo = tempRepo()
    const root = realpathSync(repo.root)
    const source = join(root, 'src/a.ts')
    const spec = join(root, 'tests/a.spec.ts')
    try {
      // One repository for every history: each case resets to the same base, so a
      // 57-case property does not pay for 57 inits. `.cbd` is ignored, so the
      // reset leaves the maps already written for the per-case commits.
      repo.write('.gitignore', '.cbd/\n')
      repo.write('src/a.ts', render(ORIGINAL))
      repo.write('tests/a.spec.ts', "import { f } from '../src/a.js'\n")
      const base = repo.commit('base')

      for (const entry of cases) {
        repo.git(['reset', '--hard', base])
        repo.write('src/a.ts', render(entry.map))
        // An edit pair can cancel itself (reorder twice), leaving the map's tree
        // equal to the base; that is still a valid map commit.
        repo.git(['add', '-A'])
        repo.git(['commit', '--allow-empty', '-q', '-m', 'map'])
        const mapCommit = repo.head()
        writeMap(root, mapCommit, source, spec, [
          { title: 'tf', fn: 'f' },
          { title: 'tg', fn: 'g' },
        ])
        repo.write('src/a.ts', render(entry.work))

        const result = createCbd({ root }).select({ since: base })
        if (result.selection.mode === 'all') continue

        const selected = new Set(result.selected.map((test) => test.title))
        const required = new Set<string>()
        if (ORIGINAL.module.join('\n') !== entry.work.module.join('\n')) {
          for (const test of ['tf', 'tg']) required.add(test)
        }
        const before = new Map(ORIGINAL.functions.map((fn) => [fn.name, fn.body.join('\n')]))
        for (const fn of entry.work.functions) {
          if (before.get(fn.name) !== fn.body.join('\n')) {
            required.add(fn.name === 'f' ? 'tf' : 'tg')
          }
        }
        for (const title of required) {
          assert.ok(
            selected.has(title),
            `${entry.label}: ${title} reaches a function that changed but was not selected ` +
              `(selected: ${[...selected].join(', ') || 'none'})`,
          )
        }
      }
    } finally {
      repo.cleanup()
    }
  })
})
