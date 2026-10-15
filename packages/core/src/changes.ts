/**
 * What changed between the map's commit and the worktree.
 *
 * **Hunk coordinates are OLD-side line numbers, and that is load-bearing.**
 * The map's function ranges were measured at the map's commit. Worktree-side
 * numbers are shifted by every hunk above them, so with three hunks in a file the
 * offsets accumulate and a hunk lands in the *following* function's range. A
 * change to `parse` would then select the callers of the function below it —
 * under-selection, silent, and the one failure mode that is not merely wasteful.
 *
 * Every other range error falls through to the file-level rule, which
 * over-selects and is safe. This one does not.
 */
import { execFileSync } from 'node:child_process'

export interface LineRange {
  /** 1-based, inclusive, in the MAP COMMIT's coordinates. */
  start: number
  end: number
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T'

export interface Change {
  path: string
  status: ChangeStatus
  /** For renames and copies: the path it came from. */
  from?: string
  hunks: LineRange[]
}

export interface ChangesOptions {
  root: string
  since: string
  /** Compare against the working tree (default) or against HEAD. */
  worktree?: boolean
  /** Run git for real, or return nothing. Injected so tests need no repository. */
  exec?: (args: string[]) => string
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * The paths on a `diff --git a/X b/Y` line.
 *
 * Needed because a change with no content — a mode change, an empty commit's
 * file, a pure rename — emits no `---`/`+++` lines at all, so the header is the
 * only place its path appears. Quoted paths (git quotes anything unusual) are
 * left to the `---`/`+++` lines rather than parsed wrongly here.
 */
function pathsFromHeader(line: string): { oldPath?: string; path?: string } {
  const rest = line.slice('diff --git '.length)
  if (rest.startsWith('"')) return {}
  const boundary = rest.indexOf(' b/')
  if (!rest.startsWith('a/') || boundary === -1) return {}
  return { oldPath: rest.slice(2, boundary), path: rest.slice(boundary + 3) }
}

function defaultExec(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/**
 * Parses `git diff -U0` output into per-file changes.
 *
 * One pass rather than `--name-status` plus a separate diff: the unified format
 * already carries status (`new file mode`, `deleted file mode`), renames
 * (`rename from`/`rename to`) and the hunk headers, and joining two calls by path
 * is exactly where a rename would go wrong.
 */
export function parseUnifiedDiff(diff: string): Change[] {
  const changes: Change[] = []
  let current: Change | null = null

  const finish = (): void => {
    if (current !== null) {
      // The header names both sides for every file, so `from` is only a rename
      // when the two actually differ.
      if (current.from === current.path) delete current.from
      changes.push(current)
    }
    current = null
  }

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish()
      const { oldPath, path } = pathsFromHeader(line)
      current = { path: path ?? '', status: 'M', hunks: [] }
      if (oldPath !== undefined) current.from = oldPath
      continue
    }
    if (current === null) continue

    if (line.startsWith('new file mode')) {
      current.status = 'A'
    } else if (line.startsWith('deleted file mode')) {
      current.status = 'D'
    } else if (line.startsWith('rename from ')) {
      current.from = line.slice('rename from '.length)
      current.status = 'R'
    } else if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length)
    } else if (line.startsWith('copy from ')) {
      current.from = line.slice('copy from '.length)
      current.status = 'C'
    } else if (line.startsWith('copy to ')) {
      current.path = line.slice('copy to '.length)
    } else if (line.startsWith('--- ')) {
      const path = line.slice(4)
      if (current.path === '' && path !== '/dev/null') {
        current.path = path.replace(/^a\//, '')
      }
    } else if (line.startsWith('+++ ')) {
      const path = line.slice(4)
      if (path !== '/dev/null') current.path = path.replace(/^b\//, '')
    } else {
      const hunk = HUNK.exec(line)
      if (hunk !== null) {
        const oldStart = Number(hunk[1])
        // With -U0 the count is omitted when it is 1.
        const oldLines = hunk[2] === undefined ? 1 : Number(hunk[2])
        if (oldLines > 0) {
          current.hunks.push({ start: oldStart, end: oldStart + oldLines - 1 })
        }
      }
    }
  }
  finish()
  return changes.filter((change) => change.path !== '')
}

export function changesSince(options: ChangesOptions): Change[] {
  const exec = options.exec ?? ((args: string[]) => defaultExec(options.root, args))
  const args = ['diff', '--unified=0', '--find-renames', '--no-color', '--no-ext-diff', options.since]
  if (options.worktree === false) args.splice(1, 0, 'HEAD')
  try {
    return parseUnifiedDiff(exec(args))
  } catch (error) {
    throw new Error(
      `changesSince: git diff from ${options.since} failed in ${options.root}: ${String(error)}`,
    )
  }
}

export function intersects(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end
}

/** Whether two ranges refer to the same code. */
export function sameCommit(repoRoot: string, a: string, b: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', `${a}^{commit}`, `${b}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    const [left, right] = out.trim().split('\n')
    return left === right
  } catch {
    return false
  }
}
