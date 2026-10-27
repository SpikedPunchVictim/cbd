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
import { isAbsolute, relative } from 'node:path'
import { intersects, type Change, type LineRange } from './changes.js'
import { testId } from './contract.js'
import { hashEnvValue } from './env.js'
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
  | 'always-unknown'
  | 'config-changed'
  | 'partial'
  | 'unhealthy'

export type Reason =
  | { kind: 'function'; file: string; fn: string; tests: number[] }
  | { kind: 'file'; file: string; tests: number[] }
  | { kind: 'test-file'; file: string; tests: number[] }
  | { kind: 'read'; file: string; tests: number[] }
  | { kind: 'opaque'; reason: string; tests: number[] }
  | { kind: 'always'; file?: string; tests: number[] }
  | { kind: 'shared-state'; file: string; tests: number[] }
  | { kind: 'env-changed'; keys: string[]; tests: number[] }
  | { kind: 'module-scope-unchanged'; file: string; typescript: string }
  | { kind: 'all'; why: AllWhy; file?: string }

/**
 * One test an `alwaysSelect` entry names: a file, or `file > title`.
 *
 * `file` is absolute by the time `select` sees it — the config loader resolves
 * repository-relative locators against the root, the same way it resolves globs.
 * `title` is the map's bare title, not a qualified describe path.
 */
export interface AlwaysSelectTest {
  file: string
  title?: string
}

/** A configured test (or whole test file) that every matching subset must include. */
export interface AlwaysSelectEntry {
  tests: AlwaysSelectTest[]
  /** Globs of changes that trigger the entry. Absent means any in-scope change. */
  when?: string[]
}

export interface MapInfo {
  commit: string
  /** Commits between the map's commit and HEAD. */
  distance: number
  dirty: boolean
  builtAt: string
}

/** Extensions of files that execute code, so coverage should have seen them. */
const CODE_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx|vue|svelte|astro)$/i

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
  /**
   * Changed files outside `include` (and not claimed by `alwaysAll` or an
   * `alwaysSelect.when`). They are not selected, but saying so distinguishes
   * "nothing changed" from "a change was deliberately out of scope" (`cbd-0na.6`).
   */
  ignored: string[]
  warnings: string[]
  map: MapInfo
}

export interface SelectConfig {
  include?: (path: string) => boolean
  alwaysAll?: string[]
  unknownPolicy?: 'all' | 'ignore'
  /**
   * Per-glob overrides for an unknown file. First matching entry wins; a file the
   * map knows still follows the normal rules.
   */
  unknownPolicyFor?: Array<{ paths: string[]; policy: 'all' | 'ignore' }>
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
  /** Tests every matching subset must also run, for oracles that read sources as text. */
  alwaysSelect?: AlwaysSelectEntry[]
  /**
   * Globs naming files whose module state tests share.
   *
   * A test that patches a module-level value and a test that observes it are a
   * pair: running one without the other is not a smaller run, it is a different
   * one. Coverage cannot see that, so the files are declared. When a change selects
   * any test that touched a listed file, every test that touched it is pulled in.
   * This is deliberately not inferred from the graph — a neighbour closure over
   * every shared module collapses to the whole suite.
   */
  sharedState?: string[]
  /**
   * The environment to compare declared variables against.
   *
   * Defaults to this process's. A library caller that selects for a run spawned
   * elsewhere passes the environment that run will see; the CLI passes nothing
   * because `collect` and `select` inherit it already.
   */
  env?: NodeJS.ProcessEnv
  /**
   * The config file this selection was made under, absolute.
   *
   * A change to it can change `include`, `alwaysAll`, `alwaysSelect` or the
   * policies, so a map built under the old config cannot answer for the new one.
   * The file is outside `include` in some repositories and used to be reported as
   * merely ignored (`cbd-73r.3`).
   */
  configFile?: string
  /**
   * The factory's canonical comparison result for the config file.
   *
   * A symlinked config, a case-insensitive filesystem or a `--config` outside
   * `--root` can spell the same file differently in the diff. The factory has
   * the filesystem access to compare real paths; `select` only sees strings.
   */
  configChanged?: boolean
  /**
   * Whether a changed path statically looks like it defines tests.
   *
   * A helper module can define tests through a function a spec calls; the map
   * attributes those tests to the registering spec, so the registry alone cannot
   * see the helper as a test file (`cbd-0na.3`). The factory supplies a reader; a
   * missing callback keeps the pre-existing registry-only behaviour.
   */
  definesTests?: (path: string) => boolean
  /**
   * Put the tests the change reaches most directly first.
   *
   * `'impact'` orders by reason: a changed function, then the file-level answer
   * (module scope), then a read, then a changed test file, then an opaque
   * declaration, then `alwaysSelect`. A consumer that runs entries in order fails
   * on the closest cause first. The selected set is unchanged; the default is map
   * order, so existing output stays stable.
   */
  order?: 'impact'
  /**
   * Opt-in compile-time check (`emitCheck` in the config): TypeScript files whose
   * module scope is proven unchanged. Absolute globs mapped to a tsconfig and a pinned compiler version; the
   * factory turns these into `moduleScopeUnchanged`. `select` never reads it.
   */
  emitCheck?: EmitCheckEntry[]
  /**
   * Files whose module scope did not change at runtime (computed by the layer that
   * reads git contents, see `emit-check.ts`). For such a file the hunks outside
   * every mapped function select nothing; function hunks, the load rule and the
   * unknown-file ladder are untouched.
   */
  moduleScopeUnchanged?: ReadonlyMap<string, string>
}

/**
 * One `emitCheck` entry: files matching `glob` are compared using `tsconfig`, and
 * only when the resolved compiler is exactly `typescript` (the version the tests run with).
 */
export interface EmitCheckEntry {
  glob: string
  tsconfig: string
  typescript: string
}

const DEFAULT_TEST_FILES = [
  '**/*.spec.*',
  '**/*.test.*',
  '**/__tests__/**',
  '**/tests/**',
]

/**
 * Does this text contain a test-registration call?
 *
 * A helper that defines tests through a shared function — `defineLedgerContract(test)`
 * called from a spec, with the `test(...)` calls living in the helper — registers
 * tests the map attributes to the spec. The helper therefore has no directly
 * defined tests and used to be answered as ordinary code, so a test added there was
 * neither selected nor warned about (`cbd-0na.3`).
 *
 * The scan is deliberately narrow and textual: the framework's registration name is
 * not knowable from a coverage map, and the cost of a false positive is a warning
 * plus the tests that touch the file, while a false negative is the silent miss.
 * A file that imports tests through an alias it invents will still fall through;
 * name that file in `alwaysSelect` if it matters.
 */
export function fileDefinesTests(text: string): boolean {
  return /(?:^|[^\w$.'"])(?:test|it|suite|describe)\s*(?:\.\s*(?:each|skip|only|todo|failing|concurrent)\s*)?\(/m.test(
    text,
  )
}

function uniqueSorted(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

/** How directly a reason reaches a test; lower runs first under `order: 'impact'`. */
const IMPACT: Record<Reason['kind'], number> = {
  function: 0,
  file: 1,
  read: 2,
  'test-file': 3,
  opaque: 4,
  always: 5,
  'shared-state': 6,
  'env-changed': 6,
  'module-scope-unchanged': 7,
  all: 7,
}

/**
 * The subset in map order, or by impact.
 *
 * A test can be selected by more than one reason; the most direct one is the one
 * that explains it. The sort is stable within a rank (by index), so an impact
 * order is deterministic and equal to map order when every reason is the same.
 */
function orderTests(selected: Set<number>, reasons: Reason[], order?: 'impact'): number[] {
  const tests = uniqueSorted(selected)
  if (order !== 'impact') return tests
  const rank = new Map<number, number>()
  for (const reason of reasons) {
    if (!('tests' in reason)) continue
    const value = IMPACT[reason.kind]
    for (const index of reason.tests) {
      const current = rank.get(index)
      if (current === undefined || value < current) rank.set(index, value)
    }
  }
  return tests.sort((a, b) => (rank.get(a) ?? 9) - (rank.get(b) ?? 9) || a - b)
}

/** Whether `path` is strictly below `dir`. */
function isUnder(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Case-folded path equality on the platforms whose filesystems ignore case. */
function samePath(a: string, b: string): boolean {
  return (
    a === b ||
    ((process.platform === 'darwin' || process.platform === 'win32') &&
      a.toLowerCase() === b.toLowerCase())
  )
}

/**
 * Whether every line in `[start, end]` is inside at least one function range.
 *
 * Ranges are sorted by start and may nest. The sweep advances a cursor over the
 * covered line; a gap means module scope.
 */
function fullyCovered(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  let cursor = start
  for (const range of ranges) {
    if (range.end < cursor) continue
    if (range.start > cursor) return false
    cursor = range.end + 1
    if (cursor > end) return true
  }
  return false
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
 *
 * **A hunk is not one thing.** git emits one hunk for contiguous changed lines,
 * and a rename plus the signature that uses it can put module scope and a
 * function's first line in the same hunk. Classifying the hunk only by whether
 * it intersects a function hid the module-scope part and selected just that
 * function's tests (`cbd-73r.1`). Both answers are recorded: the functions it
 * touches, and `outsideEveryFunction` when any changed line lies outside every
 * function.
 */
function functionsHit(
  change: Change,
  functions: Record<string, FunctionEntry>,
): { hit: Set<string>; outsideEveryFunction: boolean } {
  const hit = new Set<string>()
  let outsideEveryFunction = false
  const allRanges = Object.entries(functions)
    .map(([key, entry]) => ({ key, start: entry.startLine, end: entry.endLine }))
    .sort((a, b) => a.start - b.start)
  // The module body is a V8 entry whose range is the whole file. It is not a
  // function in the source: including it in the coverage check would call every
  // hunk "inside a function" and re-open the straddle miss. It stays in `hit`:
  // a test that dynamically imported the module can observe its exports.
  const functionRanges = allRanges.filter((range) => !range.key.startsWith('<module>'))

  // New-side line numbers shift relative to the map's old-side function ranges.
  // When a hunk changes the line count *and* contains a function's first line,
  // the new text may be module scope even though the old line was in the
  // function (e.g. a statement inserted above the declaration); there is no map
  // at the new commit to place it, so widen (`cbd-73r.1`).
  const oldLines = change.hunks.reduce((n, hunk) => n + (hunk.end - hunk.start + 1), 0)
  const newLines = change.newHunks?.reduce((n, hunk) => n + (hunk.end - hunk.start + 1), 0)
  const fileLineCountChanged = newLines !== undefined && newLines !== oldLines
  const edits = new Map<string, { oldCount: number; newCount: number }>()
  for (const edit of change.hunkEdits ?? []) {
    edits.set(`${String(edit.oldStart)}:${String(edit.oldCount)}`, edit)
  }

  for (const hunk of change.hunks) {
    for (const range of allRanges) {
      if (intersects(hunk, range)) hit.add(range.key)
    }
    if (!fullyCovered(hunk.start, hunk.end, functionRanges)) outsideEveryFunction = true
    // The file-wide totals cancel when one hunk deletes and another inserts
    // (`cbd-73r.1`); a hunk's own edit is what says it moved module scope.
    const edit = edits.get(`${String(hunk.start)}:${String(hunk.end - hunk.start + 1)}`)
    const lineCountChanged =
      edit === undefined ? fileLineCountChanged : edit.newCount !== edit.oldCount
    if (
      lineCountChanged &&
      functionRanges.some((range) => hunk.start <= range.start && range.start <= hunk.end)
    ) {
      outsideEveryFunction = true
    }
  }

  for (const point of change.insertions ?? []) {
    let matched = false
    for (const range of allRanges) {
      if (point >= range.start && point < range.end) hit.add(range.key)
    }
    for (const range of functionRanges) {
      if (point >= range.start && point < range.end) matched = true
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
  testsTouchingFile: (file: string) => number[],
  definesTests: (file: string) => boolean,
  seen: (file: string) => boolean,
  forceAll: (why: AllWhy, file: string) => void,
  selected: Set<number>,
  reasons: Reason[],
  warnings: string[],
  onLoadOnly: (path: string) => void,
): boolean {
  if (matchesAnyGlob(path, testFiles) === null) return false
  const direct = testsDefinedIn(path)
  // A helper that defines tests is a test file even though the map files those
  // tests under the spec that called it. A file the map has never seen stays on
  // the unknown-file path: its added tests must run, and `known` would drop them.
  const indirect = direct.length === 0 && seen(path) && definesTests(path)
  if (direct.length === 0 && !indirect) return false
  // Which tests to select under `known`: the registry answer when there is one,
  // otherwise every test that executed code in the defining file. That includes
  // tests registered elsewhere, which is over-selection — the safe direction.
  const tests = direct.length > 0 ? direct : testsTouchingFile(path)
  // A helper that defines tests but was only ever loaded has no per-test
  // evidence. Returning an empty `test-file` answer would skip the load rule and
  // select nothing; hand it back so the load observers (or `all`) answer instead.
  if (indirect && tests.length === 0) {
    onLoadOnly(path)
    return true
  }

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
  changedFiles: Change[],
  config: SelectConfig = {},
  mapInfo?: Partial<MapInfo>,
): Selection {
  // A rename is the old path going away and a new one appearing. The new path is
  // processed as itself; the old path's tests touched code that moved, so it is also
  // processed as a deletion. A copy keeps its source, so it adds nothing.
  const changes: Change[] = changedFiles.flatMap((change) =>
    change.status === 'R' &&
    change.from !== undefined &&
    !samePath(change.from, change.path) &&
    !(config.configFile !== undefined && samePath(change.from, config.configFile))
      ? [change, { path: change.from, status: 'D' as const, hunks: [] }]
      : [change],
  )
  const include = config.include ?? ((): boolean => true)
  const alwaysAll = config.alwaysAll ?? []
  const testFiles = config.testFiles ?? DEFAULT_TEST_FILES
  const testFilePolicy = config.testFilePolicy ?? 'known'
  const unknownPolicy = config.unknownPolicy ?? 'all'
  const betweenPolicy = config.betweenPolicy ?? 'all'
  const definesTests = config.definesTests ?? ((): boolean => false)

  const reasons: Reason[] = []
  const selected = new Set<number>()
  const unmapped: string[] = []
  const untested: string[] = []
  const ignored: string[] = []
  const warnings: string[] = []
  let forced = false

  const loadFiles = new Set(map.load.map((ref) => ref[0]))
  /** `file\0key` of every function that executed during import. */
  const loadFunctions = new Set(map.load.map((ref) => `${ref[0]}\u0000${ref[1]}`))
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
   * The tests that shared a module instance with `path` at load or teardown time.
   *
   * `undefined` means the map predates per-shard attribution and cannot say; the
   * caller answers `all` rather than guess.
   */
  const loadObservers = (path: string): number[] | undefined => {
    const shards = map.loadShards?.[path]
    if (shards === undefined || map.shardTests === undefined) return undefined
    return uniqueSorted(shards.flatMap((index) => map.shardTests![index] ?? []))
  }

  /**
   * Select the tests that loaded `path`, plus `extra`.
   *
   * A read answer is not a substitute: the module's exports belong to the
   * instance every test in the shard loaded, so removing one can break a test
   * that never read the file as text. A barrel has no function index, which is
   * how a read answer used to suppress the load answer entirely — the change
   * selected the file's readers and missed every other test that imported it.
   */
  const selectLoadObservers = (path: string, extra: number[]): void => {
    const observers = loadObservers(path)
    if (observers === undefined || observers.length === 0) {
      unmapped.push(path)
      forceAll('load', path)
      return
    }
    const tests = uniqueSorted([...observers, ...extra])
    for (const index of tests) selected.add(index)
    reasons.push({ kind: 'file', file: path, tests })
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
      selectLoadObservers(path, [])
    } else if (betweenFiles.has(path)) {
      unmapped.push(path)
      if (betweenPolicy === 'all') forceAll('between', path)
    } else if (seen.has(path)) {
      // Rule 6 — the map has evidence for this file and no test reaches it.
      untested.push(path)
    } else {
      unmapped.push(path)
      const index =
        config.unknownPolicyFor?.findIndex(
          (entry) => matchesAnyGlob(path, entry.paths) !== null,
        ) ?? -1
      const chosen = index === -1 ? unknownPolicy : config.unknownPolicyFor![index]!.policy
      if (chosen === 'all') {
        forceAll('unknown-file', path)
      } else if (index !== -1) {
        // The user asked for this glob to be ignored, but it is still a deliberate
        // decision and must be distinguishable from "outside include".
        ignored.push(path)
        warnings.push(
          `${path} is unknown to the map; ignored by unknownPolicyFor[${String(index)}] ` +
            `(${config.unknownPolicyFor![index]!.paths.join(', ')})`,
        )
      }
    }
  }

  /**
   * Whether a changed file the map has no function evidence for still needs the
   * rule ladder in `noTouches`, given that a read may already have answered it.
   *
   * A read answers a file that executes nothing (a fixture, a schema). A code file
   * coverage never saw is different: it means the recording was incomplete — code
   * imported before the adapter installed, say — and a read edge cannot prove such
   * a file unaffected. It goes to the unknown-file rule, so `unknownPolicy` and
   * `unknownPolicyFor` still decide, and the read reason is kept either way.
   */
  const needsLadder = (path: string, answeredByRead: boolean): boolean =>
    !answeredByRead ||
    loadFiles.has(path) ||
    teardownFiles.has(path) ||
    (!seen.has(path) && CODE_EXTENSION.test(path))

  // Rule 0 — the config itself. A config change means the map cannot answer for
  // any file, so it is checked before the loop and forces all once, naming the
  // config. Charging it to every changed file told a consumer that sources and
  // tests had changed the config, and skipped their own reasons.
  if (config.configChanged === true) forceAll('config-changed', config.configFile)

  for (const change of changes) {
    const path = change.path

    const isConfig =
      config.configFile !== undefined &&
      (samePath(path, config.configFile) ||
        (change.from !== undefined && samePath(change.from, config.configFile)))
    if (isConfig) {
      // The range-wide reason above already named the config. A caller that did
      // not set `configChanged` gets the per-file reason here instead.
      if (config.configChanged !== true) forceAll('config-changed', path)
      continue
    }

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

    if (!include(path)) {
      // A path an `alwaysSelect.when` claims is in scope for that entry, not
      // ignored; the factory passes it through include for exactly this reason.
      const claimed = (config.alwaysSelect ?? []).some(
        (entry) => entry.when !== undefined && matchesAnyGlob(path, entry.when) !== null,
      )
      if (!claimed) ignored.push(path)
      continue
    }

    // An incremental map carries only the tests whose evidence is provably
    // unchanged. For a file it could not carry, the old line ranges may have
    // moved, so the answer is the suite rather than a plausible subset.
    const partial = map.partial
    if (
      partial !== undefined &&
      partial.some((entry) => samePath(path, entry) || isUnder(path, entry))
    ) {
      unmapped.push(path)
      forceAll('partial', path)
      continue
    }

    // A shard whose window could not be taken recorded an empty capture for it, and
    // that window could have covered any file. The map cannot narrow an in-scope
    // change, so the whole suite is the only safe answer.
    if (map.unhealthy !== undefined && map.unhealthy.length > 0) {
      forceAll('unhealthy', path)
      continue
    }

    // A file the test read or listed. This answers an oracle that executes no
    // code in the file it checks — a source grep, a dependency scan, a tsc run —
    // and it composes with the function and test-file rules rather than replacing
    // them. Any change to the file reaches a reader; a file under a
    // listed directory reaches the lister.
    const readTests = map.reads?.[path] ?? []
    const dirTests = Object.entries(map.dirReads ?? {})
      .filter(([dir]) => isUnder(path, dir))
      .flatMap(([, tests]) => tests)
    const answeredByRead = readTests.length > 0 || dirTests.length > 0
    if (answeredByRead) {
      const tests = uniqueSorted([...readTests, ...dirTests])
      for (const index of tests) selected.add(index)
      reasons.push({ kind: 'read', file: path, tests })
    }

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
        testsTouchingFile,
        definesTests,
        (file) => seen.has(file),
        forceAll,
        selected,
        reasons,
        warnings,
        (helper) => noTouches(helper),
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
        if (loadFiles.has(path) || teardownFiles.has(path)) {
          // The module is gone: every test that loaded it can observe the
          // removal, not just the ones that executed one of its functions.
          selectLoadObservers(path, tests)
        } else if (betweenFiles.has(path) && betweenPolicy === 'all') {
          // Removing a file is at least as strong as editing its module scope.
          unmapped.push(path)
          forceAll('between', path)
        } else {
          for (const index of tests) selected.add(index)
          reasons.push({ kind: 'file', file: path, tests })
        }
      } else if (needsLadder(path, answeredByRead)) {
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
        // A function that also ran while the module was imported may have computed
        // a value any later test in that process consumes (a cached table, a
        // registered handler), so the tests that called it again are not the only
        // ones that can observe the change. `@teardown` runs after the tests and
        // cannot feed them, so only the load bucket counts here.
        if (loadFunctions.has(`${path}\u0000${key}`)) selectLoadObservers(path, entry.tests)
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
        // Module-scope state is not confined to the file's functions. A test can
        // compare a top-level binding without ever calling a function in the
        // module, so "the tests that touched the file" is not "the tests that can
        // observe it" (`cbd-0na.2`). The map attributes a `@load`/`@teardown`
        // touch to the tests in the process that produced it; those tests shared
        // the module instance and are the honest answer. A map built before that
        // attribution existed has no answer, and falls back to rule 2's `all`.
        const compiler = config.moduleScopeUnchanged?.get(path)
        if (compiler !== undefined) {
          // The compiler proved the file's module scope identical at runtime, so
          // these hunks cannot change what any test observed at load. A hunk in a
          // function the map never recorded is here too: no recorded test ran it.
          reasons.push({ kind: 'module-scope-unchanged', file: path, typescript: compiler })
        } else if (loadFiles.has(path) || teardownFiles.has(path)) {
          selectLoadObservers(path, testsTouchingFile(path))
        } else if (betweenFiles.has(path) && betweenPolicy === 'all') {
          unmapped.push(path)
          forceAll('between', path)
        } else {
          const tests = testsTouchingFile(path)
          if (tests.length > 0) {
            for (const index of tests) selected.add(index)
            reasons.push({ kind: 'file', file: path, tests })
          }
        }
      }
      continue
    }

    // Rules 2, 9, 7, 6 — see `noTouches`. A read answer is an answer for a file
    // the map never loaded; for one the suite did load, the load answer must
    // still run, because the read answer names only the tests that read the file
    // as data (see `selectLoadObservers`).
    if (needsLadder(path, answeredByRead)) noTouches(path)
  }

  // Always-select — tests that cannot appear in coverage, such as an oracle that
  // reads source files as text, or a repository-wide dependency-direction scan.
  // They are added after the per-file rules so a `when` glob can claim a change
  // that `include` would otherwise ignore. An entry the map cannot resolve is not
  // dropped: the list exists to prevent under-selection, so a stale entry runs
  // everything and says why (`cbd-0na.4`).
  // A no-`when` entry fires on any in-scope change, not on "no change at all":
  // a clean tree must stay a zero-test selection.
  const inScope = changes.some((change) => include(change.path))

  // Tests that declared an invisible dependency (`recordOpaque`) are selected by
  // any in-scope change. The marker is the only honest answer when a test spawns
  // a tool or drives a service: there is no path to match, and guessing from
  // coverage is exactly the failure the API exists to avoid.
  if (inScope) {
    for (const [reason, tests] of Object.entries(map.opaque ?? {})) {
      const indices = uniqueSorted(tests ?? [])
      if (indices.length === 0) continue
      for (const index of indices) selected.add(index)
      reasons.push({ kind: 'opaque', reason, tests: indices })
    }
  }

  for (const entry of config.alwaysSelect ?? []) {
    const triggered =
      entry.when === undefined
        ? inScope
        : changes.some((change) => matchesAnyGlob(change.path, entry.when!) !== null)
    if (!triggered) continue

    const indices: number[] = []
    const unknown: string[] = []
    for (const locator of entry.tests) {
      const matches: number[] = []
      map.tests.forEach((test, index) => {
        if (test.file !== locator.file) return
        if (locator.title !== undefined && test.title !== locator.title) return
        matches.push(index)
      })
      if (matches.length === 0) {
        unknown.push(locator.title === undefined ? locator.file : `${locator.file} > ${locator.title}`)
      } else {
        indices.push(...matches)
      }
    }

    if (unknown.length > 0) {
      warnings.push(
        `alwaysSelect names ${unknown.join(', ')}, which the map does not know; running every test`,
      )
      forceAll('always-unknown')
      continue
    }
    const tests = uniqueSorted(indices)
    for (const index of tests) selected.add(index)
    reasons.push({ kind: 'always', tests })
  }

  // Rule 12 — declared environment: `recordEnv` names the variables a test reads,
  // and the map keeps a hash of the value the recording saw. A value that has moved
  // since selects that test even though no file changed and coverage cannot see the
  // dependency. A variable the map has no hash for is left alone: an older map
  // cannot say what it used to be, and guessing would select on every run.
  if (!forced) {
    const environment = config.env ?? process.env
    for (const [index, test] of map.tests.entries()) {
      const recorded = test.env
      if (recorded === undefined || selected.has(index)) continue
      // Per test: another test's recorded value says nothing about this one. A test
      // seen under several values (one id from several shards) keeps all of them and
      // is selected only when the current value is none of them.
      const changed = Object.entries(recorded)
        .filter(
          ([key, hashes]) =>
            hashes.length > 0 && !hashes.includes(hashEnvValue(environment[key])),
        )
        .map(([key]) => key)
        .sort()
      if (changed.length === 0) continue
      selected.add(index)
      reasons.push({ kind: 'env-changed', keys: changed, tests: [index] })
    }
  }

  // Rule 11 — declared shared state: a test that depends on module state another
  // test mutates must not run without it, or a subset becomes a different run.
  // Coverage cannot see the dependency, so the list is declared; any test that
  // touched a listed file is pulled in when one selected test did.
  if (config.sharedState !== undefined && config.sharedState.length > 0 && !forced) {
    // A test pulled in through one file can touch another, so repeat until a pass
    // adds nothing; the result must not depend on the order of `map.files`.
    // Every rule that adds tests has run above, so they all feed this closure.
    for (let grew = true; grew; ) {
      grew = false
      // A file that ran only at import has no function entry, so it is also read
      // from the load bucket; its observers touched it. A map with no per-shard
      // attribution cannot say which, so that means every test.
      const candidates = new Set([...Object.keys(map.files), ...loadFiles])
      for (const file of candidates) {
        if (matchesAnyGlob(file, config.sharedState!) === null) continue
        const touched = new Set<number>()
        for (const entry of Object.values(map.files[file] ?? {})) {
          for (const index of entry.tests) touched.add(index)
        }
        if (loadFiles.has(file)) {
          for (const index of loadObservers(file) ?? map.tests.keys()) touched.add(index)
        }
        if (![...touched].some((index) => selected.has(index))) continue
        const added = uniqueSorted([...touched].filter((index) => !selected.has(index)))
        if (added.length === 0) continue
        for (const index of touched) selected.add(index)
        reasons.push({ kind: 'shared-state', file, tests: added })
        grew = true
      }
    }
  }

  // Rule 10 — a map that is dirty or far behind cannot be trusted to be complete.
  const info: MapInfo = {
    commit: mapInfo?.commit ?? map.commit,
    distance: mapInfo?.distance ?? 0,
    // The map records whether its own build ran on a dirty tree; a caller that
    // passes only the changes must not be told it was clean.
    dirty: mapInfo?.dirty ?? map.dirty === true,
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
    tests: forced ? [] : orderTests(selected, reasons, config.order),
    unmapped: [...new Set(unmapped)].sort(),
    untested: [...new Set(untested)].sort(),
    ignored: [...new Set(ignored)].sort(),
    warnings,
    map: info,
  }
}

export interface Miss {
  test: string
  file: string
  key: string
  /** The repeated-title discriminator, when the missed test has one. */
  ordinal?: number
}

/**
 * One test in the ground truth, identified the way the map identifies it.
 *
 * `id` is preferred when the caller has one (the map's canonical `<file>::<title>`).
 * Otherwise the tuple the map uses — file, title and ordinal — names exactly one
 * entry, which a bare title cannot do when a suite defines it twice.
 */
export interface GroundTruthTest {
  id?: string
  file: string | null
  title: string
  /** Absent for the first occurrence, as in `TestEntry`. */
  ordinal?: number
  touches: TouchRef[]
}

/**
 * A real recording of the same commit range, as either identity-aware entries or,
 * for callers that only have titles, a title → touches map.
 */
export type GroundTruth = Map<string, TouchRef[]> | readonly GroundTruthTest[]

export interface Verification {
  /** Tests that touched changed code and would not have been selected. */
  misses: Miss[]
  /** How many test/function pairs were checked. */
  checked: number
  /** True when the answer was `all`, so nothing could have been missed. */
  ranEverything: boolean
  /**
   * What the oracle wants the caller to know but does not fail.
   *
   * Today: a title-keyed truth matched more than one test. The check is then an
   * over-report — every matching entry must be selected — which is the safe
   * direction for an oracle, but the caller should migrate to `GroundTruthTest[]`
   * to name the one it means.
   */
  warnings?: string[]
}

const tupleKey = (file: string | null, title: string, ordinal: number): string =>
  `${file ?? ''}\u0000${title}\u0000${String(ordinal)}`

const pushIndex = (map: Map<string, number[]>, key: string, index: number): void => {
  const list = map.get(key)
  if (list === undefined) map.set(key, [index])
  else list.push(index)
}

/**
 * Checks a selection against what actually happened.
 *
 * `groundTruth` is from a real recording of the same commit range. Any test that
 * touched a changed range but is absent from the selection is a miss — the one
 * outcome that silently makes the suite lie. This is the number the project stands
 * or falls on.
 *
 * **Identity-aware truth is exact.** An entry naming an `id`, or a
 * `(file, title, ordinal)`, matches exactly the map entry it describes, so a miss on
 * the second of two same-titled tests is reported as its own miss.
 *
 * **Title-keyed truth answers in the safe direction.** A bare title cannot say which
 * duplicate it means, so *every* map entry with that title must be selected; a
 * missing one is a miss. That over-reports rather than masking, and a warning names
 * the titles so the caller can move to `GroundTruthTest[]`.
 */
export function verify(
  selection: Selection,
  map: CoverageMap,
  changes: Change[],
  groundTruth: GroundTruth,
): Verification {
  const warnings: string[] = []
  const titleKeyed = groundTruth instanceof Map

  // Title-keyed truth matches by title; identity-aware truth by id, falling back to
  // the tuple. Built before the early return so ambiguous titles are reported even
  // when the answer was `all`.
  const indexOfTitle = new Map<string, number[]>()
  const indexOfId = new Map<string, number[]>()
  const indexOfTuple = new Map<string, number[]>()
  map.tests.forEach((test, index) => {
    pushIndex(indexOfTitle, test.title, index)
    pushIndex(indexOfId, test.id ?? testId(test.file, test.title), index)
    pushIndex(indexOfTuple, tupleKey(test.file, test.title, test.ordinal ?? 0), index)
  })
  if (titleKeyed) {
    const ambiguous = [...indexOfTitle]
      .filter(([, indices]) => indices.length > 1)
      .map(([title]) => title)
      .sort()
    if (ambiguous.length > 0) {
      warnings.push(
        `ground truth is keyed by title and the map has duplicate titles (${ambiguous.join(', ')}); ` +
          'every matching test is required, so this check may over-report. Pass identities instead.',
      )
    }
  }

  if (selection.mode === 'all') {
    return {
      misses: [],
      checked: 0,
      ranEverything: true,
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  const changedWithHunks = new Map<string, { ranges: LineRange[]; points: number[] }>()
  for (const change of changes) {
    // The ground truth is from the run at the NEW commit, so the oracle reads the
    // new side (the selector's `hunks` are deliberately the old side).
    const ranges = change.newHunks ?? change.hunks
    const points = change.newInsertions ?? change.insertions ?? []
    if (ranges.length === 0 && points.length === 0) continue
    changedWithHunks.set(change.path, { ranges, points })
  }

  const entries: GroundTruthTest[] = titleKeyed
    ? [...(groundTruth as Map<string, TouchRef[]>)].map(([title, touches]) => ({
        title,
        file: null,
        touches,
      }))
    : [...(groundTruth as readonly GroundTruthTest[])]

  const misses: Miss[] = []
  const seenMiss = new Set<string>()
  let checked = 0

  for (const entry of entries) {
    let matched = titleKeyed
      ? indexOfTitle.get(entry.title)
      : entry.id !== undefined
        ? indexOfId.get(entry.id)
        : indexOfTuple.get(tupleKey(entry.file, entry.title, entry.ordinal ?? 0))
    // `TestEntry.id` is `file::title`, so duplicates share it. An entry that also
    // names its ordinal is saying which of them it means; narrow to that one.
    if (!titleKeyed && entry.id !== undefined && entry.ordinal !== undefined) {
      matched = matched?.filter(
        (index) => (map.tests[index]?.ordinal ?? 0) === entry.ordinal,
      )
    }
    // An unknown test cannot be named by the selection, so it counts as missed
    // rather than being skipped — that is what "unmapped" costs.
    const targets = matched ?? []

    for (const [file, key, startLine, endLine] of entry.touches) {
      const change = changedWithHunks.get(file)
      if (change === undefined) continue
      const range = { start: startLine, end: endLine }
      const hit =
        change.ranges.some((hunk) => intersects(hunk, range)) ||
        // A new-side insertion point names content after that line; the boundary
        // belongs to the range it touches.
        change.points.some((point) => point >= startLine - 1 && point <= endLine)
      if (!hit) continue
      checked += 1

      const missed = targets.length === 0 ? [undefined] : targets
      for (const index of missed) {
        if (index !== undefined && selection.tests.includes(index)) continue
        const ordinal = index === undefined ? entry.ordinal : map.tests[index]?.ordinal
        const id = `${entry.title}\u0000${file}\u0000${key}\u0000${String(index ?? 'unknown')}`
        if (seenMiss.has(id)) continue
        seenMiss.add(id)
        misses.push({
          test: entry.title,
          file,
          key,
          ...(ordinal === undefined ? {} : { ordinal }),
        })
      }
    }
  }

  return {
    misses,
    checked,
    ranEverything: false,
    // A caller whose changes are in another coordinate space (repo-relative, or the
    // old side) matches nothing, and the empty misses would read as a clean pass. Say
    // that nothing was checked rather than let the silence be the verdict.
    ...(checked === 0 && changedWithHunks.size > 0 && entries.length > 0
      ? {
          warnings: [
            ...warnings,
            'no recorded touch matched the changed ranges: the changes must name the ' +
              "map's coordinate space (absolute paths under the map root, new side)",
          ],
        }
      : warnings.length === 0
        ? {}
        : { warnings }),
  }
}
