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
import { resolve } from 'node:path'

export type Command =
  | 'build'
  | 'select'
  | 'explain'
  | 'reaches'
  | 'stats'
  | 'collect'
  | 'gc'
  | 'help'

export type Format = 'text' | 'json'

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
  /** `reaches`: disambiguates a bare test title that occurs in more than one file. */
  file?: string
  /** `gc`: newest runs kept of each kind. */
  keep?: number
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
])

const BOOLEAN_FLAGS = new Set(['help', 'partial', 'worktree', 'strict', 'select', 'build'])

/** Global flags every command accepts; the rest are per command. */
const GLOBAL = new Set(['root', 'config', 'format', 'help'])

const ALLOWED: Record<Command, readonly string[]> = {
  build: ['commit', 'partial'],
  select: ['since', 'worktree', 'strict', 'commit'],
  explain: [],
  reaches: ['commit', 'file'],
  stats: ['commit'],
  collect: ['select', 'build', 'shard'],
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
  positional: string[]
  exec: string[]
} {
  const flags = new Map<string, FlagValue>()
  const positional: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    // Everything after `--` is the test command, not this parser's business: a
    // runner's own flags look exactly like ours (`--filter`, `--reporter`), and
    // parsing them here would reject the command a user meant to run.
    if (arg === '--') return { flags, positional, exec: argv.slice(index + 1) }
    if (arg.startsWith('-')) index = takeFlag(argv, index, flags)
    else positional.push(arg)
  }

  return { flags, positional, exec: [] }
}

/**
 * Reads the flag at `index`, sets it, and answers the index of its last token.
 *
 * `--no-x` is how a default-true switch says "off"; `--x` itself stays accepted so
 * a script can spell the default. Both forms go through the same boolean check, so
 * a command cannot end up with one of them and not the other.
 */
function takeFlag(argv: string[], index: number, flags: Map<string, FlagValue>): number {
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
  flags.set(name, value)
  return inline === undefined ? index + 1 : index
}

function commandOf(flags: Map<string, FlagValue>, positional: string[]): Command {
  if (flags.get('help') === true) return 'help'
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
      throw new UsageError(`"cbd ${command}" does not take --${name}`)
    }
  }
}

function checkPositional(command: Command, positional: string[], exec: string[]): void {
  if (command === 'help') return
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
    if (positional.length !== 2) {
      throw new UsageError('reaches needs a <test-title> and a <file>[:<line>] argument')
    }
    return
  }
  if (positional.length > 0) throw new UsageError(`unexpected argument "${positional[0]}"`)
}

function formatOf(flags: Map<string, FlagValue>): Format {
  const value = flags.get('format') ?? 'text'
  if (value !== 'text' && value !== 'json') {
    throw new UsageError(`--format must be "text" or "json", not "${String(value)}"`)
  }
  return value
}

const stringOf = (flags: Map<string, FlagValue>, name: string): string | undefined => {
  const value = flags.get(name)
  return typeof value === 'string' ? value : undefined
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
  const { flags, positional, exec } = takeFlags(argv)
  const command = commandOf(flags, positional)
  checkAllowed(command, flags)
  checkPositional(command, positional, exec)

  const config = stringOf(flags, 'config')
  const commit = stringOf(flags, 'commit')
  const since = stringOf(flags, 'since')
  const shard = stringOf(flags, 'shard')
  const file = stringOf(flags, 'file')
  const keep = positiveIntOf(flags, 'keep')
  return {
    command,
    format: formatOf(flags),
    root: resolve(cwd, stringOf(flags, 'root') ?? '.'),
    ...(config === undefined ? {} : { config: resolve(cwd, config) }),
    ...(commit === undefined ? {} : { commit }),
    ...(since === undefined ? {} : { since }),
    ...(shard === undefined ? {} : { shard: resolve(cwd, shard) }),
    ...(file === undefined ? {} : { file }),
    ...(keep === undefined ? {} : { keep }),
    partial: flags.get('partial') === true,
    // The factory diffs the worktree by default; `--no-worktree` is the HEAD side.
    worktree: flags.get('worktree') !== false,
    strict: flags.get('strict') === true,
    // Both default on: an automatic run selects, and a collecting run builds.
    select: flags.get('select') !== false,
    build: flags.get('build') !== false,
    exec,
    positional,
  }
}
