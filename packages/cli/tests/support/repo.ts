/**
 * The repository and the fake runner the CLI tests share.
 *
 * A real git repository and a real on-disk shard, because the exit codes and the
 * selection both depend on what git actually emits. The runner is a stand-in for a
 * framework: it reads the same environment a real adapter reads (`CBD_SHARD`,
 * `CBD_COMMIT`, `CBD_SELECTION`) and writes the shard records `buildMap` consumes,
 * which is the contract `collect` has with a suite it did not write.
 */
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TouchRef } from '@spikedpunch/cbd'
import { run } from '../../src/cli.js'
import { tempRepo, type TempRepo } from './git.js'

export interface Captured {
  code: number
  out: string[]
  err: string[]
}

export function invoke(cwd: string, ...argv: string[]): Captured {
  const out: string[] = []
  const err: string[] = []
  const code = run(argv, { cwd, out: (line) => out.push(line), err: (line) => err.push(line) })
  return { code, out, err }
}

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
 * A v2 shard written from map-coordinate touches.
 *
 * The recorder would emit script ids and byte ranges; the build resolves them. A
 * fixture that only *sees* a file (a load bucket for a module no test reaches) gets
 * the file created with enough lines, because "seen" now means "resolved".
 */
export function shardText(
  commit: string,
  tests: Array<{ title: string; file: string | null; touches: TouchRef[] }>,
  buckets: Partial<Record<'load' | 'between' | 'teardown', TouchRef[]>> = {},
): string {
  const records: unknown[] = [{ type: 'shard', version: 2, commit, pid: 1, startedAt: 'T0' }]
  const scripts = new Map<string, { id: string; url: string; size: number; mtimeMs: number }>()
  const texts = new Map<string, string>()
  const functions = new Set<string>()

  const rowsFor = (touches: TouchRef[]): Record<string, [number, number][]> => {
    const out: Record<string, [number, number][]> = {}
    for (const [file, key, startLine, endLine] of touches) {
      let text = texts.get(file)
      if (text === undefined) {
        try {
          text = readFileSync(file, 'utf8')
        } catch {
          mkdirSync(dirname(file), { recursive: true })
          text = '// synthetic\n'.repeat(Math.max(endLine, 1))
          writeFileSync(file, text)
        }
        texts.set(file, text)
      }
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
        records.push({ type: 'function', scriptId: script.id, start, end, name: key.replace(/@\d+$/, '') })
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
    const touches = buckets[kind]
    if (touches !== undefined) records.push({ type: kind, touches: rowsFor(touches) })
  }
  records.push({ type: 'end', tests: tests.length, finishedAt: 'T1' })
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

/**
 * A suite that obeys CBD's environment instead of a framework.
 *
 * Arguments, in order: a log path (so a test can see what `collect` passed), the
 * source and spec paths it credits, an exit code, and optionally a signal to die
 * by. With a selection file it records exactly those titles; without one it records
 * both, which is what "the runner ran everything" looks like from here.
 */
export const RUNNER = `import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [logPath, src, spec, exitCode = '0', signal] = process.argv.slice(2)
const selectionPath = process.env.CBD_SELECTION
const selectionText = selectionPath === undefined ? null : readFileSync(selectionPath, 'utf8')
appendFileSync(
  logPath,
  JSON.stringify({
    shard: process.env.CBD_SHARD ?? null,
    commit: process.env.CBD_COMMIT ?? null,
    selection: selectionPath ?? null,
    selectionContent: selectionText,
    inspect: process.env.CBD_INSPECT ?? null,
    allowRemote: process.env.CBD_INSPECT_ALLOW_REMOTE ?? null,
    granularity: process.env.CBD_GRANULARITY ?? null,
  }) + '\\n',
)

const shard = process.env.CBD_SHARD
const commit = process.env.CBD_COMMIT
const header = { type: 'shard', version: 2, commit, pid: process.pid, startedAt: 'T0' }

// A header with no footer is exactly the shape a SIGKILL leaves behind.
if (signal !== undefined) {
  writeFileSync(shard, JSON.stringify(header) + '\\n')
  process.kill(process.pid, signal)
}

const selection = selectionText === null ? undefined : JSON.parse(selectionText)
// The adapter-neutral v2 file first, the older title-only file for a caller that
// still writes one; this stand-in runner reads what a real adapter reads.
const titles =
  selection === undefined
    ? ['adds', 'reads']
    : selection.tests !== undefined
      ? selection.tests.map((test) => test.title)
      : selection.titles

// A v2 shard records byte ranges, not resolved tuples: the fixture's three-line
// add spans line 1 to the start of line 3, and the script table says which bytes.
const text = readFileSync(src, 'utf8')
const starts = [0]
for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1)
// Offset 0 is the module body; a named function starts after it.
const start = text.length > 1 ? 1 : 0
const end = Math.max(start, starts[2] ?? start)
const stat = statSync(src)
const records = [
  header,
  { type: 'script', scriptId: '1', url: pathToFileURL(src).href, size: stat.size, mtimeMs: stat.mtimeMs },
  { type: 'function', scriptId: '1', start, end, name: 'add' },
]
for (const title of titles) {
  records.push({
    type: 'test',
    title,
    file: spec,
    status: 'passed',
    durationMs: 1,
    touches: { 1: [[start, end]] },
  })
}
records.push({ type: 'end', tests: titles.length, finishedAt: 'T1' })
writeFileSync(shard, records.map((record) => JSON.stringify(record)).join('\\n') + '\\n')
process.exit(Number(exitCode))
`

export interface PreparedRepo {
  repo: TempRepo
  root: string
  a: string
  spec: string
  /** The fake runner, relative to `root`, which is where `collect` spawns it. */
  runner: string
  cleanup: () => void
}

export interface PreparedOptions {
  /**
   * Evidence outside any test window, so the map sees a file no test reaches.
   * Paths are repository-relative; a `load` entry is the common case and is what
   * `cbd stats` reports as untested.
   */
  buckets?: Partial<Record<'load' | 'between' | 'teardown', Array<[string, string, number, number]>>>
  /** Written as `cbd.config.json` before the base commit, so it is part of it. */
  config?: Record<string, unknown>
}

/** A repository with one commit, one spec, a shard for that commit, and the runner. */
export function prepared(options: PreparedOptions = {}): PreparedRepo {
  const repo = tempRepo()
  const root = realpathSync(repo.root)
  const a = join(root, 'src/a.ts')
  const spec = join(root, 'tests/a.spec.ts')
  // CBD.md §9.3: `.cbd/` is a build artifact and gitignored. Without this the
  // shard and map files would themselves be changed files in every selection, and
  // the untracked runner would make every map "built from a dirty tree".
  repo.write('.gitignore', '.cbd/\nrunner.mjs\n')
  if (options.config !== undefined) {
    repo.write('cbd.config.json', `${JSON.stringify(options.config, null, 2)}\n`)
  }
  repo.write('src/a.ts', 'export function add(a, b) {\n  return a + b;\n}\n')
  repo.write('tests/a.spec.ts', "import { add } from '../src/a.js'\n")
  const commit = repo.commit('base')

  const at = (file: string, key: string, start: number, end: number): TouchRef =>
    ref(join(root, file), key, start, end)
  const evidence = (
    kind: 'load' | 'between' | 'teardown',
  ): TouchRef[] | undefined =>
    options.buckets?.[kind]?.map(([file, key, start, end]) => at(file, key, start, end))

  const dir = join(root, '.cbd', 'shards')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'run.ndjson'),
    shardText(
      commit,
      [
        { title: 'adds', file: spec, touches: [ref(a, 'add@0', 1, 3)] },
        { title: 'reads', file: spec, touches: [ref(a, 'add@0', 1, 3)] },
      ],
      {
        load: evidence('load'),
        between: evidence('between'),
        teardown: evidence('teardown'),
      },
    ),
  )

  // Written after the commit, so it is untracked and `git diff` never reports it
  // as a changed file in a selection.
  writeFileSync(join(root, 'runner.mjs'), RUNNER)

  return { repo, root, a, spec, runner: 'runner.mjs', cleanup: () => repo.cleanup() }
}
