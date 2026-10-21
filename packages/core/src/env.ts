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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ScanOptions } from './normalize.js'

/**
 * Set to `1`/`true` when the tool's own code is the code under test.
 *
 * Dogfooding is the case: CBD records CBD's suites, and the self-root floor that
 * keeps a take's bookkeeping out of every window would also keep
 * `packages/core/src` out of the map. Named here next to the other scan
 * variables because it is the same contract with the person running the tests.
 */
export const INCLUDE_SELF_ENV = 'CBD_INCLUDE_SELF'

export function scanFromEnv(env: NodeJS.ProcessEnv = process.env): ScanOptions | undefined {
  const from = env.CBD_PROJECTION_FROM
  const to = env.CBD_PROJECTION_TO
  const relocateFrom = env.CBD_RELOCATE_FROM
  const relocateTo = env.CBD_RELOCATE_TO
  const include = env.CBD_INCLUDE
  const includeSelf = env[INCLUDE_SELF_ENV]

  const scan: ScanOptions = {}
  if (from !== undefined && to !== undefined) scan.projection = [{ from, to }]
  if (relocateFrom !== undefined && relocateTo !== undefined) {
    scan.relocate = [{ from: relocateFrom, to: relocateTo }]
  }
  if (include !== undefined) scan.include = (file) => file.startsWith(include)
  if (includeSelf === '1' || includeSelf === 'true') scan.includeSelf = true

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

/** One test in a selection file, in the adapter-neutral form. */
export interface SelectionTest {
  id: string
  file: string | null
  title: string
  titlePath?: string[]
  line?: number
  column?: number
}

/**
 * The selection file.
 *
 * Version 2 names tests the way the map does: by id, file and title. Version 1 —
 * `{ "titles": [...] }`, which carried no file and no version — is still read,
 * because an adapter and a CLI do not upgrade together and a file written by an
 * older `cbd collect` must not become "no filter".
 */
export interface SelectionFile {
  version: 2
  tests: SelectionTest[]
}

/**
 * Writes a selection file for `tests`.
 *
 * Shared by `cbd collect` (which hands it to the runner it spawns) and `cbd select
 * --emit-selection` (which hands it to a runner the caller starts), so the two
 * cannot drift into formats an adapter reads differently. A map recorded before
 * ids existed still yields one: the id is derivable from its two fields.
 */
export function writeSelection(
  path: string,
  tests: ReadonlyArray<{
    id?: string
    file: string | null
    title: string
    ordinal?: number
    titlePath?: string[]
    line?: number
    column?: number
  }>,
): SelectionFile {
  const seen = new Set<string>()
  const entries: SelectionTest[] = []
  for (const entry of tests) {
    const key = `${entry.id ?? `${entry.file ?? ''}::${entry.title}`}\u0000${String(entry.ordinal ?? 0)}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      id: entry.id ?? `${entry.file ?? ''}::${entry.title}`,
      file: entry.file,
      title: entry.title,
      ...(entry.titlePath === undefined ? {} : { titlePath: entry.titlePath }),
      ...(entry.line === undefined ? {} : { line: entry.line }),
      ...(entry.column === undefined ? {} : { column: entry.column }),
    })
  }
  const file: SelectionFile = { version: 2, tests: entries }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(file))
  return file
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

  const tests = selectionTests(parsed, path)
  if (tests !== undefined) {
    if (tests.length === 0) throw emptySelection(path)
    return [...new Set(tests.map((test) => test.title))]
  }

  const titles = (parsed as { titles?: unknown } | null)?.titles
  if (!Array.isArray(titles) || titles.some((title) => typeof title !== 'string')) {
    throw new Error(
      `cbd: the selection at ${path} must contain { "titles": string[] } or ` +
        '{ "version": 2, "tests": [...] }',
    )
  }
  if (titles.length === 0) throw emptySelection(path)
  return titles
}

/**
 * The v2 entries, when the file is v2. `undefined` means the caller gave a v1
 * file; a malformed v2 file is an error, never a silent fall back to titles.
 */
export function readSelectionTests(
  env: NodeJS.ProcessEnv = process.env,
): SelectionTest[] | undefined {
  const path = env[SELECTION_ENV]
  if (path === undefined || path === '') return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cbd: cannot read the selection at ${path}: ${String(error)}`)
  }

  const tests = selectionTests(parsed, path)
  if (tests === undefined) return undefined
  if (tests.length === 0) throw emptySelection(path)
  return tests
}

function emptySelection(path: string): Error {
  return new Error(
    `cbd: the selection at ${path} is empty; a runner reads an empty filter as ` +
      '"run every test", so refusing rather than running the whole suite',
  )
}

/**
 * Validates a v2 `tests` array, or returns `undefined` for a v1-shaped object.
 *
 * The distinction is the presence of `tests`; an object with neither field is a
 * malformed file, reported by the caller's v1 check with a message naming both
 * accepted shapes.
 */
function selectionTests(parsed: unknown, path: string): SelectionTest[] | undefined {
  const tests = (parsed as { tests?: unknown } | null)?.tests
  if (tests === undefined) return undefined
  if (!Array.isArray(tests)) {
    throw new Error(`cbd: the selection at ${path} has a non-array "tests"`)
  }
  return tests.map((entry, index) => {
    const test = entry as Partial<SelectionTest> | null
    if (
      test === null ||
      typeof test !== 'object' ||
      typeof test.id !== 'string' ||
      typeof test.title !== 'string' ||
      (test.file !== null && typeof test.file !== 'string') ||
      (test.titlePath !== undefined &&
        (!Array.isArray(test.titlePath) || test.titlePath.some((part) => typeof part !== 'string'))) ||
      (test.line !== undefined && typeof test.line !== 'number') ||
      (test.column !== undefined && typeof test.column !== 'number')
    ) {
      throw new Error(`cbd: the selection at ${path} has a malformed test at index ${index}`)
    }
    return {
      id: test.id,
      file: test.file,
      title: test.title,
      ...(test.titlePath === undefined ? {} : { titlePath: test.titlePath }),
      ...(test.line === undefined ? {} : { line: test.line }),
      ...(test.column === undefined ? {} : { column: test.column }),
    }
  })
}
