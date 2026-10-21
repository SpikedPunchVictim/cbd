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
  /**
   * The same hunks on the new side, in the coordinates of the commit the diff
   * ends at. Absent on a caller-built value from before this field existed.
   *
   * The selector never reads these: it matches against a map taken at the OLD
   * side, which is why `hunks` is old-side by contract. A coverage oracle does
   * the opposite (`cbd-1uv`): it asks what the full run at the NEW commit
   * actually executed, and that map is keyed in the new commit's lines. Using
   * old-side numbers there would measure the oracle with the selector's own
   * arithmetic, which is the thing it exists to be independent of.
   */
  newHunks?: LineRange[]
  /**
   * Old-side insertion points: the line after which content was added, `0` for
   * the start of the file.
   *
   * `hunks` cannot carry one. git writes a pure insertion as `@@ -N,0 +M,K @@` —
   * zero old-side lines — and no line range means "between two lines". They were
   * dropped, so a commit that only added a block to a known file looked to
   * `select` like a change with no lines at all: the new code was matched to no
   * function, widened to no file, and selected nothing. Under-selection, silent
   * (`cbd-81h.1`, found by the replay harness).
   *
   * Optional so a caller-built `Change` from before this field stays valid.
   */
  insertions?: number[]
}

export interface ChangesOptions {
  root: string
  since: string
  /**
   * Compare two commits, with `since` as the old side and this as the new one.
   *
   * `select --since` uses this to project a caller's base onto the map's commit:
   * the map's function ranges are measured at its commit, so the change between
   * the base and that commit has to be read on the map's side (`newHunks`). The
   * old-side numbers name lines that have since moved. A two-commit question has
   * no working tree, so no untracked file is part of it.
   */
  to?: string
  /** Compare against the working tree (default) or against HEAD. */
  worktree?: boolean
  /** Run git for real, or return nothing. Injected so tests need no repository. */
  exec?: (args: string[]) => string
}

/**
 * The union of two change sets, by path.
 *
 * `cbd select --since <base>` has two honest views of the same working tree: the
 * diff from the base the caller asked about, and the diff from the map's commit,
 * which is what the recording actually covers. A consumer that called select
 * twice and merged the answers itself lost the warnings of the second call — and
 * had to reimplement this merge. Returning one answer is the point; hunks union,
 * status prefers the modification spelling that keeps every rule available, and a
 * rename survives if either side saw one.
 */
export function mergeChanges(
  a: readonly Change[],
  b: readonly Change[],
): Change[] {
  const byPath = new Map<string, Change>()
  const add = (change: Change): void => {
    const existing = byPath.get(change.path)
    if (existing === undefined) {
      byPath.set(change.path, {
        ...change,
        hunks: [...change.hunks],
        ...(change.newHunks === undefined ? {} : { newHunks: [...change.newHunks] }),
        ...(change.insertions === undefined ? {} : { insertions: [...change.insertions] }),
      })
      return
    }
    existing.hunks = uniqueRanges([...existing.hunks, ...change.hunks])
    const newHunks = [...(existing.newHunks ?? []), ...(change.newHunks ?? [])]
    if (newHunks.length > 0) existing.newHunks = uniqueRanges(newHunks)
    const insertions = [...(existing.insertions ?? []), ...(change.insertions ?? [])]
    if (insertions.length > 0) existing.insertions = [...new Set(insertions)].sort((x, y) => x - y)
    // A deletion on one side and a modification on the other means the file is
    // not simply gone; keeping the modification lets the function rules answer.
    if (existing.status === 'D' && change.status !== 'D') existing.status = change.status
    if (existing.from === undefined && change.from !== undefined) existing.from = change.from
  }
  for (const change of a) add(change)
  for (const change of b) add(change)
  return [...byPath.values()]
}

function uniqueRanges(ranges: LineRange[]): LineRange[] {
  const seen = new Set<string>()
  const sorted: LineRange[] = []
  for (const range of ranges) {
    const key = `${String(range.start)}:${String(range.end)}`
    if (seen.has(key)) continue
    seen.add(key)
    sorted.push({ ...range })
  }
  sorted.sort((x, y) => x.start - y.start || x.end - y.end)
  // The same edit seen from two baselines can describe one region as 1-1 and 1-2;
  // an overlapping or adjacent pair is one region to every rule that reads hunks.
  const merged: LineRange[] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last !== undefined && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push(range)
    }
  }
  return merged
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
 * One `@@` header, in all three coordinate forms the rules and the oracle need.
 *
 * A count is written only when it is not 1, so an absent count means one line.
 * Zero old-side lines is a pure insertion, not an empty range: it is recorded as
 * the point it follows, which is the only place the old side says where it
 * landed (`cbd-81h.1`).
 */
function applyHunk(change: Change, hunk: RegExpExecArray): void {
  const oldStart = Number(hunk[1])
  const oldLines = hunk[2] === undefined ? 1 : Number(hunk[2])
  if (oldLines > 0) {
    change.hunks.push({ start: oldStart, end: oldStart + oldLines - 1 })
  } else {
    change.insertions?.push(oldStart)
  }

  const newStart = Number(hunk[3])
  const newLines = hunk[4] === undefined ? 1 : Number(hunk[4])
  if (newLines > 0) {
    change.newHunks?.push({ start: newStart, end: newStart + newLines - 1 })
  }
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
      current = { path: path ?? '', status: 'M', hunks: [], newHunks: [], insertions: [] }
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
      if (hunk !== null) applyHunk(current, hunk)
    }
  }
  finish()
  return changes.filter((change) => change.path !== '')
}

/**
 * Files git does not track yet.
 *
 * `git diff` never lists them, and a new file is the most common change in a
 * worktree — so a selection that ignored untracked files could answer "nothing
 * changed" while the suite is broken (`cbd-0na.1`). `--exclude-standard` honours
 * `.gitignore`, global excludes and the repository's exclude file, which is what
 * keeps build output and `.cbd` out of the answer.
 *
 * Empty hunks and insertion point 0 mirror a committed addition: there is nothing
 * on the old side to range over. A never-seen file then reaches `unknownPolicy`
 * (all by default); a file the map does know falls through to the whole-file rule.
 * Paths are relative to `root`, the same coordinate `git diff --relative` prints.
 */
function untrackedChanges(exec: (args: string[]) => string, root: string): Change[] {
  let out: string
  try {
    out = exec(['ls-files', '--others', '--exclude-standard'])
  } catch (error) {
    // The diff was readable but the untracked list was not. Answering without it
    // could omit a new file — the most common change in a worktree — and a
    // selection that silently forgets one is exactly the under-selection this
    // function exists to prevent, so refuse rather than guess.
    throw new Error(
      `changesSince: git ls-files --others failed in ${root}: ${String(error)}`,
    )
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((path) => ({ path, status: 'A', hunks: [], insertions: [0] }) as Change)
}

/**
 * `--relative` is what makes a subdirectory root work.
 *
 * `git diff` prints paths relative to the repository root, while the factory
 * resolves them against the root it was given. For a repository root those are the
 * same; for `cbd --root packages/core` they are not, and every change would land at
 * `packages/core/packages/core/…`. Restricting the diff to the current directory is
 * also the right scope for a project root: a change outside it is not this
 * project's to select for.
 *
 * **Untracked files are changes only in worktree mode.** `--no-worktree` asks what
 * a commit changed; a file that is not in the index is not part of that answer.
 * A two-commit question (`to`) has no working tree at all, so it never includes
 * one either.
 */
export function changesSince(options: ChangesOptions): Change[] {
  const exec = options.exec ?? ((args: string[]) => defaultExec(options.root, args))
  const args = [
    'diff',
    '--unified=0',
    '--find-renames',
    '--no-color',
    '--no-ext-diff',
    '--relative',
    options.since,
  ]
  if (options.to !== undefined) args.push(options.to)
  else if (options.worktree === false) args.splice(1, 0, 'HEAD')
  let changes: Change[]
  try {
    changes = parseUnifiedDiff(exec(args))
  } catch (error) {
    const range =
      options.to === undefined
        ? `from ${options.since}`
        : `from ${options.since} to ${options.to}`
    throw new Error(`changesSince: git diff ${range} failed in ${options.root}: ${String(error)}`)
  }
  if (options.to === undefined && options.worktree !== false) {
    const known = new Set(changes.map((change) => change.path))
    for (const change of untrackedChanges(exec, options.root)) {
      if (!known.has(change.path)) changes.push(change)
    }
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function intersects(a: LineRange, b: LineRange): boolean {
  return a.start <= b.end && b.start <= a.end
}

/**
 * How many commits `since` is behind HEAD.
 *
 * The number §8.3 rule 10 compares with `maxAgeCommits`: a map's *age* is commits,
 * not hours, because a quiet week is not a stale map and a busy afternoon can be.
 * An unreadable or unrelated ref answers `0` — the caller already has a map whose
 * commit it trusts, and refusing to select over a failed `rev-list` would be worse
 * than skipping one warning.
 */
export function commitsSince(repoRoot: string, since: string, head = 'HEAD'): number {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${since}..${head}`], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    const count = Number(out.trim())
    return Number.isFinite(count) ? count : 0
  } catch {
    return 0
  }
}

/**
 * The full SHA a ref names — HEAD unless told otherwise.
 *
 * Named separately from `commitsSince` because a shard has to name the commit it
 * was recorded at, and that is the same question `build` asks: which map does this
 * run belong to?
 */
export function headCommit(repoRoot: string, ref = 'HEAD'): string {
  try {
    return execFileSync('git', ['rev-parse', ref], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim()
  } catch (error) {
    throw new Error(
      `cbd: ${repoRoot} is not a git repository (or ${ref} does not exist): ${String(error)}`,
    )
  }
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
