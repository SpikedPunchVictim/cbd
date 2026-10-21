/**
 * `createCbd(config)` — one factory, five verbs (ADR-0003).
 *
 * Config is bound once so the CLI, an MCP server and a library caller cannot drift
 * on which map they mean. Every verb returns plain JSON-serialisable data; rendering
 * is the caller's job, which is what keeps `cbd` from being a second implementation.
 *
 * **Collect is not here.** Running a test suite is process orchestration, so it lives
 * in the CLI (`cbd-pfu`); this module never imports `child_process` for anything but
 * git, which is a read of history rather than a run.
 *
 * **Verify takes outcomes as data.** Handing it a map of test title to recorded
 * touches keeps the miss count unit-testable and keeps spawning out of the core.
 *
 * State lives under `stateDir` (default `.cbd`): shards in `<stateDir>/shards`, maps
 * in `<stateDir>/maps/<commit>/map.json`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { changesSince, commitsSince, headCommit, mergeChanges, type Change } from './changes.js'
import { matchesAnyGlob } from './glob.js'
import {
  buildMap,
  functionsForTest,
  functionsInFile,
  carryMap,
  loadMap,
  saveMap,
  testsForFunction,
  testsForLine,
  mapPath,
  type LoadedMap,
  type TestEntry,
} from './map.js'
import {
  fileDefinesTests,
  select as selectCore,
  verify as verifyCore,
  type SelectConfig,
  type Selection,
  type Verification,
} from './select.js'
import { scanFromEnv } from './env.js'
import type { ScanOptions } from './normalize.js'
import type { ShardHeader, ShardInput, TouchRef } from './shard.js'
import { parseShard } from './shard.js'

export interface CbdConfig {
  /** Repository root: map keys, git, and the state directory are relative to it. */
  root: string
  /** Where shards and maps live, relative to `root`. Default `.cbd`. */
  stateDir?: string
  /**
   * Where per-commit map directories live, instead of `<stateDir>/maps`.
   *
   * Absolute paths are allowed and are the reason this exists: worktrees and
   * review sandboxes can share one recorded map by pointing at the git common
   * directory, while shards and the selection file stay local to each checkout.
   * A relative path is resolved against `root`.
   */
  mapsDir?: string
  /**
   * The config file the selection was loaded from, absolute. Set by the loaders;
   * a change to it forces `mode: all` because it changes what selection means.
   */
  configFile?: string
  /** Forwarded to `select`: include, alwaysAll, policies, testFiles, maxAgeCommits, strict. */
  select?: SelectConfig
}

export interface BuildOptions {
  /** Defaults to the repository's HEAD. */
  commit?: string
  /**
   * Shard paths. When omitted, every shard under `<stateDir>/shards` whose header
   * names the target commit is merged — the default that keeps a stale shard from
   * an earlier run out of a new map.
   */
  shards?: string[]
  /** Accept an interrupted shard (no `end` record). Default false. */
  partial?: boolean
  /** Include tests that did not pass. Default false; see `MapBuildOptions`. */
  includeNonGreen?: boolean
  /**
   * How to read the shards' byte ranges. Defaults to `scanFromEnv()` — the same
   * `CBD_PROJECTION_*`, `CBD_RELOCATE_*` and `CBD_INCLUDE` variables the recording
   * reads, because a v2 shard has no paths and the build is where they are applied
   * (ADR-0002).
   */
  scan?: ScanOptions
  /**
   * Carry untouched tests forward from an earlier map instead of requiring a full
   * re-record. Default false; `base` chooses the map, otherwise the nearest one.
   */
  incremental?: boolean
  /** The map commit to carry from. Only meaningful with `incremental`. */
  base?: string
}

export interface BuildResult {
  commit: string
  path: string
  bytes: number
  tests: number
  files: number
  shards: string[]
  /** Present when the map carried tests forward; `partial` is how many files it could not. */
  incremental?: { base: string; carried: number; partial: number }
}

export interface SelectOptions {
  /** Default: the map's own commit. `worktree` chooses the other end. */
  since?: string
  /** Diff the map against the working tree (default) or against HEAD. */
  worktree?: boolean
  /** Make a stale or dirty map force `mode: all` (overrides the config). */
  strict?: boolean
  /** Map commit to load. Defaults to HEAD. */
  commit?: string
  /**
   * Answer for these changes instead of diffing the tree.
   *
   * Paths are absolute, as the map's are; `hunks` are old-side. This is what a
   * read-only what-if needs: no edit, no checkout, no clean tree to restore. The
   * map and its staleness checks still apply — a what-if is not a second way to
   * skip them.
   */
  changes?: Change[]
}

export interface MapSummary {
  commit: string
  builtAt: string
  dirty: boolean
  path: string
  bytes: number
  /** Commits between the map's commit and HEAD, the number `maxAgeCommits` reads. */
  distance: number
  shards: string[]
  /** Tests the map holds, so a subset can be stated as "N of M" without the map. */
  tests: number
}

export interface SelectResult {
  selection: Selection
  /**
   * The changes the selection considered — the config's `include`/`exclude`
   * applied, since a file outside the project is not this selection's question.
   * Anything dropped by that scope filter is named in `selection.ignored`, so a
   * consumer can tell "nothing changed" from "a change I was told to ignore".
   */
  changes: Change[]
  map: MapSummary
  /**
   * The tests the selection names, resolved against the map it was made from.
   *
   * `selection.tests` are indices into `map.tests`, which is the right identity for
   * a caller that already holds the map. A consumer that only has the result — the
   * CLI rendering titles, a selection file an adapter reads, an editor asking what
   * a change would run — would otherwise have to re-read and re-parse the map for
   * data this call had in hand. Empty when the mode is `all`, matching `tests`.
   */
  selected: TestEntry[]
  /**
   * What the answer costs, from the durations the recording kept.
   *
   * `known` is false for a map recorded before durations were stored, and for a
   * test whose duration the runner did not report: zero would otherwise read as
   * "free". `totalMilliseconds` is the whole map, so the saving is the difference
   * and a consumer does not have to re-read the map to compute it.
   */
  estimate: {
    /** Sum of the selected tests' recorded durations. */
    milliseconds: number
    /** Sum over every test the map knows. */
    totalMilliseconds: number
    known: boolean
  }
}

export interface ExplainTarget {
  file: string
  /** 1-based line in the file the map was recorded from. */
  line?: number
}

export interface ExplainResult {
  file: string
  seen: boolean
  line?: number
  /** Files reached only by a bucket escalate under §8.3; say which one it is. */
  buckets: Array<'load' | 'between' | 'teardown'>
  functions: Array<{ key: string; startLine: number; endLine: number; tests: string[] }>
  /** Tests that reach the line, or the file when no line is given. */
  tests: string[]
}

export interface ReachesResult {
  /** The test the query resolved to. */
  test: { title: string; file: string | null }
  target: ExplainTarget
  /** The file is one the map has any evidence for (unknown means select runs all). */
  seen: boolean
  /**
   * True when the test executed a mapped function of the file. With a line, true
   * when it covers that line — or, for a line outside every function, when it
   * touched the file at all, which is §8.3 rule 5's file-level answer.
   */
  reaches: boolean
  /** The functions of the target file this test executed. */
  functions: Array<{ key: string; startLine: number; endLine: number }>
  /** Every file the test reached, sorted — the whole answer to "what does this test cover?". */
  files: string[]
}

/** A file's size in the map: how many functions it has, and how many tests reach it. */
export interface FileStat {
  file: string
  tests: number
  functions: number
}

export interface StatsResult {
  map: MapSummary
  tests: number
  /** Mapped functions — functions at least one test executed. */
  functions: number
  /** Files with at least one function some test reached. */
  files: number
  /** Files the map has any evidence for, including ones no test reaches. */
  seen: number
  /** Seen files no test reaches: §8.3 rule 6's answer. */
  untested: number
  /**
   * Which files those are, sorted. The count without the names is a statistic;
   * the names are the inverse map's other half — the code no test covers.
   *
   * The map can only name a file it has *seen*. A source file no process ever
   * loaded is absent here and indistinguishable from one the map has never heard
   * of, which `select` answers with a full run rather than an empty one.
   */
  untestedFiles: string[]
  buckets: { load: number; between: number; teardown: number }
  /** Tests per test file: the widest file is how close a change gets to `all`. */
  testFiles: { files: number; median: number; p90: number; max: number }
  /** Mapped functions per reached file. */
  functionsPerFile: Quantiles
  /** Tests per mapped function: how wide one function's blast radius is. */
  testsPerFunction: Quantiles
  /** The files reached by the most tests, widest first (at most ten). */
  topFiles: FileStat[]
  /**
   * `(file, title)` groups that carry an ordinal, newest first.
   *
   * A duplicate title is not an error, but a renamed one shifts the ordinals, so
   * the list is part of reading a map (`cbd-gkj`).
   */
  duplicateTests: Array<{ title: string; file: string | null; count: number }>
}

export interface Quantiles {
  median: number
  p90: number
  max: number
}

/** One row of a batch reaches query: a file and the mutated line range. */
export interface ReachRow {
  /** Repository-relative or absolute. */
  file: string
  /** 1-based, inclusive, in the map's coordinates. */
  start: number
  /** Inclusive; defaults to `start`. */
  end?: number
}

export interface ReachRowResult {
  file: string
  start: number
  end: number
  /** Whether the map has any evidence for the file; false means select answers `all`. */
  seen: boolean
  /** The tests that executed a line in the range, in map order. */
  tests: TestEntry[]
}

export interface Cbd {
  build(options?: BuildOptions): BuildResult
  select(options?: SelectOptions): SelectResult
  explain(target: ExplainTarget | string): ExplainResult
  /**
   * Does one test reach a file, or a line in it? The inverse of `explain`.
   *
   * A bare title that names more than one test is refused rather than guessed at;
   * `file` disambiguates. This is the question a developer asks about a test they
   * are looking at, and it is also what a mutation tool asks about a mutant.
   */
  reaches(
    test: string,
    target: ExplainTarget | string,
    options?: { commit?: string; file?: string },
  ): ReachesResult
  /** The tests that reach any line of each row, for a mutation tool's batch query. */
  reachesRows(rows: readonly ReachRow[], options?: { commit?: string }): ReachRowResult[]

  stats(options?: { commit?: string }): StatsResult
  /** Pure: no suite is run, the outcomes are supplied. */
  verify(selection: Selection, changes: Change[], outcomes: Map<string, TouchRef[]>): Verification
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

/**
 * The nearest ancestor of HEAD with a map — CBD.md §9.4's rule — or `undefined`.
 *
 * Exported because `cbd collect` has to ask the same question for a different
 * reason: it records before it selects, and on a repository's first run there is no
 * map and the honest answer is "record everything" rather than an error. Sharing
 * the search keeps the two callers from disagreeing about which map they mean.
 *
 * Bounded to the recent history a map could still answer for; an older one is stale
 * past any sensible `maxAgeCommits`.
 */
export function nearestMapCommit(
  root: string,
  stateDir = '.cbd',
  mapsDir?: string,
  exclude?: string,
): string | undefined {
  const canonical = realpathSync(resolve(root))
  const head = headCommit(canonical)
  let candidates: string[]
  try {
    candidates = git(canonical, ['rev-list', '--max-count=200', head]).trim().split('\n')
  } catch {
    candidates = [head]
  }
  for (const candidate of candidates) {
    if (
      candidate !== '' &&
      candidate !== exclude &&
      existsSync(mapPath(canonical, candidate, stateDir, mapsDir))
    ) {
      return candidate
    }
  }
  return undefined
}

/**
 * Whether the tree under this root has changes that are not the state directory.
 *
 * `.cbd` is a build artifact and normally gitignored; counting its untracked files
 * as a dirty tree would mark a clean recording dirty and warn on every selection.
 *
 * The pathspec scopes the answer to the project root: for a subdirectory root a
 * change in another package cannot affect this map. `git status` reports what it
 * does relative to the repository root regardless of the working directory, so the
 * root's own prefix is stripped before the state-directory comparison.
 */
function dirtyTree(root: string, stateDir: string): boolean {
  try {
    const out = git(root, ['status', '--porcelain', '--', '.'])
    // Strip the line ending, not whitespace: a path may end in a space.
    const top = git(root, ['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '')
    const prefix = relative(top, root)
    const state = stateDir.replace(/^\.\//, '').replace(/\/+$/, '')
    return out.split('\n').some((line) => {
      if (line.trim() === '') return false
      const path = line.slice(3)
      const local =
        prefix === '' || !path.startsWith(`${prefix}/`) ? path : path.slice(prefix.length + 1)
      return !local.startsWith(`${state}/`)
    })
  } catch {
    return false
  }
}

/** Whether `path` is `dir` or under it, both absolute. */
function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Warn when an `unknownPolicyFor` entry's globs match no file in the repository.
 *
 * The list has the same drift problem `alwaysSelect` does: a renamed directory
 * leaves a rule that never fires. This checks the tree, not the map, because the
 * entry exists precisely for files no recording has seen.
 */
function stalePolicyWarnings(
  root: string,
  entries: SelectConfig['unknownPolicyFor'],
): string[] {
  if (entries === undefined || entries.length === 0) return []
  let files: string[]
  try {
    const tracked = git(root, ['ls-files', '-z']).split('\u0000')
    const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split(
      '\u0000',
    )
    files = [...tracked, ...untracked]
      .filter((path) => path !== '')
      .map((path) => resolve(root, path))
  } catch {
    return []
  }
  return entries.flatMap((entry, index) =>
    files.some((file) => matchesAnyGlob(file, entry.paths) !== null)
      ? []
      : [`unknownPolicyFor[${String(index)}] matches no file in the repository; the globs may be stale`],
  )
}

/**
 * Whether a config outside `root` changed.
 *
 * `changesSince --relative` cannot see a path outside the project root, so a
 * `--config` in a monorepo parent (or above `--root`) was invisible to rule 0.
 * Ask git directly for that one path, from the top level. Compare against the
 * map's commit rather than a caller's base: the map was built under the config of
 * its own commit, so that is the config it can answer for. A config outside the
 * git repository cannot be compared and is left to the caller.
 */
function configChangedOutside(root: string, configFile: string, base: string): boolean {
  try {
    const top = git(root, ['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '')
    const rel = relative(top, configFile)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false
    const changed = git(top, ['diff', '--name-only', base, '--', rel]).replace(/\r?\n$/, '')
    if (changed !== '') return true
    const untracked = git(top, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      rel,
    ]).replace(/\r?\n$/, '')
    return untracked !== ''
  } catch {
    return false
  }
}

/** Every `.ndjson` under a directory, at any depth. */
function shardFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ndjson')) out.push(path)
    }
  }
  walk(dir)
  return out.sort()
}

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!
}

const quantilesOf = (values: number[]): Quantiles => ({
  median: quantile(values, 0.5),
  p90: quantile(values, 0.9),
  max: values.length === 0 ? 0 : Math.max(...values),
})

const titles = (entries: TestEntry[]): string[] => entries.map((entry) => entry.title)

export function createCbd(config: CbdConfig): Cbd {
  // Map keys are the paths a recorded process reported, and Node resolves module
  // URLs through symlinks; canonicalize the root the same way (`/tmp` -> `/private/tmp`).
  const root = realpathSync(resolve(config.root))
  const stateDir = config.stateDir ?? '.cbd'
  const mapsDir = config.mapsDir
  const shardsDir = join(root, stateDir, 'shards')

  /** git speaks repository-relative paths; the map is keyed absolutely. */
  const toAbsolute = (changes: readonly Change[]): Change[] =>
    changes.map((change) => ({
      ...change,
      path: resolve(root, change.path),
      ...(change.from === undefined ? {} : { from: resolve(root, change.from) }),
    }))

  /**
   * Re-read a diff in the line numbers of the commit it ends at.
   *
   * `select --since <base>` may be handed a base older than the map's commit.
   * Everything between the two is already recorded in the map, but the diff's
   * old side belongs to the base, and those lines have moved since. Matching
   * them against the map's function ranges names the wrong function and drops
   * the tests that reach the one that changed — the case where the map is a few
   * commits behind the base the caller named. The new side is the map's own
   * commit, so `newHunks` are the ranges the map can answer for; the old-side
   * insertions are dropped with them, and new-side insertions already appear as
   * new hunks.
   *
   * A deletion between the two commits removes a file the map's tree no longer
   * has, so there is nothing in the map to select for it.
   */
  const inMapCoordinates = (changes: readonly Change[]): Change[] =>
    changes
      .filter((change) => change.status !== 'D')
      .map((change) => ({
        ...change,
        hunks: change.newHunks ?? [],
        insertions: [],
      }))

  const readMap = (commit: string): LoadedMap => {
    try {
      return loadMap(root, commit, stateDir, mapsDir)
    } catch (error) {
      const expected = mapPath(root, commit, stateDir, mapsDir)
      throw new Error(
        `cbd: no map for ${commit} (looked for ${expected}). Record a run and build the map first.` +
          `\n  ${String(error)}`,
      )
    }
  }

  /**
   * The nearest ancestor of HEAD with a map, or an error naming where it looked.
   *
   * A developer selects between recordings, so HEAD is routinely a few commits past
   * the map; demanding a map at HEAD would make `select` fail exactly when it is
   * useful. The search itself is shared with `nearestMapCommit`, which `collect`
   * uses to decide whether this is a first recording.
   */
  const mapCommitForHead = (): string => {
    const found = nearestMapCommit(root, stateDir, mapsDir)
    if (found !== undefined) return found
    const head = headCommit(root)
    throw new Error(
      `cbd: no map in the last 200 commits of ${head} (looked under ${mapsDir === undefined ? join(root, stateDir, 'maps') : resolve(root, mapsDir)}).` +
        ' Record a run and build the map first.',
    )
  }

  const summarize = (loaded: LoadedMap): MapSummary => ({
    commit: loaded.map.commit,
    builtAt: loaded.map.builtAt,
    dirty: loaded.map.dirty === true,
    path: loaded.path,
    bytes: loaded.bytes,
    distance: commitsSince(root, loaded.map.commit),
    shards: loaded.map.shards,
    tests: loaded.map.tests.length,
  })

  return {
    build(options: BuildOptions = {}): BuildResult {
      const commit = options.commit ?? headCommit(root)
      const paths = options.shards ?? shardFiles(shardsDir)

      const inputs: ShardInput[] = []
      const skipped: string[] = []
      for (const path of paths) {
        const records = parseShard(readFileSync(path, 'utf8'), path, {
          allowIncomplete: options.partial === true,
        })
        const header = records[0] as ShardHeader
        // With an explicit list the caller chose the shards; with the default glob
        // the commit filter is what keeps another run's shard out of this map.
        if (options.shards === undefined && header.commit !== commit) {
          skipped.push(`${basename(path)} (commit ${header.commit})`)
          continue
        }
        inputs.push({ name: relative(root, path), records })
      }

      if (inputs.length === 0) {
        const where = options.shards === undefined ? ` under ${shardsDir} for ${commit}` : ''
        throw new Error(
          `cbd: no shards${where}. Record a run first` +
            (skipped.length === 0 ? '.' : `; skipped ${skipped.join(', ')}.`),
        )
      }

      const map = buildMap(inputs, {
        commit,
        dirty: dirtyTree(root, stateDir),
        includeNonGreen: options.includeNonGreen === true,
        scan: options.scan ?? scanFromEnv(),
      })
      let out = map
      let incremental: BuildResult['incremental']
      if (options.incremental === true) {
        const base =
          options.base ??
          nearestMapCommit(root, stateDir, mapsDir, commit)
        if (base !== undefined && base !== commit) {
          const earlier = readMap(base)
          // The shards describe the worktree, so the worktree is the right side of
          // the comparison even when `commit` names a commit: an uncommitted edit is
          // exactly what the recording just covered.
          const stateRoot = resolve(root, stateDir)
          const changed = new Set<string>()
          for (const change of toAbsolute(changesSince({ root, since: base }))) {
            if (inside(change.path, stateRoot)) continue
            changed.add(change.path)
            // A rename reports only its new path, which never existed at the base
            // commit. The old path is gone, so a test carried with evidence for it
            // would describe a file that no longer exists; treating it as changed
            // drops that evidence instead of resurrecting it.
            if (change.from !== undefined) changed.add(change.from)
          }
          out = carryMap(earlier.map, map, changed)
          incremental = {
            base,
            carried: out.carried?.tests ?? 0,
            partial: out.partial?.length ?? 0,
          }
        }
      }
      const saved = saveMap(root, out, stateDir, mapsDir)
      return {
        commit,
        path: saved.path,
        bytes: saved.bytes,
        tests: out.tests.length,
        files: Object.keys(out.files).length,
        shards: out.shards,
        ...(incremental === undefined ? {} : { incremental }),
      }
    },

    select(options: SelectOptions = {}): SelectResult {
      const commit = options.commit ?? mapCommitForHead()
      const loaded = readMap(commit)
      const since = options.since ?? loaded.map.commit
      const include = config.select?.include ?? ((): boolean => true)
      const alwaysAll = config.select?.alwaysAll ?? []
      // A change outside `include` is not this selection's question — unless a
      // rule claims it explicitly. `alwaysAll` has always survived the scope
      // filter (§8.3 rule 1); an `alwaysSelect.when` must too, or the entry could
      // never fire for a file outside include.
      const claimedByWhen = (config.select?.alwaysSelect ?? []).flatMap(
        (entry) => entry.when ?? [],
      )
      const stateRoot = resolve(root, stateDir)
      const allChanges =
        options.changes !== undefined
          ? [...options.changes]
          : mergeChanges(
              // A caller's base may predate the map's commit. Everything between
              // the two is already recorded in the map, but the diff's old side
              // is in the base's line numbers, which may have moved; project it
              // onto the side the map measured (its own commit) before matching
              // function ranges, or a moved function is named by its old lines
              // and its tests are dropped.
              toAbsolute(inMapCoordinates(changesSince({ root, since, to: loaded.map.commit }))),
              // The map's commit is the recording's own baseline. This leg is
              // always needed: it is the one that compares the map with the
              // worktree (or HEAD), whatever base the caller asked about.
              toAbsolute(
                changesSince({
                  root,
                  since: loaded.map.commit,
                  worktree: options.worktree !== false,
                }),
              ),
            )
              // Shards and maps are build artifacts. If the state directory is not
              // gitignored, its files would otherwise read as untracked source changes
              // and force a full run on every selection.
              .filter((change) => !inside(change.path, stateRoot))

      // A config above `--root` is outside the relative diff; ask git about it
      // directly, and add it as a change so rule 0 can fire.
      const configFile = config.configFile
      if (
        options.changes === undefined &&
        configFile !== undefined &&
        !inside(configFile, root) &&
        configChangedOutside(root, configFile, loaded.map.commit)
      ) {
        allChanges.push({ path: configFile, status: 'M', hunks: [], insertions: [] })
      }

      // A symlinked config, or one spelled with different case, is the same file
      // but not the same string. Compare real paths, which also makes the
      // outside-root synthetic change above match.
      // macOS and Windows are case-insensitive but case-preserving: the loaded
      // spelling and git's spelling can differ in case while naming one file.
      // Folding is only used for this comparison; a false positive forces all.
      const samePath = (a: string, b: string): boolean =>
        a === b ||
        ((process.platform === 'darwin' || process.platform === 'win32') &&
          a.toLowerCase() === b.toLowerCase())
      const isConfigPath = (path: string | undefined): boolean => {
        if (path === undefined || configFile === undefined) return false
        if (samePath(path, configFile)) return true
        try {
          return samePath(realpathSync(path), configFile)
        } catch {
          return false
        }
      }
      const configChanged =
        configFile !== undefined &&
        allChanges.some((change) => isConfigPath(change.path) || isConfigPath(change.from))

      const changes = allChanges.filter(
        (change) =>
          isConfigPath(change.path) ||
          isConfigPath(change.from) ||
          include(change.path) ||
          matchesAnyGlob(change.path, alwaysAll) !== null ||
          matchesAnyGlob(change.path, claimedByWhen) !== null,
      )
      const considered = new Set(changes)
      const ignored = allChanges
        .filter((change) => !considered.has(change))
        .map((change) => change.path)

      const definitions = new Map<string, boolean>()
      const definesTests = (path: string): boolean => {
        const cached = definitions.get(path)
        if (cached !== undefined) return cached
        let result = false
        try {
          result = fileDefinesTests(readFileSync(path, 'utf8'))
        } catch {
          // A deleted or unreadable file cannot be scanned; the rules below have
          // their own answer for it, and a miss here is an ordinary helper.
          result = false
        }
        definitions.set(path, result)
        return result
      }

      const info = summarize(loaded)
      const base = selectCore(loaded.map, changes, {
        ...config.select,
        definesTests,
        ...(config.configFile === undefined ? {} : { configFile: config.configFile }),
        ...(configChanged ? { configChanged: true } : {}),
        ...(options.strict === undefined ? {} : { strict: options.strict }),
      }, {
        commit: info.commit,
        distance: info.distance,
        dirty: info.dirty,
        builtAt: info.builtAt,
      })
      const stale = stalePolicyWarnings(root, config.select?.unknownPolicyFor)
      const selection: Selection = {
        ...base,
        // The factory's list is what the scope filter dropped; `select` adds the
        // paths an `unknownPolicyFor` entry deliberately ignored. Merge both.
        ignored: [...new Set([...ignored, ...base.ignored])].sort(),
        ...(stale.length === 0 ? {} : { warnings: [...base.warnings, ...stale] }),
      }
      const selected = selection.tests
        .map((index) => loaded.map.tests[index])
        .filter((entry): entry is TestEntry => entry !== undefined)
      const duration = (entry: TestEntry): number => entry.durationMs ?? 0
      const chosen = selection.mode === 'all' ? loaded.map.tests : selected
      return {
        selection,
        changes,
        map: info,
        selected,
        estimate: {
          milliseconds: chosen.reduce((sum, entry) => sum + duration(entry), 0),
          totalMilliseconds: loaded.map.tests.reduce((sum, entry) => sum + duration(entry), 0),
          known: chosen.length > 0 && chosen.every((entry) => entry.durationMs !== undefined),
        },
      }
    },

    explain(target: ExplainTarget | string): ExplainResult {
      const loaded = readMap(mapCommitForHead())
      const parsed = parseExplainTarget(target, root)
      const map = loaded.map
      const functions = functionsInFile(map, parsed.file).map((key) => {
        const entry = map.files[parsed.file]![key]!
        return {
          key,
          startLine: entry.startLine,
          endLine: entry.endLine,
          tests: titles(testsForFunction(map, parsed.file, key)),
        }
      })
      const union = new Set<string>()
      for (const fn of functions) for (const title of fn.tests) union.add(title)
      const tests =
        parsed.line === undefined
          ? [...union].sort()
          : titles(testsForLine(map, parsed.file, parsed.line))
      const buckets: ExplainResult['buckets'] = []
      if (map.load.some((ref) => ref[0] === parsed.file)) buckets.push('load')
      if (map.between.some((ref) => ref[0] === parsed.file)) buckets.push('between')
      if (map.teardown.some((ref) => ref[0] === parsed.file)) buckets.push('teardown')
      return {
        file: parsed.file,
        seen: map.seen.includes(parsed.file),
        ...(parsed.line === undefined ? {} : { line: parsed.line }),
        buckets,
        functions,
        tests,
      }
    },

    reaches(
      test: string,
      target: ExplainTarget | string,
      options: { commit?: string; file?: string } = {},
    ): ReachesResult {
      const loaded = readMap(options.commit ?? mapCommitForHead())
      const map = loaded.map
      const parsed = parseExplainTarget(target, root)
      const wanted =
        options.file === undefined
          ? undefined
          : isAbsolute(options.file)
            ? options.file
            : resolve(root, options.file)

      const candidates = map.tests
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.title === test)
        .filter(({ entry }) => wanted === undefined || entry.file === wanted)
      if (candidates.length === 0) {
        throw new Error(
          `cbd: no test titled "${test}"${wanted === undefined ? '' : ` in ${wanted}`} ` +
            'in this map; a test the recording did not run is not in the map',
        )
      }
      if (candidates.length > 1) {
        const where = candidates.map(({ entry }) => entry.file ?? '(no file)').join(', ')
        throw new Error(
          `cbd: "${test}" names ${String(candidates.length)} tests; pass --file to choose one ` +
            `of: ${where}`,
        )
      }

      const chosen = candidates[0]!
      const reached = functionsForTest(map, chosen.index)
      const inFile = reached.filter((fn) => fn.file === parsed.file)
      const functions = inFile.map(({ key, startLine, endLine }) => ({ key, startLine, endLine }))

      let reaches = functions.length > 0
      if (parsed.line !== undefined) {
        const line = parsed.line
        const inside = functions.some((fn) => line >= fn.startLine && line <= fn.endLine)
        if (!inside) {
          // Outside every function, the file-level rule answers: did this test
          // touch the file at all? (The map cannot say which test ran a bucket, so
          // "touched a function" is the available evidence.)
          const outsideEveryFunction = !Object.values(map.files[parsed.file] ?? {}).some(
            (entry) => line >= entry.startLine && line <= entry.endLine,
          )
          reaches = outsideEveryFunction && inFile.length > 0
        }
      }

      return {
        test: { title: chosen.entry.title, file: chosen.entry.file },
        target: parsed,
        seen: map.seen.includes(parsed.file),
        reaches,
        functions,
        files: [...new Set(reached.map((fn) => fn.file))].sort(),
      }
    },

    reachesRows(rows: readonly ReachRow[], options: { commit?: string } = {}): ReachRowResult[] {
      const loaded = readMap(options.commit ?? mapCommitForHead())
      const map = loaded.map
      return rows.map((row) => {
        const file = isAbsolute(row.file) ? row.file : resolve(root, row.file)
        const end = row.end ?? row.start
        // A test that executes the function containing any line of the range can
        // observe the mutation. A line outside every function is module scope, and
        // `testsForLine` answers it with the whole file's tests (§8.3 rule 5) —
        // every test that touched the file can observe the module's state. That is
        // wider than "reaches" for a module-scope row, but a mutation oracle is
        // asking what could kill the mutant, and missing a killer is the costly
        // direction.
        const reached = new Set<TestEntry>()
        for (let line = row.start; line <= end; line += 1) {
          for (const entry of testsForLine(map, file, line)) reached.add(entry)
        }
        return {
          file,
          start: row.start,
          end,
          seen: map.seen.includes(file),
          tests: map.tests.filter((entry) => reached.has(entry)),
        }
      })
    },

    stats(options: { commit?: string } = {}): StatsResult {
      const loaded = readMap(options.commit ?? mapCommitForHead())
      const map = loaded.map
      const perFile = new Map<string, number>()
      for (const test of map.tests) {
        if (test.file === null) continue
        perFile.set(test.file, (perFile.get(test.file) ?? 0) + 1)
      }
      const counts = [...perFile.values()]

      // The function index, read once for both the distributions and the inverse.
      let functions = 0
      const perFileFunctions: number[] = []
      const perFunctionTests: number[] = []
      const fileStats: FileStat[] = []
      for (const [file, byKey] of Object.entries(map.files)) {
        const keys = Object.keys(byKey)
        functions += keys.length
        perFileFunctions.push(keys.length)
        const touched = new Set<number>()
        for (const key of keys) {
          const entry = byKey[key]!
          perFunctionTests.push(entry.tests.length)
          for (const index of entry.tests) touched.add(index)
        }
        fileStats.push({ file, tests: touched.size, functions: keys.length })
      }
      fileStats.sort((a, b) => b.tests - a.tests || a.file.localeCompare(b.file))

      const untestedFiles = map.seen.filter((file) => map.files[file] === undefined)
      const byTitle = new Map<string, { title: string; file: string | null; count: number }>()
      for (const entry of map.tests) {
        const key = `${entry.title}\u0000${entry.file ?? ''}`
        const group = byTitle.get(key)
        if (group === undefined) byTitle.set(key, { title: entry.title, file: entry.file, count: 1 })
        else group.count += 1
      }
      const duplicateTests = [...byTitle.values()]
        .filter((group) => group.count > 1)
        .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
      return {
        map: summarize(loaded),
        tests: map.tests.length,
        functions,
        files: Object.keys(map.files).length,
        seen: map.seen.length,
        untested: untestedFiles.length,
        untestedFiles,
        buckets: {
          load: map.load.length,
          between: map.between.length,
          teardown: map.teardown.length,
        },
        testFiles: {
          files: perFile.size,
          median: quantile(counts, 0.5),
          p90: quantile(counts, 0.9),
          max: counts.length === 0 ? 0 : Math.max(...counts),
        },
        functionsPerFile: quantilesOf(perFileFunctions),
        testsPerFunction: quantilesOf(perFunctionTests),
        topFiles: fileStats.slice(0, 10),
        duplicateTests,
      }
    },

    verify(
      selection: Selection,
      changes: Change[],
      outcomes: Map<string, TouchRef[]>,
    ): Verification {
      return verifyCore(selection, readMap(selection.map.commit).map, changes, outcomes)
    },
  }
}

function parseExplainTarget(target: ExplainTarget | string, root: string): ExplainTarget {
  if (typeof target !== 'string') {
    return {
      file: isAbsolute(target.file) ? target.file : resolve(root, target.file),
      ...(target.line === undefined ? {} : { line: target.line }),
    }
  }
  const match = /^(.*?)(?::(\d+))?$/.exec(target)
  const file = match?.[1] ?? target
  const line = match?.[2] === undefined ? undefined : Number(match[2])
  return {
    file: isAbsolute(file) ? file : resolve(root, file),
    ...(line === undefined ? {} : { line }),
  }
}
