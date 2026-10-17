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
