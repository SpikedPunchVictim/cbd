/**
 * Merging shards into the on-disk coverage map, and reading it back.
 *
 * The map is the thing that outlives a test run. It is keyed by commit because
 * `cbd select` diffs from the map's commit, not from the branch base — so a
 * stale map is not merely old data, it is a wider diff, and the measured effect
 * of that is severe: the share of changes that can be answered at all falls from
 * ~66% at a one-commit window to ~2.4% at ten.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  /** Names of the shards merged in, for provenance. */
  shards: string[]
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
  const included: string[] = []

  const indexOfTest = (title: string, file: string | null): number => {
    const id = `${title}\u0000${file ?? ''}`
    const existing = testIndex.get(id)
    if (existing !== undefined) return existing
    const index = tests.length
    tests.push({ title, file })
    testIndex.set(id, index)
    return index
  }

  for (const resolved of shards) {
    included.push(resolved.name)
    mergeRefs(load, resolved.load)
    mergeRefs(between, resolved.between)
    mergeRefs(teardown, resolved.teardown)

    for (const test of resolved.tests) {
      if (!options.includeNonGreen && test.status !== 'passed') continue
      const index = indexOfTest(test.title, test.file)
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

  return {
    version: MAP_VERSION,
    commit: options.commit,
    builtAt: options.builtAt ?? new Date().toISOString(),
    tests,
    files: sortedFiles,
    load: loadRefs,
    between: betweenRefs,
    teardown: teardownRefs,
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

export function saveMap(
  root: string,
  map: CoverageMap,
  stateDir = '.cbd',
): { path: string; bytes: number } {
  const dir = mapDir(root, map.commit, stateDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'map.json')
  const json = JSON.stringify(map)
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
  const map = JSON.parse(raw) as CoverageMap
  const parseMs = performance.now() - started
  if (map.version !== MAP_VERSION) {
    throw new Error(`map at ${path} is version ${map.version}, expected ${MAP_VERSION}`)
  }
  return { map, path, bytes: Buffer.byteLength(raw), parseMs }
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
  for (const entry of Object.values(functions)) {
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
