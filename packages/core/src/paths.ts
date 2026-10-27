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
import nodePath, { basename, dirname, join, resolve } from 'node:path'

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

/**
 * `root` relative to `top`, spelled the way git spells paths: always with `/`.
 *
 * `git status` prints forward slashes on every platform, so a prefix built from
 * `path.relative` on Windows (`pkg\\app`) would never match its lines.
 */
export function gitRelative(top: string, root: string, pathModule: typeof nodePath = nodePath): string {
  return pathModule.relative(top, root).split(pathModule.sep).join('/')
}
