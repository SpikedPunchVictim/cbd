/**
 * `cbd gc` — keep the newest runs, remove the rest.
 *
 * Two pools under the state directory, pruned independently:
 *
 *   `<state>/shards/*`   one raw recording run each — ~50 MB on a real suite,
 *                        and the reason a retention policy exists at all;
 *   `<state>/maps/<c>`   one merged map per commit, small but unbounded.
 *
 * `--keep <n>` keeps the newest `n` of each pool by mtime, so the answer does not
 * depend on how a shard happens to be named. The map `select` would use is kept
 * even when it is older than that, because deleting the map the next command
 * depends on turns a working repository into one that fails — the same reason
 * `collect` never hands the build a half-written map.
 *
 * **Deliberately narrow.** Only regular files directly in `shards/` and
 * directories directly in `maps/` are candidates. Anything else a person puts in
 * `.cbd` — a config, a scratch file, a nested directory — is not this command's
 * to delete, and a missing state directory is an empty pool rather than an error.
 */
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { mapDir, nearestMapCommit } from '@spikedpunch/cbd'

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
  path: string
  mtimeMs: number
}

/**
 * Direct children that may be pruned.
 *
 * `filter` is what keeps this from being `rm -rf`: shards are files, maps are
 * directories, and neither pool accepts anything else.
 */
function candidates(dir: string, kind: 'file' | 'dir'): Candidate[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: Candidate[] = []
  for (const entry of entries) {
    if (!(kind === 'file' ? entry.isFile() : entry.isDirectory())) continue
    const path = join(dir, entry.name)
    out.push({ path, mtimeMs: statSync(path).mtimeMs })
  }
  // Newest first, and the name breaks a tie so two runs recorded in the same
  // millisecond are pruned in a stable order.
  return out.sort((a, b) =>
    a.mtimeMs === b.mtimeMs ? (a.path < b.path ? 1 : -1) : b.mtimeMs - a.mtimeMs,
  )
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
  const keepSet = new Set(pool.slice(0, keep).map((entry) => entry.path))
  if (essential !== undefined) keepSet.add(essential)

  let removed = 0
  let bytes = 0
  for (const entry of pool) {
    if (keepSet.has(entry.path)) continue
    bytes += sizeOf(entry.path)
    rmSync(entry.path, { recursive: true, force: true })
    removed += 1
  }
  return { kept: pool.length - removed, removed, bytes }
}

export function gc(options: GcOptions): GcResult {
  if (!Number.isInteger(options.keep) || options.keep < 1) {
    throw new Error(`cbd: gc keeps at least one run, not ${String(options.keep)}`)
  }
  // Canonical, because `nearestMapCommit` canonicalizes too; two spellings of the
  // same directory would make the essential-map set miss the map it just found.
  const root = realpathSync(options.root)
  const stateDir = options.stateDir ?? '.cbd'
  const shards = prune(candidates(join(root, stateDir, 'shards'), 'file'), options.keep, undefined)

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
    candidates(mapsRoot, 'dir'),
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
