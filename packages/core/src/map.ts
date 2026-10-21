/**
 * Merging shards into the on-disk coverage map, and reading it back.
 *
 * The map is the thing that outlives a test run. It is keyed by commit because
 * `cbd select` diffs from the map's commit, not from the branch base — so a
 * stale map is not merely old data, it is a wider diff, and the measured effect
 * of that is severe: the share of changes that can be answered at all falls from
 * ~66% at a one-commit window to ~2.4% at ten.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { FileCache } from './line-index.js'
import { resolveShard, type ResolvedShard } from './resolve.js'
import type { ScanOptions } from './normalize.js'
import type { ShardInput, TouchRef } from './shard.js'

export const MAP_VERSION = 1

export interface FunctionEntry {
  startLine: number
  endLine: number
  /** Indices into `CoverageMap.tests`. */
  tests: number[]
}

export interface TestEntry {
  title: string
  file: string | null
  /**
   * Disambiguates a repeated `(file, title)` within one map.
   *
   * Absent for the first occurrence, then 1, 2, … for later ones in recording
   * order. Selection still filters by title — duplicates run together, safely
   * over-selecting — but their coverage and failures no longer merge (`cbd-gkj`).
   */
  ordinal?: number
}

export interface CoverageMap {
  version: number
  commit: string
  builtAt: string
  tests: TestEntry[]
  /** file -> key -> entry. */
  files: Record<string, Record<string, FunctionEntry>>
  /** Executed before the first test. Reaching it means the module was imported. */
  load: TouchRef[]
  /** Executed outside any window. Unattributable, so it reaches every test. */
  between: TouchRef[]
  /** Post-run activity — global teardown, late timers. */
  teardown: TouchRef[]
  /**
   * Every file the map has any evidence for, including ones no test reaches.
   *
   * `files` only holds functions a test touched, so a changed file that was
   * loaded but never exercised would otherwise be indistinguishable from a file
   * the map has never seen — and §8.3 gives those two cases opposite answers
   * (`untested`, nothing selected, versus `unknown-file`, everything selected).
   */
  seen: string[]
  /** Names of the shards merged in, for provenance. Indexed by `shardTests`. */
  shards: string[]
  /**
   * Per shard, the tests that can observe its module-scope state.
   *
   * A module-scope binding can be read by a test that never calls a function in
   * the file, so the function index alone under-selects a top-level change
   * (`cbd-0na.2`). The shard is the process: every test recorded in the same
   * shard as the `@load`/`@teardown` touch shared that instance of the module.
   * For a service shard only the tests that actually touched it are observers,
   * because the adapters open a window for every test on every recorder.
   *
   * Stored per shard rather than per file: a file→tests record would repeat the
   * whole test list once per loaded module, which is most of the map for a large
   * suite. `loadShards` is the other half of the relation.
   *
   * Optional: maps written before this field have no attribution, and `select`
   * falls back to `mode: all` for those files, which is the pre-existing safe
   * answer.
   */
  shardTests?: number[][]
  /**
   * Per file, the indices into `shards`/`shardTests` whose `@load`/`@teardown`
   * touched it. A changed file's observers are the union of those shards' tests.
   */
  loadShards?: Record<string, number[]>
  /**
   * Whether the tree the shards were recorded from had uncommitted changes.
   *
   * Optional because maps written before this field existed do not carry it; a
   * missing value means "not known to be dirty", which is the pre-existing
   * behaviour. `select` warns when it is true.
   */
  dirty?: boolean
}

export interface MapBuildOptions {
  commit: string
  builtAt?: string
  /** See `CoverageMap.dirty`. */
  dirty?: boolean
  /**
   * How to read the shards' byte ranges: projection and relocation rules, and the
   * include/exclude filters. A v2 shard carries no paths, so the build is where
   * these rules apply (ADR-0002). Defaults to none, which resolves a script by its
   * own file and keeps every file it resolves to.
   */
  scan?: ScanOptions
  /**
   * Whether to include tests that did not pass. Default false: a test that
   * aborted early executed *less* than it should have, so its touches
   * under-select — silently. Such a window must not reach the map.
   */
  includeNonGreen?: boolean
}

const refId = (ref: TouchRef): string => `${ref[0]}\u0000${ref[1]}`

function mergeRefs(target: Map<string, TouchRef>, refs: TouchRef[]): void {
  for (const ref of refs) {
    const id = refId(ref)
    const existing = target.get(id)
    if (existing === undefined) {
      // Copy, so a caller's array is never mutated through the map.
      target.set(id, [ref[0], ref[1], ref[2], ref[3]])
      continue
    }
    existing[2] = Math.min(existing[2], ref[2])
    existing[3] = Math.max(existing[3], ref[3])
  }
}

/**
 * The merge half of a build: resolved shards -> the on-disk map.
 *
 * Separate from resolution so the merge can be tested without a tree of generated
 * files, and so all file I/O stays in one place. `buildMap` is the two together.
 */
export function mergeShards(shards: ResolvedShard[], options: MapBuildOptions): CoverageMap {
  const tests: TestEntry[] = []
  const testIndex = new Map<string, number>()
  const files = new Map<string, Map<string, FunctionEntry>>()
  const load = new Map<string, TouchRef>()
  const between = new Map<string, TouchRef>()
  const teardown = new Map<string, TouchRef>()
  const loadShards = new Map<string, Set<number>>()
  const shardTests: number[][] = []
  const included: string[] = []

  const indexOfTest = (title: string, file: string | null, ordinal?: number): number => {
    const id = `${title}\u0000${file ?? ''}\u0000${String(ordinal ?? 0)}`
    const existing = testIndex.get(id)
    if (existing !== undefined) return existing
    const index = tests.length
    tests.push({ title, file, ...(ordinal === undefined ? {} : { ordinal }) })
    testIndex.set(id, index)
    return index
  }

  for (const resolved of shards) {
    const shardIndex = included.length
    included.push(resolved.name)
    mergeRefs(load, resolved.load)
    mergeRefs(between, resolved.between)
    mergeRefs(teardown, resolved.teardown)

    const allTests: number[] = []
    const touchedTests: number[] = []
    for (const test of resolved.tests) {
      if (!options.includeNonGreen && test.status !== 'passed') continue
      const index = indexOfTest(test.title, test.file, test.ordinal)
      allTests.push(index)
      if (test.touches.length > 0) touchedTests.push(index)
      for (const ref of test.touches) {
        let byKey = files.get(ref[0])
        if (byKey === undefined) {
          byKey = new Map()
          files.set(ref[0], byKey)
        }
        const existing = byKey.get(ref[1])
        if (existing === undefined) {
          byKey.set(ref[1], { startLine: ref[2], endLine: ref[3], tests: [index] })
          continue
        }
        existing.startLine = Math.min(existing.startLine, ref[2])
        existing.endLine = Math.max(existing.endLine, ref[3])
        if (!existing.tests.includes(index)) existing.tests.push(index)
      }
    }

    // Every test in this process shared the module instance that the load or
    // teardown touch came from. A service shard is the exception: it is not the
    // process the tests ran in, and its recorder opened a window for every test
    // title, so only a test that actually touched the service can observe what
    // it loaded.
    const observers = resolved.header.role === 'service' ? touchedTests : allTests
    shardTests.push([...new Set(observers)].sort((a, b) => a - b))
    for (const ref of [...resolved.load, ...resolved.teardown]) {
      let indices = loadShards.get(ref[0])
      if (indices === undefined) {
        indices = new Set()
        loadShards.set(ref[0], indices)
      }
      indices.add(shardIndex)
    }
  }

  const sortedFiles: Record<string, Record<string, FunctionEntry>> = {}
  for (const file of [...files.keys()].sort()) {
    const byKey = files.get(file)!
    const sorted: Record<string, FunctionEntry> = {}
    for (const key of [...byKey.keys()].sort()) {
      const entry = byKey.get(key)!
      entry.tests.sort((a, b) => a - b)
      sorted[key] = entry
    }
    sortedFiles[file] = sorted
  }

  const byPath = (a: TouchRef, b: TouchRef): number =>
    a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1

  const loadRefs = [...load.values()].sort(byPath)
  const betweenRefs = [...between.values()].sort(byPath)
  const teardownRefs = [...teardown.values()].sort(byPath)

  const seen = new Set<string>(Object.keys(sortedFiles))
  for (const ref of [...loadRefs, ...betweenRefs, ...teardownRefs]) seen.add(ref[0])

  const shardsForFile: Record<string, number[]> = {}
  for (const file of [...loadShards.keys()].sort()) {
    shardsForFile[file] = [...loadShards.get(file)!].sort((a, b) => a - b)
  }

  return {
    version: MAP_VERSION,
    commit: options.commit,
    builtAt: options.builtAt ?? new Date().toISOString(),
    tests,
    files: sortedFiles,
    load: loadRefs,
    between: betweenRefs,
    teardown: teardownRefs,
    loadShards: shardsForFile,
    shardTests,
    seen: [...seen].sort(),
    shards: included,
    dirty: options.dirty === true,
  }
}

/**
 * Resolve every shard, then merge.
 *
 * One `FileCache` for the build: a generated file is read and indexed once, no
 * matter how many scripts or shards name it. The resolution itself is
 * `resolveShard`, once per distinct `(script, function)` (ADR-0002).
 */
export function buildMap(shards: ShardInput[], options: MapBuildOptions): CoverageMap {
  const cache = new FileCache()
  const resolved = shards.map((shard) =>
    resolveShard(shard, {
      ...(options.scan === undefined ? {} : { scan: options.scan }),
      cache,
    }),
  )
  return mergeShards(resolved, options)
}

/**
 * Where a commit's map lives. `stateDir` is the config's state directory, rooted
 * at the repository; `.cbd` is the default.
 */
export function mapDir(root: string, commit: string, stateDir = '.cbd'): string {
  return join(root, stateDir, 'maps', commit)
}

export function mapPath(root: string, commit: string, stateDir = '.cbd'): string {
  return join(mapDir(root, commit, stateDir), 'map.json')
}

/**
 * A path as the map stores it: relative to `root` when it is under it.
 *
 * A map recorded in one worktree used to carry absolute paths, so a copy in
 * another worktree answered `unknown-file` for every file (`cbd-0na.5`). Storing
 * repository-relative paths and resolving them against the root that loads the
 * map makes the map portable across worktrees, sandboxes and CI checkouts of the
 * same commit. A path outside the root (a relocated dependency, a global cache)
 * has no stable relative form and stays absolute.
 */
const storePath = (root: string, path: string): string => {
  if (!isAbsolute(path)) return path
  const rel = relative(root, path)
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? path : rel
}

/** The inverse of `storePath`: absolute paths are left alone (pre-relative maps). */
const loadPath = (root: string, path: string): string =>
  isAbsolute(path) ? path : resolve(root, path)

/**
 * The same canonical root `createCbd` uses: Node resolves module URLs through
 * symlinks, so a map recorded under `/private/var/...` must load under
 * `/private/var/...` even when the caller names `/var/...`.
 */
const canonicalRoot = (root: string): string => {
  try {
    return realpathSync(resolve(root))
  } catch {
    return resolve(root)
  }
}

const mapRef = (root: string, ref: TouchRef, to: (root: string, path: string) => string): TouchRef => [
  to(root, ref[0]),
  ref[1],
  ref[2],
  ref[3],
]

function mapPaths(
  map: CoverageMap,
  root: string,
  to: (root: string, path: string) => string,
): CoverageMap {
  return {
    ...map,
    tests: map.tests.map((entry) =>
      entry.file === null ? entry : { ...entry, file: to(root, entry.file) },
    ),
    files: Object.fromEntries(
      Object.entries(map.files).map(([file, functions]) => [to(root, file), functions]),
    ),
    load: map.load.map((ref) => mapRef(root, ref, to)),
    between: map.between.map((ref) => mapRef(root, ref, to)),
    teardown: map.teardown.map((ref) => mapRef(root, ref, to)),
    ...(map.loadShards === undefined
      ? {}
      : {
          loadShards: Object.fromEntries(
            Object.entries(map.loadShards).map(([file, shards]) => [to(root, file), shards]),
          ),
        }),
    seen: map.seen.map((file) => to(root, file)),
  }
}

export function saveMap(
  root: string,
  map: CoverageMap,
  stateDir = '.cbd',
): { path: string; bytes: number } {
  const dir = mapDir(root, map.commit, stateDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'map.json')
  const json = JSON.stringify(mapPaths(map, canonicalRoot(root), storePath))
  writeFileSync(path, json)
  return { path, bytes: Buffer.byteLength(json) }
}

export interface LoadedMap {
  map: CoverageMap
  path: string
  bytes: number
  /** Parse time, so the cost of reading a map can be weighed against rebuilding. */
  parseMs: number
}

export function loadMap(root: string, commit: string, stateDir = '.cbd'): LoadedMap {
  const path = mapPath(root, commit, stateDir)
  const raw = readFileSync(path, 'utf8')
  const started = performance.now()
  const stored = JSON.parse(raw) as CoverageMap
  const parseMs = performance.now() - started
  if (stored.version !== MAP_VERSION) {
    throw new Error(`map at ${path} is version ${stored.version}, expected ${MAP_VERSION}`)
  }
  return {
    map: mapPaths(stored, canonicalRoot(root), loadPath),
    path,
    bytes: Buffer.byteLength(raw),
    parseMs,
  }
}

/** One function a test reached, in the map's coordinates. */
export interface ReachedFunction {
  file: string
  key: string
  startLine: number
  endLine: number
}

/**
 * Every function one test reached — the inverse of `testsForFunction`.
 *
 * The map is stored the other way round because selection asks "which tests reach
 * this function"; this direction exists for the human question behind `cbd reaches`
 * ("what does this test cover?"), and it is a scan of the function index rather
 * than a second index, because the map is read far more often than queried this way.
 */
export function functionsForTest(map: CoverageMap, index: number): ReachedFunction[] {
  const out: ReachedFunction[] = []
  for (const [file, functions] of Object.entries(map.files)) {
    for (const [key, entry] of Object.entries(functions)) {
      if (!entry.tests.includes(index)) continue
      out.push({ file, key, startLine: entry.startLine, endLine: entry.endLine })
    }
  }
  return out.sort((a, b) =>
    a.file === b.file ? a.key.localeCompare(b.key) : a.file.localeCompare(b.file),
  )
}

/** The tests that reach a given function. The question the tool exists to answer. */
export function testsForFunction(map: CoverageMap, file: string, key: string): TestEntry[] {
  const entry = map.files[file]?.[key]
  if (entry === undefined) return []
  return entry.tests.map((index) => map.tests[index]!).filter(Boolean)
}

/** Every function the map knows about in a file, executed or not. */
export function functionsInFile(map: CoverageMap, file: string): string[] {
  return Object.keys(map.files[file] ?? {}).sort()
}

/**
 * The tests that reach one source line — `cbd-2ev`'s question, and §8.3's rules 4
 * and 5 applied to a single line.
 *
 * A line inside a mapped function selects the tests that touched that function. A
 * line outside every function an import, a top-level constant, a class field
 * initializer — could be read by anything in the file, so every test that touched
 * the file is the honest answer; this is the same fallback `select` takes for a
 * hunk that lands in no function, and for the same reason: it over-selects rather
 * than guesses.
 *
 * A line inside *several* nested functions is the union of all of them. V8 emits a
 * row per function, so an outer function's range contains an inner one's; taking
 * only the innermost would miss the tests that ran the outer and not the inner.
 *
 * An unknown file returns `[]`. The caller decides what that means — `select`
 * treats an unknown file and an untested one as opposite answers, and the map
 * alone cannot tell which question is being asked.
 */
export function testsForLine(map: CoverageMap, file: string, line: number): TestEntry[] {
  const functions = map.files[file]
  if (functions === undefined) return []

  const indices = new Set<number>()
  let inside = false
  for (const [key, entry] of Object.entries(functions)) {
    // The module body's V8 range is the whole file, but it is module scope, not
    // a function: a line that only the module body contains is outside every
    // function and takes the file-level answer (`cbd-73r.1`).
    if (key.startsWith('<module>')) continue
    if (line < entry.startLine || line > entry.endLine) continue
    inside = true
    for (const index of entry.tests) indices.add(index)
  }
  if (!inside) {
    for (const entry of Object.values(functions)) for (const index of entry.tests) indices.add(index)
  }
  return [...indices]
    .sort((a, b) => a - b)
    .map((index) => map.tests[index]!)
    .filter(Boolean)
}
