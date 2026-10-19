/**
 * The pure decisions the Jest environment and the selection setup need.
 *
 * Structural shapes, not `@types/jest`: a Jest upgrade must fail a test in this
 * file, not the package's compile, and the adapter contract is data rather than a
 * version of someone else's interface.
 */
import { createHash } from 'node:crypto'
import { basename, dirname, extname, join } from 'node:path'

export interface JestTestLike {
  name?: string
  mode?: string
  /** Populated only for a failure; a `test.failing` that throws has none. */
  errors?: unknown[]
  parent?: JestTestLike
}

/** Jest's synthetic root block, which is not a suite a user wrote. */
const ROOT_BLOCK = 'ROOT_DESCRIBE_BLOCK'

/**
 * The title CBD records and selects by: the enclosing `describe` names plus the
 * test's own, joined by ` > `, with Jest's synthetic root omitted.
 *
 * The suite path rather than the bare name, for the same reason the Vitest adapter
 * uses the full name: two same-named tests in different `describe` blocks of one
 * file must not collapse into one map entry whose coverage and failures conflate.
 */
export function titleOf(test: JestTestLike | undefined): string | null {
  if (test === undefined) return null
  const parts: string[] = []
  for (let parent = test.parent; parent !== undefined; parent = parent.parent) {
    if (typeof parent.name === 'string' && parent.name !== '' && parent.name !== ROOT_BLOCK) {
      parts.unshift(parent.name)
    }
  }
  if (typeof test.name === 'string' && test.name !== '') parts.push(test.name)
  return parts.length === 0 ? null : parts.join(' > ')
}

/**
 * A test's outcome.
 *
 * `mode` is checked first: a skipped or todo test reaches `test_start` with
 * `mode: 'skip'`/`'todo'` and may never reach `test_done`, so trusting the error
 * list alone would call it green. `errors` is the failure signal the Circus test
 * object carries; `test_done`'s `testErrors` is not populated in Jest 30.
 */
export function statusOf(test: JestTestLike | undefined): 'passed' | 'failed' | 'skipped' {
  if (test?.mode === 'skip' || test?.mode === 'todo') return 'skipped'
  if ((test?.errors?.length ?? 0) > 0) return 'failed'
  return 'passed'
}

/**
 * One shard per test file.
 *
 * A Jest environment instance is created per test file, so this is the natural
 * end of a recorder: the footer is written in `teardown`. Two files in one worker
 * get two files, never two headers in one; a worker killed mid-file leaves a shard
 * without a footer, which the parser refuses.
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
