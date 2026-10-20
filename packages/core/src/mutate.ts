/**
 * Mutation selection: which tests can observe a mutant at a file and line?
 *
 * This is the safety ladder from `select` applied to a mutant location
 * (ADR-0015). `testsForLine` is the function-level query beneath it, but it has
 * two gaps that matter here: it returns `[]` for a file not in `map.files`, and
 * it does not consult the `load`, `between` or `teardown` buckets. A mutation
 * runner that used it directly would silently run no tests for import-time code
 * or a file the map has seen but does not index.
 *
 * The contract is deliberately the same shape as a selection:
 *
 *   - `all` — run the whole suite (the mutant can reach code the map cannot
 *     attribute);
 *   - `subset` — run these tests;
 *   - `none` — no test reaches the mutant; report it as uncovered rather than
 *     running the suite.
 *
 * `none` is only returned for a file the map has genuinely seen and found
 * untested, a file whose tests define the oracle (a test file), or an unknown
 * file under `unknownPolicy: 'ignore'`. An unknown file defaults to `all`,
 * because a mutation runner that treats "no evidence" as "no tests" would score
 * an untested mutant as survived without ever trying to kill it.
 *
 * The map's `files` index only contains functions a *passing* test touched
 * (mergeShards). Mutation selection therefore requires a green baseline: a
 * failing test that could kill a mutant is not in the map. That is a property of
 * the map, not something this function can repair.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { CoverageMap, FunctionEntry, TestEntry } from './map.js'

export interface MutantTarget {
  /**
   * The mutated file. Relative paths are resolved against `policy.root`; map
   * keys are the absolute realpaths the recorded processes reported.
   */
  file: string
  /** 1-based, inclusive. */
  startLine: number
  /** 1-based, inclusive. Defaults to `startLine`. */
  endLine?: number
}

export interface MutantPolicy {
  /** Repository root for a relative `target.file`. Default: `process.cwd()`. */
  root?: string
  /**
   * What code executed outside any test window means. Default `all`, matching
   * `select`'s `betweenPolicy`. `ignore` is the opt-in fast path and can miss a
   * test that caused the execution.
   */
  betweenPolicy?: 'all' | 'ignore'
  /**
   * What a file the map has never seen means. Default `all`, matching
   * `select`'s `unknownPolicy`.
   */
  unknownPolicy?: 'all' | 'ignore'
}

export type MutantWhy =
  | 'unknown-file'
  | 'load'
  | 'teardown'
  | 'between'
  | 'untested'
  | 'function'
  | 'file'
  | 'test-file'

export interface MutantSelection {
  mode: 'all' | 'subset' | 'none'
  why: MutantWhy
  /** Empty for `all` and `none`; resolved `{ title, file }` entries for `subset`. */
  tests: TestEntry[]
}

/**
 * The tests that can observe a mutant at `target`.
 *
 * A mutant range that is entirely inside mapped functions selects the union of
 * those functions' tests — nested functions contribute all of their tests, as in
 * `testsForLine`. A range with any line outside every function is top-level
 * code: any test that touched the file could read it, so the file-level answer
 * is every test that touched the file.
 */
export function mutantTests(
  map: CoverageMap,
  target: MutantTarget,
  policy: MutantPolicy = {},
): MutantSelection {
  const root = policy.root ?? process.cwd()
  const file = canonical(root, target.file)
  const start = target.startLine
  const end = target.endLine ?? start
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) {
    throw new RangeError(
      `cbd: a mutant range must be 1-based and ordered (got ${String(start)}..${String(end)})`,
    )
  }

  // A mutant in a test file changes the oracle, not the program. Refuse rather
  // than run a meaningless selection.
  if (map.tests.some((test) => test.file !== null && canonical(root, test.file) === file)) {
    return { mode: 'none', why: 'test-file', tests: [] }
  }

  // Per-test function evidence wins over the file-level buckets. A module is in
  // `@load` because a test file imported it at start-up; a mutant inside one of
  // its functions is still killable by the tests that executed that function in
  // their own windows. This is the same distinction `select` makes: the buckets
  // answer a change the function index cannot place.
  const functions = map.files[file]
  if (functions !== undefined) {
    const entries = Object.values(functions)
    const intersecting = entries.filter((entry) => entry.startLine <= end && entry.endLine >= start)

    let everyLineCovered = true
    for (let line = start; line <= end; line += 1) {
      if (!entries.some((entry) => line >= entry.startLine && line <= entry.endLine)) {
        everyLineCovered = false
        break
      }
    }

    if (intersecting.length > 0 && everyLineCovered) {
      return { mode: 'subset', why: 'function', tests: testsOf(map, intersecting) }
    }
  }

  // The range is outside every mapped function (or the file has no per-test
  // evidence). Now the file-level rules apply, in the order `select` uses.
  if (fileSet(map.load).has(file)) return { mode: 'all', why: 'load', tests: [] }
  if (fileSet(map.teardown).has(file)) return { mode: 'all', why: 'teardown', tests: [] }
  if (fileSet(map.between).has(file)) {
    if ((policy.betweenPolicy ?? 'all') === 'all') {
      return { mode: 'all', why: 'between', tests: [] }
    }
    if (functions === undefined) return { mode: 'none', why: 'between', tests: [] }
  }

  if (functions !== undefined) {
    // Top-level code in a file the map can place: any test that touched the file
    // could read it.
    return { mode: 'subset', why: 'file', tests: testsOf(map, Object.values(functions)) }
  }

  if (!new Set(map.seen).has(file)) {
    return (policy.unknownPolicy ?? 'all') === 'all'
      ? { mode: 'all', why: 'unknown-file', tests: [] }
      : { mode: 'none', why: 'unknown-file', tests: [] }
  }

  // The map has evidence for the file but no passing test touched a function in
  // it. No test can be named; the mutation runner should report no coverage.
  return { mode: 'none', why: 'untested', tests: [] }
}

/** Map keys are realpaths; a relative target is resolved against the map root. */
function canonical(root: string, file: string): string {
  const absolute = isAbsolute(file) ? file : resolve(root, file)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function fileSet(refs: CoverageMap['load']): Set<string> {
  return new Set(refs.map((ref) => ref[0]))
}

/** Union of the tests an entry list touches, in map order and deduplicated. */
function testsOf(map: CoverageMap, entries: FunctionEntry[]): TestEntry[] {
  const indices = new Set<number>()
  for (const entry of entries) for (const index of entry.tests) indices.add(index)
  return [...indices]
    .sort((a, b) => a - b)
    .map((index) => map.tests[index])
    .filter((test): test is TestEntry => test !== undefined)
}
