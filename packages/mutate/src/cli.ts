/**
 * `cbd-mutate select` — the generic mutation-testing selector.
 *
 * A mutation driver (Grizzly's `mutate.mjs`, a custom harness, or anything else)
 * owns mutant generation, application, builds, restarts and reporting. This
 * command owns one question: **which tests can observe a mutant at this source
 * location?** It answers from a CBD map and prints the candidates as data.
 *
 * The candidates are a **superset** of the tests that can kill the mutant: the
 * map records which functions each test executed, not which branch. A driver
 * must run the candidates and treat a mutant as killed when **any** candidate
 * fails — not when every candidate fails. Requiring every candidate to fail is
 * the mistake that would make this output useless.
 *
 * The file and line are in the map's coordinates: original source, 1-based. A
 * driver that applies a mutant to built output must supply the source location
 * separately (ADR-0016).
 */
import { join, resolve } from 'node:path'
import {
  loadMap,
  mutantTests,
  nearestMapCommit,
  type MutantPolicy,
  type MutantSelection,
} from '@spikedpunch/cbd'

const USAGE = `cbd-mutate — select candidate killer tests for a mutant from a CBD map

Usage:
  cbd-mutate select --file <source> --line <n> [options]

Options:
  --file <path>             Mutated source file (relative to --root)
  --line <n>                1-based line of the mutant
  --end-line <n>            End line for a range mutant (default: --line)
  --root <dir>              Repository root (default: the working directory)
  --state-dir <dir>         CBD state directory (default: .cbd)
  --commit <sha>            Map commit (default: the nearest map to HEAD)
  --between-policy <p>      all | ignore (default: all)
  --unknown-policy <p>      all | ignore (default: all)
  --format <text|json>      Output format (default: text)
  -h, --help                Show this help

A subset is a superset of the tests that can kill the mutant; run the candidates
and treat the mutant as killed when any one fails.`

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

export interface SelectOptions {
  file: string
  line: number
  endLine?: number
  root: string
  stateDir: string
  commit?: string
  format: 'text' | 'json'
  policy: MutantPolicy
}

export function main(
  argv: string[],
  io: CliIo = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  },
): number {
  let parsed: SelectOptions | 'help'
  try {
    parsed = parseSelectArgs(argv)
  } catch (error) {
    io.err(`cbd-mutate: ${String(error)}`)
    io.err(USAGE)
    return 2
  }
  if (parsed === 'help') {
    io.out(USAGE)
    return 0
  }
  try {
    io.out(formatSelection(selectMutant(parsed), parsed.format))
    return 0
  } catch (error) {
    io.err(`cbd-mutate: ${String(error)}`)
    return 1
  }
}

/** Parse one `select` invocation. Exported so argument errors are unit-testable. */
export function parseSelectArgs(argv: string[]): SelectOptions | 'help' {
  if (argv.includes('-h') || argv.includes('--help')) return 'help'
  if (argv[0] !== 'select') {
    throw new Error('expected the `select` command')
  }

  let file: string | undefined
  let line: number | undefined
  let endLine: number | undefined
  let root = process.cwd()
  let stateDir = '.cbd'
  let commit: string | undefined
  let format: 'text' | 'json' = 'text'
  let betweenPolicy: 'all' | 'ignore' = 'all'
  let unknownPolicy: 'all' | 'ignore' = 'all'

  const value = (index: number, flag: string): string => {
    const next = argv[index]
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} takes a value`)
    return next
  }
  const integer = (raw: string, flag: string): number => {
    if (!/^[0-9]+$/.test(raw)) throw new Error(`${flag} takes a positive integer`)
    return Number(raw)
  }

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--file') file = value(++index, arg)
    else if (arg === '--line') line = integer(value(++index, arg), arg)
    else if (arg === '--end-line') endLine = integer(value(++index, arg), arg)
    else if (arg === '--root') root = value(++index, arg)
    else if (arg === '--state-dir') stateDir = value(++index, arg)
    else if (arg === '--commit') commit = value(++index, arg)
    else if (arg === '--format') {
      const raw = value(++index, arg)
      if (raw !== 'text' && raw !== 'json') throw new Error('--format is text or json')
      format = raw
    } else if (arg === '--between-policy') {
      const raw = value(++index, arg)
      if (raw !== 'all' && raw !== 'ignore') throw new Error('--between-policy is all or ignore')
      betweenPolicy = raw
    } else if (arg === '--unknown-policy') {
      const raw = value(++index, arg)
      if (raw !== 'all' && raw !== 'ignore') throw new Error('--unknown-policy is all or ignore')
      unknownPolicy = raw
    } else {
      throw new Error(`unexpected argument: ${arg}`)
    }
  }

  if (file === undefined || file === '') throw new Error('--file is required')
  if (line === undefined) throw new Error('--line is required')
  if (line < 1) throw new Error('--line is 1-based')
  if (endLine !== undefined && endLine < line) throw new Error('--end-line must not be before --line')

  return {
    file,
    line,
    ...(endLine === undefined ? {} : { endLine }),
    root: resolve(root),
    stateDir,
    ...(commit === undefined ? {} : { commit }),
    format,
    policy: { root: resolve(root), betweenPolicy, unknownPolicy },
  }
}

/** Load the map and answer the mutant query. */
export function selectMutant(options: SelectOptions): MutantSelection {
  const commit = options.commit ?? nearestMapCommit(options.root, options.stateDir)
  if (commit === undefined) {
    throw new Error(
      `no map under ${join(options.root, options.stateDir, 'maps')}. Record one with ` +
        '`cbd collect --no-select -- <test command>` first.',
    )
  }
  const map = loadMap(options.root, commit, options.stateDir).map
  return mutantTests(
    map,
    {
      file: options.file,
      startLine: options.line,
      ...(options.endLine === undefined ? {} : { endLine: options.endLine }),
    },
    options.policy,
  )
}

/** Render a selection for a human or a driver. */
export function formatSelection(selection: MutantSelection, format: 'text' | 'json'): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        mode: selection.mode,
        why: selection.why,
        titles: selection.tests.map((test) => test.title),
        tests: selection.tests,
      },
      null,
      2,
    )
  }
  if (selection.mode === 'all') return `all (${selection.why}): run every test`
  if (selection.mode === 'none') return `none (${selection.why}): no test reaches this mutant`
  const lines = [`subset (${selection.why}): ${String(selection.tests.length)} candidate test(s)`]
  for (const test of selection.tests) lines.push(`  - ${test.title}`)
  return lines.join('\n')
}
