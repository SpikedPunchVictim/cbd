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
import {
  createCbd,
  headCommit,
  loadConfig,
  loadConfigFile,
  type BuildResult,
  type Cbd,
  type CbdConfig,
  type ExplainResult,
  type ReachesResult,
  type SelectResult,
  type StatsResult,
} from '@spikedpunch/cbd'
import { UsageError, parseArgs, type ParsedArgs } from './args.js'
import { collect } from './collect.js'
import { EXIT } from './exit.js'
import { DEFAULT_KEEP, gc, type GcResult } from './gc.js'
import {
  buildLines,
  explainLines,
  gcLines,
  reachesLines,
  renderJson,
  selectLines,
  statsLines,
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
  cbd build   [--commit <sha>] [--partial] [--root <dir>] [--format json]
  cbd select  [--since <ref>] [--no-worktree] [--strict] [--commit <sha>]
  cbd explain <file>[:<line>] [--root <dir>] [--format json]
  cbd reaches <test-title> <file>[:<line>] [--file <test-file>] [--format json]
  cbd stats   [--commit <sha>] [--root <dir>] [--format json]
  cbd collect [--no-select] [--no-build] [--shard <path>] -- <test command>
  cbd gc      [--keep <n>] [--root <dir>] [--format json]

select exits 0 when it selected a subset and 3 when the answer is "run all",
so a script can branch without parsing output. Failures exit 1; bad arguments 2.

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

The repository is the working directory unless --root names another. The config
is <root>/cbd.config.json unless --config names another; a missing default config
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

function runBuild(cbd: Cbd, parsed: ParsedArgs, io: Io): number {
  const result: BuildResult = cbd.build({
    ...(parsed.commit === undefined ? {} : { commit: parsed.commit }),
    ...(parsed.partial ? { partial: true } : {}),
  })
  output(parsed, result, buildLines(result, parsed.root), io)
  return EXIT.ok
}

function runSelect(cbd: Cbd, parsed: ParsedArgs, io: Io): number {
  const result: SelectResult = cbd.select({
    ...(parsed.since === undefined ? {} : { since: parsed.since }),
    ...(parsed.commit === undefined ? {} : { commit: parsed.commit }),
    worktree: parsed.worktree,
    strict: parsed.strict,
  })
  for (const warning of result.selection.warnings) io.err(`cbd: warning: ${warning}`)
  output(parsed, result, selectLines(result, parsed.root), io)
  return result.selection.mode === 'all' ? EXIT.all : EXIT.ok
}

function runExplain(cbd: Cbd, parsed: ParsedArgs, io: Io): number {
  const target = parsed.positional[0]
  if (target === undefined) throw new UsageError('explain needs one <file>[:<line>] argument')
  const result: ExplainResult = cbd.explain(target)
  output(parsed, result, explainLines(result, parsed.root), io)
  return EXIT.ok
}

function runReaches(cbd: Cbd, parsed: ParsedArgs, io: Io): number {
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
    return EXIT.error
  }
}
