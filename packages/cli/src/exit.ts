/**
 * The process exit codes, in one place so the commands and their tests agree.
 *
 * `all` is deliberately not a success code: a script writing `cbd select && run`
 * would otherwise treat "run the whole suite" as a subset answer. It is not an
 * error either, so it gets its own value rather than sharing 1.
 */
export const EXIT = {
  /** The command answered. For `select`, this means a subset. */
  ok: 0,
  /** The command failed: no map, not a repository, an unreadable config. */
  error: 1,
  /** The command was written wrong. */
  usage: 2,
  /** `select`: the honest answer is "run every test". Not an error. */
  all: 3,
} as const
