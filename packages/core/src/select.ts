/**
 * The selection rules, in CBD.md §8.3's order.
 *
 * Safe by default throughout: every case the map cannot answer for resolves to
 * `mode: all`, which costs the developer exactly what they pay today. The one
 * failure that is not merely wasteful is under-selection — silently running too
 * few tests — and the rules are ordered so that everything uncertain falls towards
 * running more.
 *
 * Two of them are worth calling out because they are easy to get backwards:
 *
 *   §8.3 rule 6 vs rule 7. A file the map has *seen* but no test reaches is
 *   `untested` — nothing is selected, because there is nothing to run. A file the
 *   map has *never seen* is `unknown-file` — everything runs, because V8 could not
 *   see it and the map has no opinion. Opposite answers, and `map.seen` is what
 *   keeps them apart.
 *
 *   §8.3 rule 2 vs rule 9. A file reached only by `@load`/`@teardown` is startup
 *   code and always forces `all`. A file reached only by `@between` is a separate
 *   policy knob, because out-of-window activity is common and often harmless.
 */
import { intersects, type Change } from './changes.js'
import { matchesAnyGlob } from './glob.js'
import type { CoverageMap, FunctionEntry } from './map.js'
import type { TouchRef } from './shard.js'

export type AllWhy =
  | 'always-all'
  | 'load'
  | 'unknown-file'
  | 'between'
  | 'stale-map'
  | 'no-map'
  | 'test-file'

export type Reason =
  | { kind: 'function'; file: string; fn: string; tests: number[] }
  | { kind: 'file'; file: string; tests: number[] }
  | { kind: 'test-file'; file: string; tests: number[] }
  | { kind: 'all'; why: AllWhy; file?: string }

export interface MapInfo {
  commit: string
  /** Commits between the map's commit and HEAD. */
  distance: number
  dirty: boolean
  builtAt: string
}

export interface Selection {
  mode: 'subset' | 'all'
  /**
   * Why. When `mode` is 'all' this still contains the per-file reasons gathered
   * before the escalation, so a reader can see both what forced the full run and
   * what the other changed files would have selected. `tests` stays empty in that
   * case, so there is no way to mistake a moot reason for an instruction.
   */
  reasons: Reason[]
  /** Indices into `map.tests`. Empty when `mode` is 'all'. */
  tests: number[]
  /** Changed files the map could not answer for. */
  unmapped: string[]
  /** Changed files the map knows no test reaches. */
  untested: string[]
  warnings: string[]
  map: MapInfo
}

export interface SelectConfig {
  include?: (path: string) => boolean
  alwaysAll?: string[]
  unknownPolicy?: 'all' | 'ignore'
  betweenPolicy?: 'all' | 'ignore'
  testFiles?: string[]
  /**
   * What a changed test file means. `known` (the default) selects the tests the map
   * already knows that file defines and warns that an added test cannot be named;
   * `all` forces the whole suite.
   *
   * The default is `known` because a changed spec is the ordinary way this
   * repository's commits land: 53 of the 79 measured commits in one week and 140 of
   * 253 in one month touch a stores spec, so forcing the suite on each would make
   * nearly every run a full one and give up the tool's whole benefit. The gap is
   * real and is not silent: the selection warns, and the replay/`verify` report an
   * unnameable test as `newTests` rather than counting it as a miss. `all` is the
   * opt-in for a team that would rather pay the run than reason about the gap.
   */
  testFilePolicy?: 'known' | 'all'
  /** Make a stale or dirty map force `mode: all` rather than merely warn. */
  strict?: boolean
  maxAgeCommits?: number
}

const DEFAULT_TEST_FILES = [
  '**/*.spec.*',
  '**/*.test.*',
  '**/__tests__/**',
  '**/tests/**',
]

function uniqueSorted(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

/**
 * Rules 4 and 5 for one known file: which mapped functions the change reaches,
 * and whether it reaches code the map cannot place at all.
 *
 * A pure insertion has no old-side lines, so it cannot be a hunk (`cbd-81h.1`).
 * Where it lands decides the answer: inside a mapped function, the inserted code
 * is that function's; anywhere else — between functions, at either end — it
 * could be read by anything in the file. An insertion after a function's closing
 * brace is top-level code, not the function's, hence `< endLine` rather than
 * `<=`.
 */
function functionsHit(
  change: Change,
  functions: Record<string, FunctionEntry>,
): { hit: Set<string>; outsideEveryFunction: boolean } {
  const hit = new Set<string>()
  let outsideEveryFunction = false

  for (const hunk of change.hunks) {
    let matched = false
    for (const [key, entry] of Object.entries(functions)) {
      if (intersects(hunk, { start: entry.startLine, end: entry.endLine })) {
        matched = true
        hit.add(key)
      }
    }
    if (!matched) outsideEveryFunction = true
  }

  for (const point of change.insertions ?? []) {
    let matched = false
    for (const [key, entry] of Object.entries(functions)) {
      if (point >= entry.startLine && point < entry.endLine) {
        matched = true
        hit.add(key)
      }
    }
    if (!matched) outsideEveryFunction = true
  }

  return { hit, outsideEveryFunction }
}

/**
 * Rule 3 — what a changed test file means. Returns true when it answered.
 *
 * A file that matches a test glob but defines no tests is not a test file: it is a
 * helper, and the map's function rules answer it (`cbd-e9l`). That is why the
 * registry, not the glob, decides whether this rule applies.
 */
function testFileChange(
  path: string,
  testFiles: string[],
  policy: 'known' | 'all',
  testsDefinedIn: (file: string) => number[],
  forceAll: (why: AllWhy, file: string) => void,
  selected: Set<number>,
  reasons: Reason[],
  warnings: string[],
): boolean {
  if (matchesAnyGlob(path, testFiles) === null) return false
  const tests = testsDefinedIn(path)
  if (tests.length === 0) return false

  if (policy === 'all') {
    // Not `unmapped`: the map can answer for the tests it knows. The policy
    // escalates because it cannot answer for the ones the edit may add.
    forceAll('test-file', path)
  } else {
    for (const index of tests) selected.add(index)
    reasons.push({ kind: 'test-file', file: path, tests })
    // The one gap `known` accepts, said out loud. It cannot know whether this edit
    // added a test; a developer who did is the one person who needs to hear it.
    warnings.push(
      `${path} is a changed test file; a test it adds is not in the map and will not ` +
        "be selected (testFilePolicy: 'all' runs everything)",
    )
  }
  return true
}

export function select(
  map: CoverageMap,
  changes: Change[],
  config: SelectConfig = {},
  mapInfo?: Partial<MapInfo>,
): Selection {
  const include = config.include ?? ((): boolean => true)
  const alwaysAll = config.alwaysAll ?? []
  const testFiles = config.testFiles ?? DEFAULT_TEST_FILES
  const testFilePolicy = config.testFilePolicy ?? 'known'
  const unknownPolicy = config.unknownPolicy ?? 'all'
  const betweenPolicy = config.betweenPolicy ?? 'all'

  const reasons: Reason[] = []
  const selected = new Set<number>()
  const unmapped: string[] = []
  const untested: string[] = []
  const warnings: string[] = []
  let forced = false

  const loadFiles = new Set(map.load.map((ref) => ref[0]))
  const teardownFiles = new Set(map.teardown.map((ref) => ref[0]))
  const betweenFiles = new Set(map.between.map((ref) => ref[0]))
  const seen = new Set(map.seen)

  const forceAll = (why: AllWhy, file?: string): void => {
    forced = true
    reasons.push(file === undefined ? { kind: 'all', why } : { kind: 'all', why, file })
  }

  /** Tests that touched a file — the union over its functions. */
  const testsTouchingFile = (file: string): number[] => {
    const functions = map.files[file]
    if (functions === undefined) return []
    const out: number[] = []
    for (const entry of Object.values(functions)) out.push(...entry.tests)
    return uniqueSorted(out)
  }

  /**
   * Tests defined in a file, from the test registry rather than the function
   * index. §8.3 rule 3 wants *every test in that file*, and a spec's own
   * functions only appear in `map.files` if the spec was itself recorded as
   * source — which it usually is, but the registry is the direct answer.
   */
  const testsDefinedIn = (file: string): number[] => {
    const out: number[] = []
    map.tests.forEach((entry, index) => {
      if (entry.file === file) out.push(index)
    })
    return out
  }

  /**
   * Rules 2, 9, 7, 6 — the file has no per-test touches, so the map has nothing
   * to name and the answer is a policy question rather than an evidence one.
   *
   * Reached from two places: a deleted file the map never indexed, and an
   * ordinary file the map has no functions for. They must not drift apart —
   * both are asking the same question — so the ladder exists once, here.
   */
  const noTouches = (path: string): void => {
    if (loadFiles.has(path) || teardownFiles.has(path)) {
      unmapped.push(path)
      forceAll('load', path)
    } else if (betweenFiles.has(path)) {
      unmapped.push(path)
      if (betweenPolicy === 'all') forceAll('between', path)
    } else if (seen.has(path)) {
      // Rule 6 — the map has evidence for this file and no test reaches it.
      untested.push(path)
    } else {
      unmapped.push(path)
      if (unknownPolicy === 'all') forceAll('unknown-file', path)
    }
  }

  for (const change of changes) {
    const path = change.path

    // Rule 1 — a file the map cannot answer for by policy, and the first rule in
    // §8.3's table for a reason: `alwaysAll` is independent of `include`. The
    // documented config lists `**/migrations/**` there although `include` covers
    // only `src/**`; checking `include` first silently dropped every such change,
    // which is under-selection (cbd-0lu found it on the fixture's JSON data file).
    if (matchesAnyGlob(path, alwaysAll) !== null) {
      unmapped.push(path)
      forceAll('always-all', path)
      continue
    }

    if (!include(path)) continue

    // Rule 3 — a test file whose tests the registry can name. Under the default
    // `testFilePolicy: 'all'` the whole suite runs, because the map cannot name a
    // test the change *added* to this file; `'known'` is the opt-in fast path.
    //
    // A file that *matches* a test glob but defines no tests — a helper, a
    // fixture builder, a macro — is ordinary code. Treating it as a test file
    // asked the registry for its tests, got none, and escalated to `all` even
    // when the map had per-test evidence for it (`cbd-e9l`: measured as a
    // 26-point inflation of the all-rate on the target suite). Such a file falls
    // through to rules 4-6, which answer it from the map. A brand-new test file
    // is not in `seen` and still reaches `unknown-file` below, where `all` is the
    // right answer.
    if (
      testFileChange(
        path,
        testFiles,
        testFilePolicy,
        testsDefinedIn,
        forceAll,
        selected,
        reasons,
        warnings,
      )
    ) {
      continue
    }

    const inMap = map.files[path] !== undefined

    // Rule 8 — a deleted file: everything that used to touch it.
    // (Checked before the in-map branch, because the hunks of a deletion are
    // entirely old-side and would otherwise be matched against functions that
    // are themselves gone.)
    if (change.status === 'D') {
      if (inMap) {
        const tests = testsTouchingFile(path)
        for (const index of tests) selected.add(index)
        reasons.push({ kind: 'file', file: path, tests })
      } else {
        noTouches(path)
      }
      continue
    }

    if (inMap) {
      // Rules 4 and 5.
      const functions = map.files[path]!
      const { hit, outsideEveryFunction } = functionsHit(change, functions)

      for (const key of hit) {
        const entry = functions[key]!
        for (const index of entry.tests) selected.add(index)
        reasons.push({ kind: 'function', file: path, fn: key, tests: [...entry.tests] })
      }

      // A hunk outside every function — imports, top-level constants, a class
      // field initializer — could be read by anything in the file, so the whole
      // file's tests are the honest answer. The second clause is the fallback
      // for a change with no lines at all, such as a pure mode change — not for
      // an insertion, which has its own answer and may have matched a function.
      if (
        outsideEveryFunction ||
        (change.hunks.length === 0 && (change.insertions ?? []).length === 0)
      ) {
        const tests = testsTouchingFile(path)
        if (tests.length > 0) {
          for (const index of tests) selected.add(index)
          reasons.push({ kind: 'file', file: path, tests })
        }
      }
      continue
    }

    // Rules 2, 9, 7, 6 — see `noTouches`.
    noTouches(path)
  }

  // Rule 10 — a map that is dirty or far behind cannot be trusted to be complete.
  const info: MapInfo = {
    commit: mapInfo?.commit ?? map.commit,
    distance: mapInfo?.distance ?? 0,
    dirty: mapInfo?.dirty ?? false,
    builtAt: mapInfo?.builtAt ?? map.builtAt,
  }
  if (info.dirty) warnings.push('the map was built from a dirty tree')
  if (config.maxAgeCommits !== undefined && info.distance > config.maxAgeCommits) {
    warnings.push(
      `the map is ${info.distance} commits behind, older than maxAgeCommits (${config.maxAgeCommits})`,
    )
  }
  if (config.strict === true && warnings.length > 0) forceAll('stale-map')

  return {
    mode: forced ? 'all' : 'subset',
    reasons,
    tests: forced ? [] : uniqueSorted(selected),
    unmapped: [...new Set(unmapped)].sort(),
    untested: [...new Set(untested)].sort(),
    warnings,
    map: info,
  }
}

export interface Miss {
  test: string
  file: string
  key: string
}

export interface Verification {
  /** Tests that touched changed code and would not have been selected. */
  misses: Miss[]
  /** How many test/function pairs were checked. */
  checked: number
  /** True when the answer was `all`, so nothing could have been missed. */
  ranEverything: boolean
}

/**
 * Checks a selection against what actually happened.
 *
 * `groundTruth` is a test title to its touches, from a real recording of the same
 * commit range. Any test that touched a changed range but is absent from the
 * selection is a miss — the one outcome that silently makes the suite lie. This is
 * the number the project stands or falls on.
 */
export function verify(
  selection: Selection,
  map: CoverageMap,
  changes: Change[],
  groundTruth: Map<string, TouchRef[]>,
): Verification {
  if (selection.mode === 'all') {
    return { misses: [], checked: 0, ranEverything: true }
  }

  const changedWithHunks = new Map<string, Change>()
  for (const change of changes) {
    if (change.hunks.length > 0) changedWithHunks.set(change.path, change)
  }

  const indexOfTitle = new Map<string, number>()
  map.tests.forEach((test, index) => {
    if (!indexOfTitle.has(test.title)) indexOfTitle.set(test.title, index)
  })

  const misses: Miss[] = []
  const seenMiss = new Set<string>()
  let checked = 0

  for (const [title, touches] of groundTruth) {
    for (const [file, key, startLine, endLine] of touches) {
      const change = changedWithHunks.get(file)
      if (change === undefined) continue
      if (!change.hunks.some((hunk) => intersects(hunk, { start: startLine, end: endLine }))) {
        continue
      }
      checked += 1
      const index = indexOfTitle.get(title)
      // An unknown test cannot be named by the selection, so it counts as missed
      // rather than being skipped — that is what "unmapped" costs.
      if (index === undefined || !selection.tests.includes(index)) {
        const id = `${title}\u0000${file}\u0000${key}`
        if (!seenMiss.has(id)) {
          seenMiss.add(id)
          misses.push({ test: title, file, key })
        }
      }
    }
  }

  return { misses, checked, ranEverything: false }
}
