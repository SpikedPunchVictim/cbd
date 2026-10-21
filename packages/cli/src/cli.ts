/**
 * The `cbd` binary: four commands over one config, no second implementation.
 *
 * Every command resolves its config the same way, builds one `createCbd` and calls
 * one verb. Rendering happens on the way out, so the text a person reads and the
 * JSON a script reads are the same answer (`--format json` prints the verb's result
 * itself). Nothing here records or runs a suite — that is `cbd-pfu`'s `collect`.
 *
 * **Exit codes are part of the interface.** `select` exits 3 when the answer is
 * "run everything", which is not an error, so a script can branch on it without
 * parsing output; a real failure exits 1 and a malformed command exits 2. Keeping
 * "all" distinct from "failed" is what lets CI write `cbd select && …` without
 * silently skipping the suite when a map is missing.
 *
 * **Quiet by default.** A human gets one line per selected test plus a summary, or
 * one line per reason when everything runs. Warnings go to stderr so they cannot be
 * mistaken for selected tests by a pipe.
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  createCbd,
  headCommit,
  loadConfig,
  loadConfigFile,
  parseUnifiedDiff,
  writeSelection,
  type BuildResult,
  type Cbd,
  type CbdConfig,
  type Change,
  type ExplainResult,
  type ReachRow,
  type ReachRowResult,
  type ReachesResult,
  type SelectResult,
  type StatsResult,
} from '@spikedpunch/cbd'
import { UsageError, parseArgs, type ParsedArgs } from './args.js'
import { collect } from './collect.js'
import { EXIT } from './exit.js'
import { DEFAULT_KEEP, gc, type GcResult } from './gc.js'
import { versions } from './version.js'
import {
  batchLines,
  buildLines,
  explainLines,
  gcLines,
  plural,
  reachesLines,
  renderJson,
  selectLines,
  statsLines,
  summaryLines,
} from './render.js'

export { EXIT } from './exit.js'

export interface Io {
  out(line: string): void
  err(line: string): void
}

export interface RunOptions extends Io {
  cwd: string
}

const HELP = `cbd — run the tests that reach the code you changed

Usage:
  cbd --version
  cbd build   [--commit <sha>] [--partial] [--incremental [--base <sha>]] [--root <dir>]
  cbd select  [--since <ref>] [--no-worktree] [--strict] [--commit <sha>]
              [--patch <file.diff> | --change <path>:<start>[-<end>]]
              [--emit-selection <path>] [--format text|json|summary]
  cbd explain <file>[:<line>] [--root <dir>] [--format json]
  cbd reaches <test-title> <file>[:<line>] [--file <test-file>] [--format json]
  cbd reaches --batch <rows.json> [--format json]
  cbd stats   [--commit <sha>] [--root <dir>] [--format json]
  cbd collect [--no-select] [--no-build] [--shard <path>] [--incremental]
              -- <test command>
  cbd gc      [--keep <n>] [--root <dir>] [--format json]

select exits 0 when it selected a subset and 3 when the answer is "run all",
so a script can branch without parsing output. Failures exit 1; bad arguments 2.
--patch and --change ask what a prospective edit would select without applying it:
the patch is parsed by the same diff reader --since uses, and the changed lines are
old-side, as a map always is. Patch paths are read relative to --root, the same
coordinate --since prints.

collect runs the test command with CBD_SHARD and CBD_COMMIT set, selects first
(unless --no-select), and builds the map in the same process afterwards
(unless --no-build). It exits with the test command's status. An empty
selection runs nothing instead of handing the runner an empty filter.

gc keeps the newest --keep runs of each kind (default 10) under the state
directory and removes the rest. It always keeps the map select is using, and
never touches anything else in .cbd.

reaches answers the question explain asks backwards: does this one test reach this
file or line? A bare title that names more than one test is refused; --file picks
one. explain names the tests per function, stats summarises the map.

The root is the nearest directory upward with a cbd.config.json, else the git
top level, else the working directory; --root overrides it. The config is
<root>/cbd.config.json unless --config names another; a missing default config
means the safe defaults, a missing explicit one is an error.`

function configFor(parsed: ParsedArgs): CbdConfig {
  if (parsed.config !== undefined) {
    const loaded = loadConfigFile(parsed.config, parsed.root)
    if (loaded === undefined) throw new Error(`config file not found: ${parsed.config}`)
    return loaded.config
  }
  return loadConfig(parsed.root)?.config ?? { root: parsed.root }
}

/** One `cbd:` prefix, whether the message came from this package or the core. */
const said = (message: string): string => (message.startsWith('cbd:') ? message : `cbd: ${message}`)

function output(parsed: ParsedArgs, value: unknown, lines: string[], io: Io): void {
  const rendered = parsed.format === 'json' ? renderJson(value) : lines
  for (const line of rendered) io.out(line)
}

function runVersion(parsed: ParsedArgs, io: Io): number {
  const v = versions()
  output(parsed, v, [`cbd ${v.cli} (@spikedpunch/cbd ${v.core})`], io)
  return EXIT.ok
}

function runBuild(cbd: Cbd, parsed: ParsedArgs, io: Io): number {
  const result: BuildResult = cbd.build({
    ...(parsed.commit === undefined ? {} : { commit: parsed.commit }),
    ...(parsed.partial ? { partial: true } : {}),
    ...(parsed.incremental ? { incremental: true } : {}),
    ...(parsed.base === undefined ? {} : { base: parsed.base }),
  })
  output(parsed, result, buildLines(result, parsed.root), io)
  return EXIT.ok
}

function runSelect(cbd: Cbd, parsed: ParsedArgs, io: Io): number {
  const changes = changesFrom(parsed)
  const result: SelectResult = cbd.select({
    ...(parsed.since === undefined ? {} : { since: parsed.since }),
    ...(parsed.commit === undefined ? {} : { commit: parsed.commit }),
    ...(changes === undefined ? { worktree: parsed.worktree } : { changes }),
    strict: parsed.strict,
  })
  for (const warning of result.selection.warnings) io.err(`cbd: warning: ${warning}`)
  // A patch made at the repository top level has top-level paths; under a nested
  // `--root` they resolve one level too deep and match no include glob. The answer
  // is then "no tests", which is easy to misread as "there is nothing to run".
  if (
    parsed.patch !== undefined &&
    result.changes.length === 0 &&
    result.selection.ignored.length > 0
  ) {
    io.err(
      `cbd: warning: none of the paths in ${parsed.patch} is inside this project's ` +
        `include; --patch paths are read relative to ${parsed.root}`,
    )
  }
  if (parsed.emitSelection !== undefined) emitSelection(parsed, result, io)
  if (parsed.format === 'summary') {
    for (const line of summaryLines(result)) io.out(line)
  } else {
    // The JSON answer carries the version that produced it, so a consumer can
    // refuse an answer from an older CLI without a second process (`cbd-73r.4`).
    const value = parsed.format === 'json' ? { ...result, cbdVersion: versions().cli } : result
    output(parsed, value, selectLines(result, parsed.root), io)
  }
  return result.selection.mode === 'all' ? EXIT.all : EXIT.ok
}

/**
 * Writes the file an adapter reads, or removes a stale one.
 *
 * `mode: all` deliberately leaves no file: a runner handed a previous run's
 * selection would run a narrow subset of a suite that has been declared
 * unanswerable, which is the one mistake the whole tool is arranged to avoid. The
 * flag owns the path, so removing what it wrote before is not reaching into
 * someone else's data.
 */
function emitSelection(parsed: ParsedArgs, result: SelectResult, io: Io): void {
  const path = parsed.emitSelection!
  // An empty selection file is not "run nothing": every adapter reads an empty
  // filter as "run everything" and refuses the file for that reason. No file is
  // the honest handoff, and the exit code (0 for a subset, 3 for all) says which
  // of the two no-file cases this is.
  if (result.selection.mode === 'all' || result.selected.length === 0) {
    const why = result.selection.mode === 'all' ? 'selection is all' : 'no tests are selected'
    if (existsSync(path)) {
      unlinkSync(path)
      io.err(`cbd: ${why}; removed the stale ${path}`)
    } else {
      io.err(`cbd: ${why}; no selection file written`)
    }
    return
  }
  writeSelection(path, result.selected)
  io.err(`cbd: wrote ${plural(result.selected.length, 'test')} to ${path}`)
}

/**
 * The changes a read-only what-if asks about, or `undefined` for the real tree.
 *
 * A patch is read with the same parser `cbd select --since` uses against git, so
 * the what-if exercises the selector's real input rather than a second, laxer
 * interpretation of a diff. A `--change` is one line range on the old side; its
 * status is a modification, and both sides carry the same range so a widening rule
 * behaves as it does for an edit in place.
 */
function changesFrom(parsed: ParsedArgs): Change[] | undefined {
  if (parsed.patch === undefined && parsed.change === undefined) return undefined
  if (parsed.since !== undefined) {
    throw new UsageError('select takes --since or --patch/--change, not both')
  }

  const changes: Change[] = []
  if (parsed.patch !== undefined) {
    let text: string
    try {
      text = readFileSync(parsed.patch, 'utf8')
    } catch (error) {
      throw new UsageError(`cannot read the patch at ${parsed.patch}: ${String(error)}`)
    }
    for (const change of parseUnifiedDiff(text)) {
      changes.push({
        ...change,
        path: resolve(parsed.root, change.path),
        ...(change.from === undefined ? {} : { from: resolve(parsed.root, change.from) }),
      })
    }
    if (changes.length === 0) {
      throw new UsageError(`the patch at ${parsed.patch} changes no files`)
    }
  }
  if (parsed.change !== undefined) changes.push(changeFrom(parsed.change, parsed.cwd))
  return changes
}

function changeFrom(spec: string, cwd: string): Change {
  // The path may itself contain a colon (a Windows drive, a URL-looking name), so
  // the range is what follows the LAST one.
  const colon = spec.lastIndexOf(':')
  if (colon <= 0) throw new UsageError('--change needs <path>:<start>[-<end>]')
  const file = spec.slice(0, colon)
  const range = spec.slice(colon + 1)
  const match = /^(\d+)(?:-(\d+))?$/.exec(range)
  if (match === null) {
    throw new UsageError(`--change has a malformed line range "${range}"`)
  }
  const start = Number(match[1])
  const end = Number(match[2] ?? match[1])
  if (start < 1 || end < start) {
    throw new UsageError(`--change range must be a positive start <= end, not "${range}"`)
  }
  const line = { start, end }
  return {
    path: resolve(cwd, file),
    status: 'M',
    hunks: [line],
    newHunks: [line],
    insertions: [],
  }
}

function runExplain(cbd: Cbd, parsed: ParsedArgs, io: Io): number {
  const target = parsed.positional[0]
  if (target === undefined) throw new UsageError('explain needs one <file>[:<line>] argument')
  const result: ExplainResult = cbd.explain(target)
  output(parsed, result, explainLines(result, parsed.root), io)
  return EXIT.ok
}

function runReaches(cbd: Cbd, parsed: ParsedArgs, io: Io): number {
  if (parsed.batch !== undefined) return runReachesBatch(cbd, parsed, io)
  const test = parsed.positional[0]
  const target = parsed.positional[1]
  if (test === undefined || target === undefined) {
    throw new UsageError('reaches needs a <test-title> and a <file>[:<line>] argument')
  }
  const result: ReachesResult = cbd.reaches(test, target, {
    ...(parsed.commit === undefined ? {} : { commit: parsed.commit }),
    ...(parsed.file === undefined ? {} : { file: parsed.file }),
  })
  output(parsed, result, reachesLines(result, parsed.root), io)
  return EXIT.ok
}

/** One row of a `reaches --batch` file, as a consumer writes it. */
interface BatchInputRow {
  file: string
  lines?: [number, number]
  find?: string
  killers?: string[]
}

function runReachesBatch(cbd: Cbd, parsed: ParsedArgs, io: Io): number {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(parsed.batch!, 'utf8'))
  } catch (error) {
    throw new UsageError(`cannot read the batch at ${parsed.batch}: ${String(error)}`)
  }
  if (!Array.isArray(raw)) throw new UsageError('the batch must be a JSON array of rows')

  const rows: ReachRow[] = []
  const killers: string[][] = []
  for (const [index, value] of raw.entries()) {
    const row = value as Partial<BatchInputRow> | null
    if (row === null || typeof row !== 'object' || typeof row.file !== 'string') {
      throw new UsageError(`batch row ${String(index)} needs a "file"`)
    }
    if (row.lines !== undefined) {
      const lines = row.lines
      if (
        !Array.isArray(lines) ||
        lines.length !== 2 ||
        !Number.isInteger(lines[0]) ||
        !Number.isInteger(lines[1]) ||
        lines[0] < 1 ||
        lines[1] < lines[0]
      ) {
        throw new UsageError(`batch row ${String(index)} "lines" must be [start, end]`)
      }
      rows.push({ file: row.file, start: lines[0], end: lines[1] })
    } else if (row.find !== undefined) {
      if (typeof row.find !== 'string' || row.find === '') {
        throw new UsageError(`batch row ${String(index)} "find" must be a non-empty string`)
      }
      const file = resolve(parsed.root, row.file)
      let text: string
      try {
        text = readFileSync(file, 'utf8')
      } catch (error) {
        throw new UsageError(`batch row ${String(index)} cannot read ${row.file}: ${String(error)}`)
      }
      const at = text.indexOf(row.find)
      if (at < 0) throw new UsageError(`batch row ${String(index)}: find text is not in ${row.file}`)
      // 1-based line of the first character, and the line its last character is on.
      const start = text.slice(0, at).split('\n').length
      const end = start + (row.find.match(/\n/g)?.length ?? 0)
      rows.push({ file: row.file, start, end })
    } else {
      throw new UsageError(`batch row ${String(index)} needs "lines" or "find"`)
    }
    if (row.killers !== undefined) {
      if (!Array.isArray(row.killers) || row.killers.some((k) => typeof k !== 'string')) {
        throw new UsageError(`batch row ${String(index)} "killers" must be string[]`)
      }
      killers.push(row.killers)
    } else {
      killers.push([])
    }
  }

  const results = cbd
    .reachesRows(rows, parsed.commit === undefined ? {} : { commit: parsed.commit })
    .map((row, index) => ({
      ...row,
      killers: killers[index]!.map((title) => ({
        title,
        reaches: row.tests.some((test) => test.title === title),
      })),
    }))
  const value = { results }
  output(parsed, value, batchLines(results, parsed.root), io)
  return EXIT.ok
}

function runStats(cbd: Cbd, parsed: ParsedArgs, io: Io): number {
  const result: StatsResult = cbd.stats(
    parsed.commit === undefined ? {} : { commit: parsed.commit },
  )
  output(parsed, result, statsLines(result, parsed.root), io)
  return EXIT.ok
}

function runGc(config: CbdConfig, parsed: ParsedArgs, io: Io): number {
  const result: GcResult = gc({
    root: config.root,
    ...(config.stateDir === undefined ? {} : { stateDir: config.stateDir }),
    ...(config.mapsDir === undefined ? {} : { mapsDir: config.mapsDir }),
    keep: parsed.keep ?? DEFAULT_KEEP,
  })
  output(parsed, result, gcLines(result), io)
  return EXIT.ok
}

function runCollect(
  cbd: Cbd,
  config: CbdConfig,
  parsed: ParsedArgs,
  options: RunOptions,
): number {
  return collect({
    cbd,
    config,
    root: parsed.root,
    cwd: options.cwd,
    commit: headCommit(parsed.root),
    exec: parsed.exec,
    select: parsed.select,
    build: parsed.build,
    incremental: parsed.incremental,
    ...(parsed.base === undefined ? {} : { base: parsed.base }),
    ...(parsed.shard === undefined ? {} : { shard: parsed.shard }),
    out: options.out,
    err: options.err,
  })
}

/**
 * Runs one command and answers its exit code.
 *
 * Errors are caught here rather than allowed to escape: a stack trace is useful
 * while developing CBD and useless to someone whose map is missing, and the one
 * thing a CLI must never do is leave a script guessing whether `mode: all` meant
 * "run everything" or "the tool broke".
 */
export function run(argv: string[], options: RunOptions): number {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv, options.cwd)
  } catch (error) {
    options.err(said((error as Error).message))
    return EXIT.usage
  }

  if (parsed.command === 'help') {
    for (const line of HELP.split('\n')) options.out(line)
    return EXIT.ok
  }
  if (parsed.command === 'version') return runVersion(parsed, options)

  try {
    const config = configFor(parsed)
    const cbd = createCbd(config)
    switch (parsed.command) {
      case 'build':
        return runBuild(cbd, parsed, options)
      case 'select':
        return runSelect(cbd, parsed, options)
      case 'explain':
        return runExplain(cbd, parsed, options)
      case 'reaches':
        return runReaches(cbd, parsed, options)
      case 'stats':
        return runStats(cbd, parsed, options)
      case 'collect':
        return runCollect(cbd, config, parsed, options)
      case 'gc':
        return runGc(config, parsed, options)
    }
  } catch (error) {
    options.err(said((error as Error).message))
    // A `UsageError` is a malformed command wherever it is raised. Validation
    // that needs a map (mutually exclusive flags, a bad --change spec) happens
    // after `parseArgs`, and must still be exit 2 rather than "the tool broke".
    return error instanceof UsageError ? EXIT.usage : EXIT.error
  }
}
