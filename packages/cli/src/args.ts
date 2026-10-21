/**
 * Argument parsing for the commands that read a map.
 *
 * Hand-written rather than taken from a dependency: the grammar is four commands
 * and eight flags, and the one property that matters — an unknown flag is an error,
 * not a silently ignored word — is easier to guarantee here than to configure.
 *
 * The parser produces one shape whatever the command, and `run` reads only the
 * fields that command accepts. Rejecting a flag a command does not take happens
 * here, so `cbd stats --partial` fails as a usage error instead of quietly doing
 * nothing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export type Command =
  | 'build'
  | 'select'
  | 'explain'
  | 'reaches'
  | 'stats'
  | 'collect'
  | 'gc'
  | 'version'
  | 'help'

export type Format = 'text' | 'json' | 'summary'

export interface ParsedArgs {
  command: Command
  format: Format
  /** Absolute. The repository whose map, shards and config are read. */
  root: string
  /** Absolute, when `--config` named one; otherwise `<root>/cbd.config.json`. */
  config?: string
  commit?: string
  since?: string
  partial: boolean
  /** Diff against the working tree (default) or against HEAD. */
  worktree: boolean
  strict: boolean
  /** `collect`: resolve a selection before running. Default true. */
  select: boolean
  /** `collect`: merge the shards into a map afterwards. Default true. */
  build: boolean
  /** `collect`: the shard to write. Defaults under the state directory. */
  shard?: string
  /** `build`/`collect`: carry untouched tests forward from an earlier map. */
  incremental: boolean
  /** The map commit to carry from; defaults to the nearest map. */
  base?: string
  /** `reaches`: disambiguates a bare test title that occurs in more than one file. */
  file?: string
  /** `gc`: newest runs kept of each kind. */
  keep?: number
  /** `reaches`: a JSON file of batch rows, instead of one test and target. Absolute. */
  batch?: string
  /** `select`: write the v2 selection file here. Absolute. */
  emitSelection?: string
  /** `select`: write one v2 selection file per suite here. Absolute. */
  emitSelectionDir?: string
  /** `select`: the suite name and file globs for `--emit-selection-dir`. */
  suites?: Array<{ name: string; globs: string[] }>
  /** `select`: answer for this diff file instead of the worktree. Absolute. */
  patch?: string
  /** `select`: answer for these changed lines, `path:start[-end]`. */
  change?: string
  /** `select`: order the subset so the most directly affected tests run first. */
  order?: 'impact'
  /** The directory the command was invoked from; relative paths resolve here. */
  cwd: string
  /** Everything after `--`: the test command `collect` spawns. */
  exec: string[]
  positional: string[]
}

/** A mistake in how the command was written. Exit code 2, never a stack trace. */
export class UsageError extends Error {}

const COMMANDS = new Set<string>([
  'build',
  'select',
  'explain',
  'reaches',
  'stats',
  'collect',
  'gc',
  'help',
])

const VALUE_FLAGS = new Set([
  'root',
  'config',
  'format',
  'commit',
  'since',
  'shard',
  'keep',
  'file',
  'patch',
  'change',
  'batch',
  'emit-selection',
  'emit-selection-dir',
  'suite',
  'base',
  'order',
])

/** Flags that may be given more than once; each value is kept. */
const REPEATABLE = new Set(['suite'])

const BOOLEAN_FLAGS = new Set([
  'help',
  'version',
  'partial',
  'worktree',
  'strict',
  'select',
  'build',
  'incremental',
])

/** Global flags every command accepts; the rest are per command. */
const GLOBAL = new Set(['root', 'config', 'format', 'help', 'version'])

const ALLOWED: Record<Command, readonly string[]> = {
  version: [],
  build: ['commit', 'partial', 'incremental', 'base'],
  select: ['since', 'worktree', 'strict', 'commit', 'patch', 'change', 'emit-selection', 'emit-selection-dir', 'suite', 'order'],
  explain: [],
  reaches: ['commit', 'file', 'batch'],
  stats: ['commit'],
  collect: ['select', 'build', 'shard', 'incremental', 'base'],
  gc: ['keep'],
  help: [],
}

type FlagValue = string | boolean

/**
 * Walks argv, delegating each token that starts with `-` to `takeFlag`.
 *
 * The loop only decides "flag or positional"; everything about a flag's spelling,
 * whether it takes a value, and which name it sets lives in `takeFlag`, so the two
 * questions stay separate.
 */
function takeFlags(argv: string[]): {
  flags: Map<string, FlagValue>
  repeated: Map<string, string[]>
  positional: string[]
  exec: string[]
} {
  const flags = new Map<string, FlagValue>()
  const repeated = new Map<string, string[]>()
  const positional: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    // Everything after `--` is the test command, not this parser's business: a
    // runner's own flags look exactly like ours (`--filter`, `--reporter`), and
    // parsing them here would reject the command a user meant to run.
    if (arg === '--') return { flags, repeated, positional, exec: argv.slice(index + 1) }
    if (arg.startsWith('-')) index = takeFlag(argv, index, flags, repeated)
    else positional.push(arg)
  }

  return { flags, repeated, positional, exec: [] }
}

/**
 * Reads the flag at `index`, sets it, and answers the index of its last token.
 *
 * `--no-x` is how a default-true switch says "off"; `--x` itself stays accepted so
 * a script can spell the default. Both forms go through the same boolean check, so
 * a command cannot end up with one of them and not the other.
 */
function takeFlag(
  argv: string[],
  index: number,
  flags: Map<string, FlagValue>,
  repeated: Map<string, string[]>,
): number {
  const arg = argv[index]!
  if (arg === '-h') {
    flags.set('help', true)
    return index
  }
  if (!arg.startsWith('--')) throw new UsageError(`unknown flag ${arg}`)

  const body = arg.slice(2)
  const equals = body.indexOf('=')
  const name = equals === -1 ? body : body.slice(0, equals)
  const inline = equals === -1 ? undefined : body.slice(equals + 1)

  const positive = name.startsWith('no-') ? name.slice(3) : name
  if (BOOLEAN_FLAGS.has(positive)) {
    if (inline !== undefined) throw new UsageError(`--${name} does not take a value`)
    flags.set(positive, positive === name)
    return index
  }

  if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown flag --${name}`)
  const value = inline ?? argv[index + 1]
  if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`)
  if (REPEATABLE.has(name)) {
    const list = repeated.get(name) ?? []
    list.push(value)
    repeated.set(name, list)
  }
  flags.set(name, value)
  return inline === undefined ? index + 1 : index
}

/** Whether `dir` is `ceiling` or below it. */
function atOrBelow(dir: string, ceiling: string): boolean {
  const rel = relative(ceiling, dir)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The nearest ancestor of `cwd` holding `cbd.config.json`, if any.
 *
 * The walk stops at `ceiling` when given. That is the git top level: a config
 * above the repository belongs to a different project, and letting it win made a
 * nested repository answer for its parent's tree — or, with a submodule, run the
 * parent's suite (`cbd-73r.2` follow-up).
 */
function configRoot(cwd: string, ceiling?: string): string | undefined {
  // Canonical, because `git rev-parse --show-toplevel` answers a realpath while
  // `cwd` may be reached through a symlink (`/tmp` on macOS). Comparing the two
  // spellings would stop the walk before the config directory.
  let dir = canonical(cwd)
  for (;;) {
    if (existsSync(join(dir, 'cbd.config.json'))) return dir
    if (ceiling !== undefined && dir === ceiling) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    if (ceiling !== undefined && !atOrBelow(parent, ceiling)) return undefined
    dir = parent
  }
}

function canonical(path: string): string {
  try {
    return realpathSync(resolve(path))
  } catch {
    return resolve(path)
  }
}

/** The git top level, when `cwd` is inside a repository. */
function gitRoot(cwd: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    // Strip the line ending, not whitespace: a repository path may legally end
    // in a space, and trimming it produced a path that does not exist.
    const root = out.replace(/\r?\n$/, '')
    return root === '' ? undefined : root
  } catch {
    return undefined
  }
}

/**
 * Where the repository is, when `--root` does not say.
 *
 * The git top level is the outer boundary: a `cbd.config.json` only marks the
 * project root within it, so a config in a parent repository or a parent
 * directory cannot capture an unrelated checkout. Within the repository the
 * nearest config wins (a monorepo can put one in a package); without one the git
 * top level is the root. Outside git, an upward config search still works, and
 * `cwd` is the last resort. Rooting at `process.cwd()` made `cbd select` from a
 * subdirectory look for `<subdir>/.cbd` and fail (`cbd-73r.2`).
 */
export function defaultRoot(cwd: string): string {
  const git = gitRoot(cwd)
  if (git !== undefined) return configRoot(cwd, git) ?? git
  return configRoot(cwd) ?? canonical(cwd)
}

/**
 * The first token decides help before the version flag does: `cbd help
 * --version` should print help, not reject the pair.
 */
function commandOf(flags: Map<string, FlagValue>, positional: string[]): Command {
  if (flags.get('help') === true) return 'help'
  if (positional[0] === 'help') {
    positional.shift()
    return 'help'
  }
  if (flags.get('version') === true) return 'version'
  const command = positional.shift()
  if (command === undefined) throw new UsageError('missing command (try "cbd --help")')
  if (!COMMANDS.has(command)) throw new UsageError(`unknown command "${command}"`)
  return command as Command
}

function checkAllowed(command: Command, flags: Map<string, FlagValue>): void {
  for (const name of flags.keys()) {
    if (name === 'format' && command === 'collect') {
      throw new UsageError('"cbd collect" does not take --format: the test command shares stdout')
    }
    if (GLOBAL.has(name)) continue
    if (!ALLOWED[command].includes(name)) {
      const form = command === 'version' ? 'cbd --version' : `"cbd ${command}"`
      throw new UsageError(`${form} does not take --${name}`)
    }
  }
}

function checkPositional(
  command: Command,
  positional: string[],
  exec: string[],
  batch: boolean,
): void {
  if (command === 'help') return
  if (command === 'version') {
    if (positional.length > 0 || exec.length > 0) {
      throw new UsageError('--version takes no arguments')
    }
    return
  }
  if (exec.length > 0 && command !== 'collect') {
    throw new UsageError(`unexpected argument "${exec[0]}" (only collect takes "-- <command>")`)
  }
  if (command === 'collect') {
    if (exec.length === 0) {
      throw new UsageError('collect needs a test command after -- (for example "cbd collect -- npm test")')
    }
    if (positional.length > 0) throw new UsageError(`unexpected argument "${positional[0]}"`)
    return
  }
  if (command === 'explain') {
    if (positional.length !== 1) throw new UsageError('explain needs one <file>[:<line>] argument')
    return
  }
  if (command === 'reaches') {
    if (batch) {
      if (positional.length > 0) {
        throw new UsageError('reaches --batch takes no positional arguments')
      }
      return
    }
    if (positional.length !== 2) {
      throw new UsageError('reaches needs a <test-title> and a <file>[:<line>] argument')
    }
    return
  }
  if (positional.length > 0) throw new UsageError(`unexpected argument "${positional[0]}"`)
}

function formatOf(flags: Map<string, FlagValue>, command: Command): Format {
  const value = flags.get('format') ?? 'text'
  if (value !== 'text' && value !== 'json' && value !== 'summary') {
    throw new UsageError(`--format must be "text", "json" or "summary", not "${String(value)}"`)
  }
  // The summary shape answers "how much of the suite is this?"; it is the select
  // answer condensed, not a second rendering every command has to make.
  if (value === 'summary' && command !== 'select') {
    throw new UsageError('--format summary is only for select')
  }
  return value
}

const stringOf = (flags: Map<string, FlagValue>, name: string): string | undefined => {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
}

/**
 * A `--suite` value: `name=glob[,glob...]`.
 *
 * The name becomes a file name in the output directory, so it is restricted to
 * what a path segment can safely carry. `_other` is reserved for selected tests no
 * suite claimed.
 */
function suiteSpec(value: string): { name: string; globs: string[] } {
  const at = value.indexOf('=')
  if (at <= 0) throw new UsageError(`--suite wants <name>=<glob,...>, not "${value}"`)
  const name = value.slice(0, at)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === '_other') {
    throw new UsageError(
      `--suite name "${name}" must be letters, digits, dot, dash or underscore (and not "_other")`,
    )
  }
  const globs = value
    .slice(at + 1)
    .split(',')
    .map((glob) => glob.trim())
    .filter((glob) => glob !== '')
  if (globs.length === 0) throw new UsageError(`--suite "${name}" needs at least one glob`)
  return { name, globs }
}

/**
 * A count that must be at least 1.
 *
 * Zero is refused rather than read as "remove everything": it is the one value a
 * typo produces that deletes the map the next `select` would have used.
 */
function positiveIntOf(flags: Map<string, FlagValue>, name: string): number | undefined {
  const value = stringOf(flags, name)
  if (value === undefined) return undefined
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new UsageError(`--${name} must be a positive integer, not "${value}"`)
  }
  return Number(value)
}

export function parseArgs(argv: string[], cwd: string): ParsedArgs {
  const { flags, repeated, positional, exec } = takeFlags(argv)
  const command = commandOf(flags, positional)
  checkAllowed(command, flags)
  const batch = stringOf(flags, 'batch')
  const emitSelection = stringOf(flags, 'emit-selection')
  const emitSelectionDir = stringOf(flags, 'emit-selection-dir')
  const suites = (repeated.get('suite') ?? []).map(suiteSpec)
  if (suites.length > 0 && emitSelectionDir === undefined) {
    throw new UsageError('--suite needs --emit-selection-dir <dir>')
  }
  if (emitSelectionDir !== undefined && suites.length === 0) {
    throw new UsageError('--emit-selection-dir needs at least one --suite <name>=<glob,...>')
  }
  const base = stringOf(flags, 'base')
  checkPositional(command, positional, exec, batch !== undefined)

  const config = stringOf(flags, 'config')
  const commit = stringOf(flags, 'commit')
  const since = stringOf(flags, 'since')
  const shard = stringOf(flags, 'shard')
  const file = stringOf(flags, 'file')
  const keep = positiveIntOf(flags, 'keep')
  const patch = stringOf(flags, 'patch')
  const change = stringOf(flags, 'change')
  const order = stringOf(flags, 'order')
  if (order !== undefined && order !== 'impact') {
    throw new UsageError('--order accepts only "impact"')
  }
  const explicitRoot = stringOf(flags, 'root')
  // Help and version do not read a map, so they must not spawn git or walk the
  // filesystem to choose a root: a diagnostic command cannot hang on a broken
  // git wrapper or a wedged network path.
  const root =
    command === 'help' || command === 'version'
      ? resolve(cwd)
      : explicitRoot === undefined
        ? defaultRoot(cwd)
        : resolve(cwd, explicitRoot)
  return {
    command,
    format: formatOf(flags, command),
    root,
    ...(config === undefined ? {} : { config: resolve(cwd, config) }),
    ...(commit === undefined ? {} : { commit }),
    ...(since === undefined ? {} : { since }),
    ...(shard === undefined ? {} : { shard: resolve(cwd, shard) }),
    ...(file === undefined ? {} : { file }),
    ...(keep === undefined ? {} : { keep }),
    ...(patch === undefined ? {} : { patch: resolve(cwd, patch) }),
    ...(change === undefined ? {} : { change }),
    ...(order === undefined ? {} : { order }),
    ...(batch === undefined ? {} : { batch: resolve(cwd, batch) }),
    ...(emitSelection === undefined ? {} : { emitSelection: resolve(cwd, emitSelection) }),
    ...(emitSelectionDir === undefined ? {} : { emitSelectionDir: resolve(cwd, emitSelectionDir) }),
    ...(suites.length === 0 ? {} : { suites }),
    ...(base === undefined ? {} : { base }),
    cwd: resolve(cwd),
    partial: flags.get('partial') === true,
    // The factory diffs the worktree by default; `--no-worktree` is the HEAD side.
    worktree: flags.get('worktree') !== false,
    strict: flags.get('strict') === true,
    // Both default on: an automatic run selects, and a collecting run builds.
    select: flags.get('select') !== false,
    build: flags.get('build') !== false,
    incremental: flags.get('incremental') === true,
    exec,
    positional,
  }
}
