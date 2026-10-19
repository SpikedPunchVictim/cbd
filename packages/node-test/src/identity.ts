/**
 * The pure decisions the register module and its hooks need.
 *
 * Structural shapes rather than `@types/node`'s `TestContext`: a Node upgrade must
 * fail a test in this file, not the package's compile, and the adapter contract is
 * data rather than a version of someone else's interface.
 */
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'

export interface NodeTestContextLike {
  /** The test's own name, without its enclosing suites. */
  name?: string
  /** `outer > inner > adds`, the same spelling CBD stores (`t.fullName`). */
  fullName?: string
  /** The absolute path of the file that registered the test. */
  filePath?: string
  /** Set by the runner once the test has run; `false` means it failed. */
  passed?: boolean
  error?: unknown
  /** Called from inside a test body to mark it skipped. */
  skip?: (...args: unknown[]) => unknown
  /** Called from inside a test body to mark it todo. */
  todo?: (...args: unknown[]) => unknown
}

/**
 * The title CBD records and selects by.
 *
 * `fullName` is the suite path plus the test name joined by ` > `, which is what
 * the other adapters record; a bare `name` would collapse two same-named tests in
 * different suites of one file into a single map entry whose coverage and failures
 * conflate. `fullName` exists from Node 20.16 / 22.8; on older Node the fallback
 * keeps the run recordable but the caller is warned.
 */
export function titleOf(context: NodeTestContextLike | undefined): string | null {
  if (context === undefined) return null
  if (typeof context.fullName === 'string' && context.fullName !== '') return context.fullName
  return typeof context.name === 'string' && context.name !== '' ? context.name : null
}

/** The test file, as the runner reports it. */
export function fileOf(context: NodeTestContextLike | undefined): string | null {
  const file = context?.filePath
  return typeof file === 'string' && file !== '' ? file : null
}

/**
 * A test's outcome.
 *
 * The runner sets `passed` only after the body has run: `true` for a pass, `false`
 * for a failure. Anything else is treated as failed, not passed — a green window is
 * the one outcome that under-selects if it was wrong. A test that skipped itself
 * from inside its body (`t.skip()`) still reports `passed: true`, so the register
 * module tracks that call and passes `skipped` here.
 */
export function statusOf(
  context: NodeTestContextLike | undefined,
  skipped = false,
): 'passed' | 'failed' | 'skipped' {
  if (skipped) return 'skipped'
  return context?.passed === true ? 'passed' : 'failed'
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

const escapePart = (part: string): string => part.replace(REGEX_SPECIALS, '\\$&')

/**
 * The `--test-name-pattern` for `CBD_SELECTION`.
 *
 * The pattern is matched by `node:test` against the full name with its parts
 * joined by **single spaces** — `outer > inner > adds` is `outer inner adds` —
 * which is not the spelling CBD stores. Each part is escaped; an anchored
 * alternation keeps `adds` from also matching `adds twice`.
 */
export function selectionPattern(titles: string[]): string {
  const alternatives = titles.map((title) => title.split(' > ').map(escapePart).join(' '))
  return `^(?:${alternatives.join('|')})$`
}

/**
 * The `--test-name-pattern` already present in the process arguments, if any.
 *
 * The flag accepts both `--test-name-pattern=value` and a separate value. The
 * register module re-executes the test file with its own flag when the selection
 * names one, so it must be able to tell an existing pattern (the user's, or its
 * own from the re-executed process) from the absence of one.
 */
export function existingPattern(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) continue
    if (arg.startsWith('--test-name-pattern=')) return arg.slice('--test-name-pattern='.length)
    if (arg === '--test-name-pattern') return argv[index + 1]
  }
  return undefined
}

/**
 * One shard per test file.
 *
 * `node:test` runs each file in its own child process by default, so this is the
 * natural end of a recorder: the footer is written in the file's `after` hook. Two
 * files in one worker would need two shards, never two headers in one; a child
 * killed mid-file leaves a shard without a footer, which the parser refuses.
 */
export function shardPathFor(base: string, file: string): string {
  const extension = extname(base) === '' ? '.ndjson' : extname(base)
  const stem = basename(base, extension)
  const safe = basename(file)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  const hash = createHash('sha1').update(file).digest('hex').slice(0, 8)
  const leaf = safe === '' ? hash : `${safe}.${hash}`
  return join(dirname(base), `${stem}.${leaf}${extension}`)
}
