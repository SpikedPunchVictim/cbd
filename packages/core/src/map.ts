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
import {
  summarizeShard,
  type ShardRecord,
  type TouchRef,
} from './shard.js'

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
  /** Names of the shards merged in, for provenance. */
  shards: string[]
}

export interface ShardInput {
  name: string
  records: ShardRecord[]
}

export interface BuildOptions {
  commit: string
  builtAt?: string
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

export function buildMap(shards: ShardInput[], options: BuildOptions): CoverageMap {
  const tests: TestEntry[] = []
  const testIndex = new Map<string, number>()
  const files = new Map<string, Map<string, FunctionEntry>>()
  const load = new Map<string, TouchRef>()
  const between = new Map<string, TouchRef>()
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

  for (const shard of shards) {
    const summary = summarizeShard(shard.records)
    included.push(shard.name)
    mergeRefs(load, summary.load)
    mergeRefs(between, summary.between)

    for (const test of summary.tests) {
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

  return {
    version: MAP_VERSION,
    commit: options.commit,
    builtAt: options.builtAt ?? new Date().toISOString(),
    tests,
    files: sortedFiles,
    load: [...load.values()].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)),
    between: [...between.values()].sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)),
    shards: included,
  }
}

export function mapDir(root: string, commit: string): string {
  return join(root, '.cbd', 'maps', commit)
}

export function mapPath(root: string, commit: string): string {
  return join(mapDir(root, commit), 'map.json')
}

export function saveMap(root: string, map: CoverageMap): { path: string; bytes: number } {
  const dir = mapDir(root, map.commit)
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

export function loadMap(root: string, commit: string): LoadedMap {
  const path = mapPath(root, commit)
  const raw = readFileSync(path, 'utf8')
  const started = performance.now()
  const map = JSON.parse(raw) as CoverageMap
  const parseMs = performance.now() - started
  if (map.version !== MAP_VERSION) {
    throw new Error(`map at ${path} is version ${map.version}, expected ${MAP_VERSION}`)
  }
  return { map, path, bytes: Buffer.byteLength(raw), parseMs }
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
