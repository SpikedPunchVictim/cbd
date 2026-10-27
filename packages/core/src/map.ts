/**
 * Merging shards into the on-disk coverage map, and reading it back.
 *
 * The map is the thing that outlives a test run. It is keyed by commit because
 * `cbd select` diffs from the map's commit, not from the branch base — so a
 * stale map is not merely old data, it is a wider diff, and the measured effect
 * of that is severe: the share of changes that can be answered at all falls from
 * ~66% at a one-commit window to ~2.4% at ten.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { testId } from './contract.js'
import type { HunkEdit } from './changes.js'
import { projectPath } from './projection.js'
import { FileCache } from './line-index.js'
import { resolveShard, type ResolvedShard, type ResolvedTest } from './resolve.js'
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
  /**
   * Canonical, runner-neutral id: `<file>::<title>`.
   *
   * Optional only for maps written before the id existed; `buildMap` always
   * writes it, and readers derive it from `(file, title)` when it is absent.
   */
  id?: string
  title: string
  file: string | null
  /**
   * Disambiguates a repeated `(file, title)` within one map.
   *
   * Absent for the first occurrence, then 1, 2, … for later ones in recording
   * order. Selection still filters by title — duplicates run together, safely
   * over-selecting — but their coverage and failures no longer merge.
   */
  ordinal?: number
  /**
   * The title path, when the adapter supplied one. The id is `file::title`, so a
   * path does not change identity; it makes `explain` readable.
   */
  titlePath?: string[]
  /** Definition site, when the runner exposed it. Not part of the id. */
  line?: number
  column?: number
  /** The last recorded outcome and duration, for the subset's cost estimate. */
  status?: 'passed' | 'failed' | 'skipped'
  durationMs?: number
  /**
   * Environment variables the test declared with `recordEnv`, by name, each with
   * the hashes the recording saw.
   *
   * Per test, never pooled across tests: another test's value says nothing about
   * this one. More than one hash means the same test id was recorded under
   * different values (shards of a CI matrix); selection keeps all of them. Only a
   * hash is stored, never the value. It is unsalted and truncated, so a
   * low-entropy value (`1`, `true`, a region name) can be recovered by guessing.
   */
  env?: Record<string, string[]>
}

export interface CoverageMap {
  version: number
  commit: string
  builtAt: string
  tests: TestEntry[]
  /** file -> key -> entry. */
  files: Record<string, Record<string, FunctionEntry>>
  /**
   * Files read by tests, and the tests that read them.
   *
   * A text oracle executes no code in the file it reads, so the function index
   * cannot connect them. Optional: maps written before read tracking have no
   * field, and selection behaves exactly as it did.
   */
  reads?: Record<string, number[]>
  /** Directories listed by tests; a change to any file under one selects the lister. */
  dirReads?: Record<string, number[]>
  /**
   * Tests that declared an invisible dependency, by the reason they gave.
   *
   * `recordOpaque` is the honest fallback for a test that spawns a tool or drives
   * a service: there is no path to name, so any in-scope change selects it.
   */
  opaque?: Record<string, number[]>
  /**
   * Files whose evidence an incremental build could not carry.
   *
   * A map written by carrying untouched tests forward from an earlier commit is
   * complete only for the files nothing changed. For every other file, the tests
   * that used to reach it were not re-recorded and their old line ranges may have
   * moved, so a change to it must run everything. An entry may be a directory (a
   * dropped directory listing), and then anything under it is partial.
   */
  partial?: string[]
  /**
   * Shards whose recording was incomplete, one reason each.
   *
   * A window that could not be taken substituted an empty capture, and an empty
   * window could have covered any file. Nothing path-level can express that, so the
   * map says it at this level and `select` runs everything for an in-scope change.
   * Optional: a map written before this field existed behaves exactly as it did.
   */
  unhealthy?: string[]
  /** Present on a map assembled by `carryMap`: what it was carried from. */
  carried?: { base: string; tests: number }
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
   * Whether a path a test read or listed belongs in the map.
   *
   * The default keeps every path except those under a `node_modules` directory,
   * which no project change can reach. `createCbd` narrows further to paths under
   * the project root and inside `include`, the same scope selection uses: a change
   * outside it would not select the test anyway, and a shard can record a lot of
   * incidental reads. Applied at build time, like the other path rules, so a
   * direct `buildMap` caller can supply its own project scope. Paths under
   * `node_modules` are always dropped, whatever the callback says.
   */
  keepRead?: (path: string) => boolean
  /**
   * Whether a directory a test listed belongs in the map.
   *
   * Kept apart from `keepRead` because a directory never matches a file glob
   * such as `src/**`; selection's `isUnder` check is what makes a change under a
   * listed directory reach the lister. The default keeps every directory outside
   * `node_modules`, matching `resolve.ts`.
   */
  keepDir?: (path: string) => boolean
  /**
   * Whether to include tests that did not pass. Default false: a test that
   * aborted early executed *less* than it should have, so its touches
   * under-select — silently. Such a window must not reach the map.
   */
  includeNonGreen?: boolean
}

/**
 * Whether a path is under a `node_modules` directory.
 *
 * A segment match, not a substring: a project may legitimately contain a file or
 * directory whose name merely contains `node_modules`.
 */
function underNodeModules(file: string): boolean {
  return file.split(sep).includes('node_modules')
}

/**
 * The source file a build output's sibling source map names, if there is one.
 *
 * A `tsc` test reads `dist/x.d.ts`; the dependency a selection can see is
 * `src/x.ts`. Declaration maps and source maps carry that link, and the read
 * tracker sees the build path because that is what the test opened.
 */
function sourceMapSource(file: string): string | undefined {
  const mapPath = `${file}.map`
  if (!existsSync(mapPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(mapPath, 'utf8')) as {
      sources?: unknown
      sourceRoot?: unknown
    }
    const sources = parsed.sources
    if (!Array.isArray(sources) || sources.length === 0) return undefined
    const first = sources[0]
    if (typeof first !== 'string' || first === '') return undefined
    const root = typeof parsed.sourceRoot === 'string' ? parsed.sourceRoot : ''
    return resolve(dirname(mapPath), root, first)
  } catch {
    return undefined
  }
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
 * Renumber every function key across the whole build.
 *
 * A key's ordinal is assigned per script from the functions that one process
 * executed, so it is not an identity beyond that process: shard A's `<anonymous>@0`
 * (an arrow on line 96) and shard B's `<anonymous>@0` (a different arrow on line
 * 178) are the same key for different functions, and merging by key would union
 * them into one 96-178 function. A function is `(file, name, startLine, endLine)`.
 * Collect the distinct ones per file across every ref of every shard, order them by
 * position (an enclosing function before a nested one), and number them per name,
 * so the same function gets the same key whichever shard saw it. Two functions with
 * an identical identity share a key, which loses nothing a selection can observe.
 */
function renumberShards(shards: ResolvedShard[]): ResolvedShard[] {
  type Fn = { name: string; start: number; end: number }
  const nameOf = (key: string): string => key.slice(0, key.lastIndexOf('@'))
  const identity = (ref: TouchRef): string =>
    `${ref[0]}\u0000${nameOf(ref[1])}\u0000${String(ref[2])}\u0000${String(ref[3])}`

  const byFile = new Map<string, Map<string, Fn>>()
  // A group-granularity shard hands every test of the group the same touch array,
  // so each distinct array is visited and rewritten once, not once per test.
  const visited = new WeakSet<TouchRef[]>()
  const visit = (refs: TouchRef[]): void => {
    if (visited.has(refs)) return
    visited.add(refs)
    for (const ref of refs) {
      let fns = byFile.get(ref[0])
      if (fns === undefined) {
        fns = new Map()
        byFile.set(ref[0], fns)
      }
      fns.set(identity(ref), { name: nameOf(ref[1]), start: ref[2], end: ref[3] })
    }
  }
  const eachRefList = (shard: ResolvedShard): TouchRef[][] => [
    ...shard.tests.map((test) => test.touches),
    shard.load,
    shard.between,
    shard.teardown,
  ]
  for (const shard of shards) for (const refs of eachRefList(shard)) visit(refs)

  const keys = new Map<string, string>()
  for (const fns of byFile.values()) {
    const ordered = [...fns.entries()].sort(
      ([, a], [, b]) =>
        a.start - b.start ||
        b.end - a.end ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    const next = new Map<string, number>()
    for (const [id, fn] of ordered) {
      const ordinal = next.get(fn.name) ?? 0
      next.set(fn.name, ordinal + 1)
      keys.set(id, `${fn.name}@${String(ordinal)}`)
    }
  }

  const rewritten = new WeakMap<TouchRef[], TouchRef[]>()
  const rewrite = (refs: TouchRef[]): TouchRef[] => {
    let out = rewritten.get(refs)
    if (out === undefined) {
      out = refs.map((ref) => [ref[0], keys.get(identity(ref))!, ref[2], ref[3]])
      rewritten.set(refs, out)
    }
    return out
  }
  return shards.map((shard) => ({
    ...shard,
    tests: shard.tests.map((test) => ({ ...test, touches: rewrite(test.touches) })),
    load: rewrite(shard.load),
    between: rewrite(shard.between),
    teardown: rewrite(shard.teardown),
  }))
}

/**
 * The merge half of a build: resolved shards -> the on-disk map.
 *
 * Separate from resolution so the merge can be tested without a tree of generated
 * files, and so all file I/O stays in one place. `buildMap` is the two together.
 */
export function mergeShards(rawShards: ResolvedShard[], options: MapBuildOptions): CoverageMap {
  const shards = renumberShards(rawShards)
  const tests: TestEntry[] = []
  const testIndex = new Map<string, number>()
  const files = new Map<string, Map<string, FunctionEntry>>()
  const load = new Map<string, TouchRef>()
  const between = new Map<string, TouchRef>()
  const teardown = new Map<string, TouchRef>()
  const loadShards = new Map<string, Set<number>>()
  const shardObserverKeys: Array<Set<string> | null> = []
  const shardObserverIndices: Array<Set<number> | null> = []
  const reads = new Map<string, Set<number>>()
  const dirReads = new Map<string, Set<number>>()
  const opaque = new Map<string, Set<number>>()
  const included: string[] = []
  const partial = new Set<string>()
  const unhealthy: string[] = []

  const keepRead = (path: string): boolean =>
    !underNodeModules(path) && (options.keepRead?.(path) ?? true)
  const keepDir = (path: string): boolean =>
    !underNodeModules(path) && (options.keepDir?.(path) ?? true)

  const readCandidates = new Map<string, string[]>()
  /**
   * The paths a read or listing should be recorded under.
   *
   * The path the test opened, plus the source its sibling map names and the path a
   * projection rule maps it to. `keepRead` then decides which belong in this map's
   * scope: a `dist` read is usually outside `include` while its `src` is inside it.
   */
  const readPaths = (path: string): string[] => {
    if (underNodeModules(path)) return []
    const cached = readCandidates.get(path)
    if (cached !== undefined) return cached
    const candidates = new Set<string>([path])
    const projection = options.scan?.projection
    if (projection !== undefined) {
      const projected = projectPath(path, projection)
      if (projected !== null) candidates.add(projected)
    }
    const source = sourceMapSource(path)
    if (source !== undefined) candidates.add(source)
    const kept = [...candidates].filter(keepRead)
    readCandidates.set(path, kept)
    return kept
  }

  /**
   * Where a listed directory belongs.
   *
   * A directory never matches a file glob, so `keepDir` (not `keepRead`'s
   * include) decides scope. A projection rule still names the source directory a
   * deployed listing corresponds to; the projected path is the one to keep.
   */
  const dirPaths = (dir: string): string[] => {
    if (underNodeModules(dir)) return []
    const projection = options.scan?.projection
    const projected = projection === undefined ? null : projectPath(dir, projection)
    const candidate = projected ?? dir
    return keepDir(candidate) ? [candidate] : []
  }

  const indexOfTest = (test: ResolvedTest): number => {
    const key = `${test.title}\u0000${test.file ?? ''}\u0000${String(test.ordinal ?? 0)}`
    const existing = testIndex.get(key)
    if (existing !== undefined) {
      // The same test can be recorded twice — the runner's window and a service's
      // — and the service's duration is a duplicate of the same span. Keep the
      // longer observation rather than summing two views of one test.
      const entry = tests[existing]!
      if ((test.durationMs ?? 0) > (entry.durationMs ?? 0)) entry.durationMs = test.durationMs
      return existing
    }
    const index = tests.length
    tests.push({
      id: testId(test.file, test.title),
      title: test.title,
      file: test.file,
      ...(test.ordinal === undefined ? {} : { ordinal: test.ordinal }),
      ...(test.titlePath === undefined ? {} : { titlePath: test.titlePath }),
      ...(test.line === undefined ? {} : { line: test.line }),
      ...(test.column === undefined ? {} : { column: test.column }),
      status: test.status,
      durationMs: test.durationMs,
    })
    testIndex.set(key, index)
    return index
  }

  const attributedTests: ResolvedTest[] = []
  const addTouches = (index: number, touches: ResolvedTest['touches']): void => {
    for (const ref of touches) {
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

  for (const resolved of shards) {
    const shardIndex = included.length
    included.push(resolved.name)
    // A file whose transformed text the recording could not produce is partial:
    // its offsets cannot be verified against the bytes on disk, so a change to it
    // must run everything.
    for (const file of resolved.partialFiles ?? []) partial.add(file)
    // An empty window could have covered any file, so the loss is a property of the
    // shard and cannot be expressed as a path-level partial.
    if ((resolved.failedTakes ?? 0) > 0) {
      unhealthy.push(
        `${resolved.name}: ${String(resolved.failedTakes)} window(s) could not be taken; ` +
          'its coverage is incomplete',
      )
    }
    mergeRefs(load, resolved.load)
    mergeRefs(between, resolved.between)
    mergeRefs(teardown, resolved.teardown)

    const allTests: number[] = []
    const touchedTests = new Set<string>()
    for (const test of resolved.tests) {
      const testKey = `${test.title}\u0000${test.file ?? ''}\u0000${String(test.ordinal ?? 0)}`
      if (test.attributed === true) {
        // The owner may be recorded in another shard; keep the key and resolve it
        // after every shard has been indexed.
        touchedTests.add(testKey)
        attributedTests.push(test)
        continue
      }
      if (!options.includeNonGreen && test.status !== 'passed') continue
      const index = indexOfTest(test)
      allTests.push(index)
      if (test.touches.length > 0) touchedTests.add(testKey)
      for (const [key, hash] of Object.entries(test.env ?? {})) {
        const entry = tests[index]
        if (entry === undefined) continue
        const recorded = (entry.env ??= {})
        const hashes = (recorded[key] ??= [])
        if (!hashes.includes(hash)) hashes.push(hash)
        hashes.sort()
      }
      for (const reason of test.opaque ?? []) {
        let set = opaque.get(reason)
        if (set === undefined) {
          set = new Set()
          opaque.set(reason, set)
        }
        set.add(index)
      }
      for (const file of test.reads ?? []) {
        for (const path of readPaths(file)) {
          let set = reads.get(path)
          if (set === undefined) {
            set = new Set()
            reads.set(path, set)
          }
          set.add(index)
        }
      }
      for (const dir of test.dirReads ?? []) {
        for (const kept of dirPaths(dir)) {
          let set = dirReads.get(kept)
          if (set === undefined) {
            set = new Set()
            dirReads.set(kept, set)
          }
          set.add(index)
        }
      }
      addTouches(index, test.touches)
    }

    // Import-phase reads: a helper called at spec load read a file before any
    // test window existed. The spec the adapter scoped it to owns it; when the
    // adapter could not name the file (a process that imports several specs),
    // every test in the shard does. A scope whose tests are not in the map falls
    // back to the shard rather than dropping the read.
    // Files this shard has function evidence for. A service's loader reads every module
    // it runs, so a bucket read of one of these is incidental and is dropped; keeping it
    // would send every change to that file to every test in the shard.
    const executedHere = new Set<string>()
    for (const ref of [...resolved.load, ...resolved.between, ...resolved.teardown]) {
      executedHere.add(ref[0])
    }
    for (const test of resolved.tests) for (const ref of test.touches) executedHere.add(ref[0])

    for (const record of resolved.loadReads) {
      let targets = allTests
      if (record.file !== null) {
        const matched = allTests.filter((index) => tests[index]?.file === record.file)
        if (matched.length > 0) targets = matched
      }
      if (targets.length === 0) continue
      for (const [key, hash] of Object.entries(record.env ?? {})) {
        for (const index of targets) {
          const entry = tests[index]
          if (entry === undefined) continue
          const hashes = ((entry.env ??= {})[key] ??= [])
          if (!hashes.includes(hash)) hashes.push(hash)
          hashes.sort()
        }
      }
      for (const reason of record.opaque ?? []) {
        let set = opaque.get(reason)
        if (set === undefined) {
          set = new Set()
          opaque.set(reason, set)
        }
        for (const index of targets) set.add(index)
      }
      for (const path of record.reads) {
        for (const kept of readPaths(path)) {
          if (record.bucket === true && executedHere.has(kept)) continue
          let set = reads.get(kept)
          if (set === undefined) {
            set = new Set()
            reads.set(kept, set)
          }
          for (const index of targets) set.add(index)
        }
      }
      for (const dir of record.dirReads) {
        for (const kept of dirPaths(dir)) {
          let set = dirReads.get(kept)
          if (set === undefined) {
            set = new Set()
            dirReads.set(kept, set)
          }
          for (const index of targets) set.add(index)
        }
      }
    }

    // Every test in this process shared the module instance that the load or
    // teardown touch came from. A service shard is the exception: it is not the
    // process the tests ran in, and its recorder opened a window for every test
    // title, so only a test that actually touched the service can observe what
    // it loaded.
    const service = resolved.header.role === 'service'
    shardObserverKeys.push(service ? touchedTests : null)
    shardObserverIndices.push(service ? null : new Set(allTests))
    for (const ref of [...resolved.load, ...resolved.teardown]) {
      let indices = loadShards.get(ref[0])
      if (indices === undefined) {
        indices = new Set()
        loadShards.set(ref[0], indices)
      }
      indices.add(shardIndex)
    }
  }

  const shardTests: number[][] = shardObserverKeys.map((keys, index) => {
    if (keys === null) return [...(shardObserverIndices[index] ?? [])].sort((a, b) => a - b)
    const out = new Set<number>()
    for (const key of keys) {
      const at = testIndex.get(key)
      if (at !== undefined) out.add(at)
    }
    return [...out].sort((a, b) => a - b)
  })

  // Correlated touches belong to the owner's test entry. If the owner was
  // non-green it is not in the map; do not invent a passing entry for it.
  for (const test of attributedTests) {
    const key = `${test.title}\u0000${test.file ?? ''}\u0000${String(test.ordinal ?? 0)}`
    const index = testIndex.get(key)
    if (index === undefined) continue
    addTouches(index, test.touches)
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
  const indexed = (byFile: Map<string, Set<number>> | undefined): Record<string, number[]> => {
    const out: Record<string, number[]> = {}
    for (const file of [...(byFile?.keys() ?? [])].sort()) {
      out[file] = [...byFile!.get(file)!].sort((a, b) => a - b)
    }
    return out
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
    reads: indexed(reads),
    dirReads: indexed(dirReads),
    ...(opaque.size === 0 ? {} : { opaque: indexed(opaque) }),
    seen: [...seen].sort(),
    shards: included,
    dirty: options.dirty === true,
    ...(partial.size === 0 ? {} : { partial: [...partial].sort() }),
    ...(unhealthy.length === 0 ? {} : { unhealthy }),
  }
}

/**
 * Carries the tests an incremental build did not re-run into the new map.
 *
 * **Only evidence that is provably still true is carried.** Unchanged evidence is
 * carried as before. A touched function in a changed file is carried when its line
 * range maps exactly through the diff (`relocate`); module-scope entries and
 * functions the change overlaps are not. Reads and directory listings are
 * path-level, so a changed read file does not invalidate them. Whatever cannot be
 * carried is dropped and poisoned below: it must have been selected by the change
 * and re-recorded, and if it was not, the map says so instead of guessing.
 *
 * **A dropped test poisons what it used.** Every file it touched or read, and every
 * directory it listed, is added to `partial`; a later change to any of them forces
 * `mode: all`. That is deliberately coarse — one dropped test can widen several
 * files — because the alternative is an incremental map that answers a moved line
 * with the wrong tests.
 *
 * **A poisoned file stays poisoned.** If `base` is itself incremental, the tests it
 * could not carry are absent from `base.tests` and cannot be re-recorded here, so
 * this run cannot heal what `base` already admitted it did not know. Its `partial`
 * entries are carried forward; only a non-incremental build resets them.
 *
 * **A dropped opaque test keeps its declaration.** `recordOpaque` says the map
 * cannot name what the test depends on, so it must run on any change. No `partial`
 * entry can express that ("some other file changed"), so the entry survives with no
 * evidence at all: its line ranges and reads are dropped like any other dropped
 * test's, and the files it used are still poisoned.
 *
 * **Buckets are the new run's.** The base map's `@load`/`@between`/`@teardown`
 * refs and its `shardTests`/`loadShards` describe processes that no longer exist at
 * the new commit. Dropping them makes a module-scope change in a load-reached file
 * escalate to `all`, which is the safe direction and the price of not re-running
 * the suite.
 */
/**
 * Map an old-side line range through a diff when its bytes are provably unchanged.
 *
 * Every edit that ends above the range shifts it by `newCount - oldCount`; an edit
 * that overlaps the range means the range's content may have changed, and an
 * insertion point inside the range means the range grew or split. Either makes the
 * old evidence unusable, so the answer is `null` and the caller falls back to
 * `partial`.
 */
export function relocateRange(
  edits: readonly HunkEdit[],
  range: { start: number; end: number },
): { start: number; end: number } | null {
  let delta = 0
  for (const edit of edits) {
    if (edit.oldCount === 0) {
      // A pure insertion after `oldStart` (0 = before the first line).
      if (edit.oldStart < range.start) {
        delta += edit.newCount
        continue
      }
      if (edit.oldStart < range.end) return null
      continue
    }
    const oldEnd = edit.oldStart + edit.oldCount - 1
    if (edit.oldStart <= range.end && oldEnd >= range.start) return null
    if (oldEnd < range.start) delta += edit.newCount - edit.oldCount
  }
  return { start: range.start + delta, end: range.end + delta }
}

export function carryMap(
  base: CoverageMap,
  next: CoverageMap,
  changed: ReadonlySet<string>,
  relocate?: (
    file: string,
    range: { start: number; end: number },
  ) => { start: number; end: number } | null,
): CoverageMap {
  const keyOf = (test: TestEntry): string =>
    `${test.file ?? ''}\u0000${test.title}\u0000${String(test.ordinal ?? 0)}`
  const nextKeys = new Set(next.tests.map(keyOf))

  const addTo = (map: Map<number, Set<string>>, index: number, value: string): void => {
    let set = map.get(index)
    if (set === undefined) {
      set = new Set()
      map.set(index, set)
    }
    set.add(value)
  }

  // Evidence, indexed by base test. Built once, from the inverted map.
  const touchedByTest = new Map<number, Set<string>>()
  for (const [file, functions] of Object.entries(base.files)) {
    for (const entry of Object.values(functions)) {
      for (const index of entry.tests) addTo(touchedByTest, index, file)
    }
  }
  const readByTest = new Map<number, Set<string>>()
  for (const [file, indices] of Object.entries(base.reads ?? {})) {
    for (const index of indices) addTo(readByTest, index, file)
  }
  const dirByTest = new Map<number, Set<string>>()
  for (const [dir, indices] of Object.entries(base.dirReads ?? {})) {
    for (const index of indices) addTo(dirByTest, index, dir)
  }

  /**
   * Whether this test's evidence can be carried, and if so where it moved.
   *
   * The spec itself and line-based touches are the parts a change can invalidate.
   * A touched function on a changed file is carried only when its range maps
   * exactly; module-scope entries cannot (their range is the whole file). Reads and
   * directory listings are path-level: a test that read a changed file still
   * depends on it, so they do not block a carry.
   */
  const relocated = new Map<
    number,
    Array<{ file: string; key: string; startLine: number; endLine: number }>
  >()
  const canCarry = (test: TestEntry, index: number): boolean => {
    if (test.file !== null && changed.has(test.file)) return false
    const moved: Array<{ file: string; key: string; startLine: number; endLine: number }> = []
    for (const file of touchedByTest.get(index) ?? []) {
      if (!changed.has(file)) continue
      const functions = base.files[file]
      if (functions === undefined) return false
      for (const [key, entry] of Object.entries(functions)) {
        if (!entry.tests.includes(index)) continue
        if (key.startsWith('<module>')) return false
        const range = relocate?.(file, { start: entry.startLine, end: entry.endLine })
        if (range === undefined || range === null) return false
        moved.push({ file, key, startLine: range.start, endLine: range.end })
      }
    }
    relocated.set(index, moved)
    return true
  }

  const carried: number[] = []
  /**
   * Dropped tests that declared an invisible dependency (`recordOpaque`).
   *
   * Their evidence is stale and is not carried, but the declaration is the whole
   * answer for a test the map cannot see: dropping it would make the test vanish
   * from every future selection that is not about one of the files it happened to
   * touch. A `TestEntry` holds no evidence of its own, so re-adding the entry
   * carries the marker and nothing else.
   */
  const opaqueKept: number[] = []
  const opaqueByTest = new Map<number, string[]>()
  for (const [reason, indices] of Object.entries(base.opaque ?? {})) {
    for (const index of indices) {
      const reasons = opaqueByTest.get(index)
      if (reasons === undefined) opaqueByTest.set(index, [reason])
      else reasons.push(reason)
    }
  }

  // A base map can itself be incremental, and this run cannot heal what it could
  // not carry: a test missing from `base.tests` has no window to re-record. So its
  // `partial` markers survive. Dropping them let a chain of incremental builds
  // forget that a file's evidence was incomplete and answer a change to it with a
  // subset — the silent under-selection the whole design forbids.
  const partial = new Set([...(base.partial ?? []), ...(next.partial ?? [])])
  // Incompleteness cannot be healed by carrying tests forward: the missing window
  // was in the base's recording, and nothing here re-took it.
  const unhealthy = [...new Set([...(base.unhealthy ?? []), ...(next.unhealthy ?? [])])]
  for (const [index, test] of base.tests.entries()) {
    if (nextKeys.has(keyOf(test))) continue
    if (canCarry(test, index)) {
      carried.push(index)
      continue
    }
    if (test.file !== null) partial.add(test.file)
    for (const file of touchedByTest.get(index) ?? []) partial.add(file)
    for (const file of readByTest.get(index) ?? []) partial.add(file)
    for (const dir of dirByTest.get(index) ?? []) partial.add(dir)
    if (opaqueByTest.has(index)) opaqueKept.push(index)
  }

  // A file the base knew only through a load/teardown/between bucket has no
  // per-test evidence to carry. The buckets are not carried, so leaving it in
  // `seen` would answer a later change as "untested" (nothing runs) instead of
  // the safe `all`; poison it.
  const baseBucketFiles = new Set(
    [...base.load, ...base.between, ...base.teardown].map((ref) => ref[0]),
  )
  const nextBucketFiles = new Set(
    [...next.load, ...next.between, ...next.teardown].map((ref) => ref[0]),
  )
  for (const file of base.seen) {
    if (next.seen.includes(file) || nextBucketFiles.has(file)) continue
    if (baseBucketFiles.has(file)) partial.add(file)
  }
  if (base.dirty === true) {
    // Relocation compares base.commit with the worktree, but a dirty base's
    // ranges describe the dirty tree at that commit; a carried range can be
    // shifted twice. Poison the files rather than claim clean evidence.
    for (const moved of relocated.values()) {
      for (const entry of moved) partial.add(entry.file)
    }
  }

  const tests: TestEntry[] = [...next.tests]
  const newIndex = new Map<number, number>()
  for (const index of carried) {
    newIndex.set(index, tests.length)
    tests.push(base.tests[index]!)
  }
  const keptIndex = new Map<number, number>()
  for (const index of opaqueKept) {
    keptIndex.set(index, tests.length)
    tests.push(base.tests[index]!)
  }

  const cloneFunctions = (
    functions: Record<string, FunctionEntry>,
  ): Record<string, FunctionEntry> =>
    Object.fromEntries(
      Object.entries(functions).map(([key, entry]) => [
        key,
        { ...entry, tests: [...entry.tests] },
      ]),
    )
  const files: Record<string, Record<string, FunctionEntry>> = {}
  for (const [file, functions] of Object.entries(next.files)) files[file] = cloneFunctions(functions)

  const addEntry = (
    file: string,
    key: string,
    startLine: number,
    endLine: number,
    at: number,
  ): void => {
    const target = (files[file] ??= {})
    // The base and the new run were numbered by different builds, so an equal key
    // can name two different functions. A function is its name and range: reuse the
    // key of an entry that is the same function, otherwise take the next free
    // ordinal for the name rather than widening whatever already holds `key`.
    const name = key.slice(0, key.lastIndexOf('@'))
    const ordinalOf = (candidate: string): number =>
      Number(candidate.slice(candidate.lastIndexOf('@') + 1))
    let targetKey: string | undefined
    let free = 0
    for (const [candidate, entry] of Object.entries(target)) {
      if (candidate.slice(0, candidate.lastIndexOf('@')) !== name) continue
      if (entry.startLine === startLine && entry.endLine === endLine) targetKey = candidate
      free = Math.max(free, ordinalOf(candidate) + 1)
    }
    // The buckets are the new run's and keep their own keys. Selection joins a
    // function to them by `file\0key`, so a carried function must take the key its
    // bucket ref already uses, and a fresh ordinal must not collide with one.
    for (const bucket of [next.load, next.between, next.teardown]) {
      for (const [bucketFile, bucketKey, bucketStart, bucketEnd] of bucket) {
        if (bucketFile !== file || bucketKey.slice(0, bucketKey.lastIndexOf('@')) !== name) continue
        if (targetKey === undefined && bucketStart === startLine && bucketEnd === endLine) {
          targetKey = bucketKey
        }
        free = Math.max(free, ordinalOf(bucketKey) + 1)
      }
    }
    const existing = targetKey === undefined ? undefined : target[targetKey]
    if (existing === undefined) {
      target[targetKey ?? `${name}@${String(free)}`] = { startLine, endLine, tests: [at] }
      return
    }
    if (!existing.tests.includes(at)) existing.tests.push(at)
  }

  for (const [index, at] of newIndex) {
    const moved = relocated.get(index) ?? []
    for (const file of touchedByTest.get(index) ?? []) {
      if (changed.has(file)) {
        for (const entry of moved) {
          if (entry.file === file) addEntry(file, entry.key, entry.startLine, entry.endLine, at)
        }
        continue
      }
      const functions = base.files[file]
      if (functions === undefined) continue
      for (const [key, entry] of Object.entries(functions)) {
        if (!entry.tests.includes(index)) continue
        addEntry(file, key, entry.startLine, entry.endLine, at)
      }
    }
  }

  const merge = (
    from: Record<string, number[]> | undefined,
    byTest: Map<number, Set<string>>,
  ): Record<string, number[]> => {
    const out: Record<string, number[]> = {}
    for (const [path, indices] of Object.entries(from ?? {})) out[path] = [...indices]
    for (const [index, at] of newIndex) {
      for (const path of byTest.get(index) ?? []) {
        // Read and directory evidence is path-level: a test that read a changed
        // file still depends on it. Only line-based evidence needs relocation.
        ;(out[path] ??= []).push(at)
      }
    }
    for (const path of Object.keys(out)) out[path] = [...new Set(out[path]!)].sort((a, b) => a - b)
    return out
  }

  const opaque: Record<string, number[]> = {}
  for (const [reason, indices] of Object.entries(next.opaque ?? {})) opaque[reason] = [...indices]
  for (const [reason, indices] of Object.entries(base.opaque ?? {})) {
    for (const index of indices) {
      const at = newIndex.get(index) ?? keptIndex.get(index)
      if (at === undefined) continue
      ;(opaque[reason] ??= []).push(at)
    }
  }
  for (const reason of Object.keys(opaque)) {
    opaque[reason] = [...new Set(opaque[reason]!)].sort((a, b) => a - b)
  }

  return {
    version: next.version,
    commit: next.commit,
    builtAt: next.builtAt,
    ...((next.dirty === true || base.dirty === true) ? { dirty: true } : {}),
    tests,
    files,
    ...(Object.keys(opaque).length === 0 ? {} : { opaque }),
    reads: merge(next.reads, readByTest),
    dirReads: merge(next.dirReads, dirByTest),
    load: next.load,
    between: next.between,
    teardown: next.teardown,
    seen: [...new Set([...base.seen, ...next.seen])].sort(),
    shards: [...next.shards, `carried:${base.commit}`],
    ...(partial.size === 0 ? {} : { partial: [...partial].sort() }),
    ...(unhealthy.length === 0 ? {} : { unhealthy }),
    carried: { base: base.commit, tests: carried.length },
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
export function mapDir(
  root: string,
  commit: string,
  stateDir = '.cbd',
  mapsDir?: string,
): string {
  // `mapsDir` is the directory holding one subdirectory per commit. It may be
  // absolute — the case it exists for is a checkout shared by several worktrees —
  // and it replaces `<stateDir>/maps` rather than nesting under it.
  const base = mapsDir === undefined ? join(root, stateDir, 'maps') : resolve(root, mapsDir)
  return join(base, commit)
}

export function mapPath(
  root: string,
  commit: string,
  stateDir = '.cbd',
  mapsDir?: string,
): string {
  return join(mapDir(root, commit, stateDir, mapsDir), 'map.json')
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
    tests: map.tests.map((entry) => {
      if (entry.file === null) return entry
      const file = to(root, entry.file)
      // The id is `file::title`, so it has to move with the path. Leaving it
      // alone stored an absolute id even after the file itself was made
      // relative, so the map still named the recording machine's checkout.
      return {
        ...entry,
        file,
        ...(entry.id === undefined ? {} : { id: testId(file, entry.title) }),
      }
    }),
    files: Object.fromEntries(
      Object.entries(map.files).map(([file, functions]) => [to(root, file), functions]),
    ),
    ...(map.partial === undefined ? {} : { partial: map.partial.map((path) => to(root, path)) }),
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
    ...(map.reads === undefined
      ? {}
      : {
          reads: Object.fromEntries(
            Object.entries(map.reads).map(([file, tests]) => [to(root, file), tests]),
          ),
        }),
    ...(map.dirReads === undefined
      ? {}
      : {
          dirReads: Object.fromEntries(
            Object.entries(map.dirReads).map(([dir, tests]) => [to(root, dir), tests]),
          ),
        }),
    seen: map.seen.map((file) => to(root, file)),
  }
}

export function saveMap(
  root: string,
  map: CoverageMap,
  stateDir = '.cbd',
  mapsDir?: string,
): { path: string; bytes: number } {
  const dir = mapDir(root, map.commit, stateDir, mapsDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'map.json')
  const json = JSON.stringify(mapPaths(map, canonicalRoot(root), storePath))
  // Write beside the target and rename: a kill mid-write must not truncate the
  // only copy of the commit's map.
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, json)
  renameSync(temporary, path)
  return { path, bytes: Buffer.byteLength(json) }
}

export interface LoadedMap {
  map: CoverageMap
  path: string
  bytes: number
  /** Parse time, so the cost of reading a map can be weighed against rebuilding. */
  parseMs: number
}

export function loadMap(
  root: string,
  commit: string,
  stateDir = '.cbd',
  mapsDir?: string,
): LoadedMap {
  const path = mapPath(root, commit, stateDir, mapsDir)
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
