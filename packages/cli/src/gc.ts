/**
 * `cbd gc` — keep the newest runs, remove the rest.
 *
 * Two pools under the state directory, pruned independently:
 *
 *   `<state>/shards/*`   the recordings of runs — ~50 MB on a real suite, and the
 *                        reason a retention policy exists at all. A run can write
 *                        many files (one per test file for Jest, Vitest and
 *                        node:test), so they are grouped by run and kept or removed
 *                        whole;
 *   `<state>/maps/<c>`   one merged map per commit, small but unbounded.
 *
 * `--keep <n>` keeps the newest `n` runs of the shard pool and the newest `n` maps,
 * by mtime (a run's age is its newest file's). The map `select` would use is kept
 * even when it is older than that, because deleting the map the next command
 * depends on turns a working repository into one that fails — the same reason
 * `collect` never hands the build a half-written map.
 *
 * **Deliberately narrow.** Only regular files directly in `shards/` and directories
 * directly in `maps/` that are named like a commit and hold a `map.json` are
 * candidates. Anything else a person puts in `.cbd` — a config, a scratch file, a
 * nested directory — is not this command's to delete, and a missing state directory
 * is an empty pool rather than an error.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mapDir, nearestMapCommit } from '@spikedpunch/cbd'
import { realpath } from '@spikedpunch/cbd/adapter'

/** Runs kept of each kind unless `--keep` names another count. */
export const DEFAULT_KEEP = 10

export interface GcOptions {
  /** Repository root. Relative state paths, including a relative `mapsDir`, resolve here. */
  root: string
  /** Relative to `root`; `.cbd` unless the config says otherwise. */
  stateDir?: string
  /**
   * Where per-commit maps live instead of `<stateDir>/maps`; resolved against
   * `root`, and absolute paths are allowed.
   *
   * A shared, absolute directory is pruned with the same policy as a local one, so
   * it can remove a map another checkout would have used. Name a `--keep` large
   * enough for every worktree sharing it, or run `gc` from one owner of the
   * directory.
   */
  mapsDir?: string
  /** Newest runs kept of each kind. At least 1. */
  keep: number
}

export interface GcResult {
  /** The requested count, echoed so a JSON reader need not infer the policy. */
  keep: number
  shards: { kept: number; removed: number }
  maps: { kept: number; removed: number }
  /** Bytes reclaimed, measured before deletion. */
  bytes: number
}

interface Candidate {
  /** The pool entry's identity: the directory for a map, the run's key for shards. */
  key: string
  /** Everything removed with this entry. One path for a map, every shard file of a run. */
  paths: string[]
  mtimeMs: number
}

/** A full commit id, SHA-1 or SHA-256 — the only names `mapDir` ever creates. */
const COMMIT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function listDir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

// Another gc, or a collect pruning the same directory, can remove an entry between
// the listing and the stat. One that is gone is not a candidate, and is not a
// reason to abort the whole prune.
function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

/** Newest first; the key breaks a tie so same-millisecond entries prune in a stable order. */
function newestFirst(pool: Candidate[]): Candidate[] {
  return pool.sort((a, b) =>
    a.mtimeMs === b.mtimeMs ? (a.key < b.key ? 1 : -1) : b.mtimeMs - a.mtimeMs,
  )
}

/**
 * Map directories that may be pruned.
 *
 * `mapsDir` is user-configurable and can name a directory that holds other things
 * (`.` is the repository itself), so a directory is a candidate only if it is named
 * like a commit and holds a `map.json`. This is what keeps gc from being `rm -rf`.
 */
function mapCandidates(dir: string): Candidate[] {
  const out: Candidate[] = []
  for (const entry of listDir(dir)) {
    if (!entry.isDirectory() || !COMMIT_NAME.test(entry.name)) continue
    const path = join(dir, entry.name)
    if (!existsSync(join(path, 'map.json'))) continue
    const mtimeMs = mtimeOf(path)
    if (mtimeMs !== undefined) out.push({ key: path, paths: [path], mtimeMs })
  }
  return newestFirst(out)
}

/**
 * The run a shard belongs to: its name up to the first dot.
 *
 * Adapters derive per-file and service shards beside the run's base name,
 * `<stem>.<leaf>.ndjson` (Jest, Vitest and node:test write one per test file), and
 * `collect` names the base `collect-<time>-<pid>.ndjson`. Pruning by file would
 * keep a fraction of the newest run, and the next build would miss the tests whose
 * shards were cut.
 */
function runOf(name: string): string {
  const dot = name.indexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

/**
 * Shard files grouped by run, each group aged by its newest file. Only regular
 * files directly in `shards/` are candidates; anything nested is left alone.
 */
function shardCandidates(dir: string): Candidate[] {
  const groups = new Map<string, Candidate>()
  for (const entry of listDir(dir)) {
    if (!entry.isFile()) continue
    const path = join(dir, entry.name)
    const mtimeMs = mtimeOf(path)
    if (mtimeMs === undefined) continue
    const key = join(dir, runOf(entry.name))
    const group = groups.get(key)
    if (group === undefined) groups.set(key, { key, paths: [path], mtimeMs })
    else {
      group.paths.push(path)
      group.mtimeMs = Math.max(group.mtimeMs, mtimeMs)
    }
  }
  return newestFirst([...groups.values()])
}

function sizeOf(path: string): number {
  const stats = statSync(path)
  if (!stats.isDirectory()) return stats.size
  let bytes = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    bytes += sizeOf(join(path, entry.name))
  }
  return bytes
}

/**
 * Removes every candidate not in `keep`, and answers the counts.
 *
 * The keep set is the newest `n` plus `essential`, if the caller named one; the
 * essential entry is not counted twice when it is already among the newest.
 */
function prune(
  pool: Candidate[],
  keep: number,
  essential: string | undefined,
): { kept: number; removed: number; bytes: number } {
  const keepSet = new Set(pool.slice(0, keep).map((entry) => entry.key))
  if (essential !== undefined) keepSet.add(essential)

  let kept = 0
  let removed = 0
  let bytes = 0
  for (const entry of pool) {
    if (keepSet.has(entry.key)) {
      kept += entry.paths.length
      continue
    }
    for (const path of entry.paths) {
      try {
        bytes += sizeOf(path)
      } catch {
        // Removed by a concurrent run between the listing and here.
      }
      rmSync(path, { recursive: true, force: true })
      removed += 1
    }
  }
  return { kept, removed, bytes }
}

export function gc(options: GcOptions): GcResult {
  if (!Number.isInteger(options.keep) || options.keep < 1) {
    throw new Error(`cbd: gc keeps at least one run, not ${String(options.keep)}`)
  }
  // Canonical, because `nearestMapCommit` canonicalizes too; two spellings of the
  // same directory would make the essential-map set miss the map it just found.
  const root = realpath(options.root)
  const stateDir = options.stateDir ?? '.cbd'
  const shards = prune(shardCandidates(join(root, stateDir, 'shards')), options.keep, undefined)

  // `select` reads the nearest map in the commit history, which is not
  // necessarily the newest one built — a recorded commit can sit under newer
  // maps from another branch. Keep it so gc cannot strand the next selection.
  const current = nearestMapCommit(root, stateDir, options.mapsDir)
  const essential = current === undefined ? undefined : mapDir(root, current, stateDir, options.mapsDir)
  // Resolved the same way `mapDir` resolves it: a relative `mapsDir` in the config
  // is rooted at the repository, not at whatever directory `cbd` was invoked from.
  const mapsRoot =
    options.mapsDir === undefined ? join(root, stateDir, 'maps') : resolve(root, options.mapsDir)
  const maps = prune(
    mapCandidates(mapsRoot),
    options.keep,
    essential !== undefined && existsSync(essential) ? essential : undefined,
  )

  return {
    keep: options.keep,
    shards: { kept: shards.kept, removed: shards.removed },
    maps: { kept: maps.kept, removed: maps.removed },
    bytes: shards.bytes + maps.bytes,
  }
}
