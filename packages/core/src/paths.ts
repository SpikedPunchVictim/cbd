/**
 * One spelling for a path that may not exist yet.
 *
 * The map's keys are realpaths (the build canonicalizes its root), so a path a test
 * reports has to be canonical too, or a symlinked checkout answers "outside the
 * root" for a file under it. A path that does not exist cannot be realpath'd — the
 * `existsSync`-asserts-absence case, where a later creation of the file must still
 * select the test that asserted it — so the nearest resolvable ancestor is
 * canonicalized and the missing tail re-appended.
 *
 * **Only `realpathSync` is used here on purpose.** This runs inside the read
 * tracker's own patched `fs` surface, and `existsSync` is one of the calls it
 * records: probing with it re-entered the tracker without end.
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export function canonicalPath(path: string): string {
  const absolute = resolve(path)
  let current = absolute
  const tail: string[] = []
  for (;;) {
    try {
      return join(realpathSync(current), ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      tail.unshift(basename(current))
      current = parent
    }
  }
}
