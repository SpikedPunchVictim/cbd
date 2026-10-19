/**
 * The scan options an adapter cannot guess for itself, read from the environment.
 *
 * This lives in the core rather than in each adapter because it is a *contract
 * with the person running the tests*, not an implementation detail of a runner:
 * the variable names are the same whichever framework is underneath, and an
 * adapter that spelled them differently would be a bug nobody would notice until
 * a projection silently stopped applying and coverage mapped onto the wrong files.
 * The two adapters previously carried a copy each; a second copy is where drift
 * starts.
 *
 * `CBD_PROJECTION_FROM` / `CBD_PROJECTION_TO` describe one projection rule,
 * `<from>` → `<to>` with the default `.js` → `.ts` extension swap. For VS Code
 * that is `<root>/out` → `<root>`, turning `out/vs/platform/x.js` back into
 * `src/vs/platform/x.ts`. Projection is only needed for a build with no source
 * maps; where maps exist the resolver prefers them, and rightly so — an esbuild
 * transform is not line-preserving, so projecting its output would be a guess.
 *
 * `CBD_RELOCATE_FROM` / `CBD_RELOCATE_TO` describe one relocation rule, applied to
 * a path that resolved through its own map into a *copy* of the tree: `<staging
 * root>` → `<checkout root>`. A deployed lane is the case that forced it — the
 * copy's maps are correct and resolve inside the copy, so without a rule the map is
 * keyed by a path no diff can name (ADR-0006). Projection cannot stand in for it:
 * projection is consulted only when a script has no map, and these have one.
 */
import { readFileSync } from 'node:fs'
import type { ScanOptions } from './normalize.js'

export function scanFromEnv(env: NodeJS.ProcessEnv = process.env): ScanOptions | undefined {
  const from = env.CBD_PROJECTION_FROM
  const to = env.CBD_PROJECTION_TO
  const relocateFrom = env.CBD_RELOCATE_FROM
  const relocateTo = env.CBD_RELOCATE_TO
  const include = env.CBD_INCLUDE

  const scan: ScanOptions = {}
  if (from !== undefined && to !== undefined) scan.projection = [{ from, to }]
  if (relocateFrom !== undefined && relocateTo !== undefined) {
    scan.relocate = [{ from: relocateFrom, to: relocateTo }]
  }
  if (include !== undefined) scan.include = (file) => file.startsWith(include)

  return Object.keys(scan).length === 0 ? undefined : scan
}

/**
 * The selection file `cbd collect` writes and an adapter reads.
 *
 * `cbd collect` resolves a selection before the suite starts — it is the only
 * process that can, because the map and the diff are already in hand there — and
 * then spawns the consumer's runner. The selection has to cross that process
 * boundary, and an environment variable is the seam both sides already use
 * (`CBD_SHARD`, `CBD_SOCKET_DIR`, the scan rules above).
 *
 * **A path, not the titles themselves.** An environment variable carries the whole
 * selection inline for a small suite and stops working for a large one; unix caps a
 * single variable at ~128 kB and the total environment at ~1 MB, which a few
 * thousand titles reach. A file has no such ceiling and is inspectable after a run.
 *
 * **Only the subset.** `mode: all` sets no variable at all: the runner's default is
 * to run everything, which is exactly the answer. Nothing needs to be said.
 *
 * `titles` are the bare titles japa filters on (A0 F10). The adapter refuses an
 * empty list because the runner reads "no filter" as "every test" — the safe
 * direction is running everything, but it must never be reached by a caller who
 * meant "run nothing", so it is an error rather than a silent opposite.
 */
export const SELECTION_ENV = 'CBD_SELECTION'

export interface SelectionFile {
  titles: string[]
}

/**
 * Reads the selection named by `CBD_SELECTION`, if any.
 *
 * A malformed file is an error: falling back to the full suite here would look
 * like a slow run rather than a broken bridge, and the cost of finding that later
 * is higher than failing now.
 */
export function readSelection(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const path = env[SELECTION_ENV]
  if (path === undefined || path === '') return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cbd: cannot read the selection at ${path}: ${String(error)}`)
  }

  const titles = (parsed as SelectionFile | null)?.titles
  if (!Array.isArray(titles) || titles.some((title) => typeof title !== 'string')) {
    throw new Error(`cbd: the selection at ${path} must contain { "titles": string[] }`)
  }
  if (titles.length === 0) {
    throw new Error(
      `cbd: the selection at ${path} is empty; a runner reads an empty filter as ` +
        '"run every test", so refusing rather than running the whole suite',
    )
  }
  return titles
}
