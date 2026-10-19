/**
 * The small pure decisions the setup file needs, separated so they can be read and
 * tested without a Vitest run.
 *
 * Vitest hands a hook a `Task`; the adapter reads three things from it and nothing
 * else. The shapes here are structural rather than imported from Vitest's own
 * types, because a runner upgrade must be a test failure in this file — not a
 * compile error in the package — and because the adapter contract is data, not a
 * version of someone else's interface.
 */
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'

export interface VitestSuiteLike {
  name?: string
  suite?: VitestSuiteLike
}

export interface VitestTaskLike {
  name?: string
  /**
   * Suite path + test name, without the file (`outer > inner > adds`). Vitest 4+
   * reports it; Vitest 3 does not, and the suite chain is walked instead.
   */
  fullTestName?: string
  suite?: VitestSuiteLike
  mode?: string
  file?: { filepath?: string; name?: string }
  result?: { state?: string }
}

/**
 * The title CBD records and selects by.
 *
 * The **full** name, not the bare one: Vitest, like japa, allows the same test name
 * in two `describe` blocks of one file, and a bare title would collapse them into
 * one map entry whose coverage and failures are conflated. The file is carried
 * separately, so the full name omits it.
 */
export function titleOf(task: VitestTaskLike | undefined): string | null {
  if (task === undefined) return null
  if (typeof task.fullTestName === 'string' && task.fullTestName !== '') return task.fullTestName

  // Vitest 3 has no `fullTestName`; the suite chain is the same information. A
  // bare name would collapse two same-named tests in one file into one map entry,
  // whose coverage and failures are then conflated (`cbd-xnp.1`, found on a real
  // Directus SDK run: 82 tests became 77 entries).
  const parts: string[] = []
  for (let suite = task.suite; suite !== undefined; suite = suite.suite) {
    if (typeof suite.name === 'string' && suite.name !== '') parts.unshift(suite.name)
  }
  if (typeof task.name === 'string' && task.name !== '') parts.push(task.name)
  return parts.length === 0 ? null : parts.join(' > ')
}

/** The absolute path of the test file, as Vitest reports it (`file.filepath`). */
export function fileOf(task: VitestTaskLike | undefined): string | null {
  const filepath = task?.file?.filepath
  if (typeof filepath === 'string' && filepath !== '') return filepath
  const name = task?.file?.name
  return typeof name === 'string' && name !== '' ? name : null
}

/**
 * A test's outcome.
 *
 * Unknown means failed, not passed: a window whose status the adapter could not
 * read is not a window the map may trust, and a green window is the one outcome
 * that under-selects if it was wrong.
 */
export function statusOf(state: string | undefined): 'passed' | 'failed' | 'skipped' {
  if (state === 'pass') return 'passed'
  if (state === 'skip') return 'skipped'
  return 'failed'
}

/**
 * The shard for one test file.
 *
 * One shard per file rather than one per run: the setup file executes once per test
 * file, and a single shard appended by several executions would carry several
 * headers and footers, which the parser has no way to read as one run. It also
 * means a worker killed mid-file leaves a shard with no footer — refused, which is
 * the truth about a partial file — instead of corrupting the whole run's artifact.
 *
 * The name is derived from the file rather than the worker so it is stable and
 * legible; the hash keeps two files with the same basename apart.
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
