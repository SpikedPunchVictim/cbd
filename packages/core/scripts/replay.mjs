/**
 * Replay — the miss count (`cbd-vqc`, `cbd-1uv`, `cbd-2jx`).
 *
 * Gate B answers "how often does a change force the whole suite" by applying one
 * map to historical diffs. It cannot answer the other half of the metric: does a
 * subset run ever miss a test the full run would have failed, or code the change
 * actually reached? That needs a run at every commit, not a read of one map.
 *
 * So this harness records one full run at a base commit (the map selection uses),
 * then for each commit in `base..head`:
 *
 *   1. checks the commit out and runs the caller's full recording command,
 *   2. builds an ORACLE map from that run — the commit's own coverage, which is
 *      independent of both the base map and the selector's arithmetic,
 *   3. selects against the base map with the base..commit diff,
 *   4. runs the selected tests (unless selection escalated to `all`), and
 *   5. compares the two runs:
 *
 *        coverage oracle   Required = tests that execute code intersecting the
 *                          commit's NEW-side hunks, in the commit's own map.
 *                          Miss = Required − Selected. (`cbd-1uv`)
 *        outcome oracle    F = tests that failed in the full run. F ⊆ Selected?
 *                          A test that failed in the subset but not in full is
 *                          reported separately — it is an order-dependence
 *                          artefact, not a miss. (`cbd-2jx`)
 *
 * **Why new-side lines.** The selector matches hunks against the map taken at
 * the OLD side, so `select` is fed `hunks` (old-side) by contract. The oracle
 * asks the opposite question against the NEW commit's map, so it uses
 * `newHunks`. Feeding the oracle the selector's coordinates would make it
 * measure the selector with the selector's own arithmetic.
 *
 * **Nothing here is repository-specific.** The checkout and the runs are the
 * caller's commands, run in the repository root. The harness supplies the
 * environment a recording needs (`CBD_SHARD`, `CBD_COMMIT`, and for the subset
 * run `CBD_SELECTION`) and interprets the shards that come back.
 *
 * **A full run that does not load is a step, not a crash.** An import error or a
 * missing build writes the shard header and dies, leaving no end record; cbd
 * refuses that shard, so there is no map and no test outcomes for either oracle.
 * The step is recorded as a load failure and the replay continues. The selector
 * is still checked against the map it would have used: with the base map it must
 * name every test the map knows, and the tests it omits are reported as
 * `unverified`; in commit mode the step reports that no commit map exists.
 *
 * Usage:
 *   node scripts/replay.mjs --repo <path> --base <commit> --state <dir> \
 *     --full-cmd "<cmd>" [--subset-cmd "<cmd>"] [--commits <n>] [--head <ref>] \
 *     [--prepare-cmd "<cmd>"] [--teardown-cmd "<cmd>"] [--patch <file>] \
 *     [--include <prefix,...>] [--always-all <glob,...>] [--json <out>] \
 *     [--selector-map base|commit] [--env KEY=VALUE ...] [--dry-run]
 *
 * The repository's committed `cbd.config.json` supplies the selection policy
 * (`include`, `testFiles`, `unknownPolicyFor`, `alwaysSelect`, ...). `--include`,
 * `--always-all` and `--test-files` override it for one run.
 *
 * The repository must be clean: the harness checks commits out in place. A
 * `--patch` is applied after each checkout, for a worktree whose recording
 * wiring is itself uncommitted (a clone with local wiring).
 *
 * `--full-cmd` must write a shard to `$CBD_SHARD`; `<shard>.service.ndjson` is
 * merged when the run wrote one. `--subset-cmd` defaults to `--full-cmd`.
 *
 * `--selector-map base` (the default) asks `select` against the map recorded at
 * the base commit, which is the one-map replay the miss count was built for.
 * `--selector-map commit` selects since the base against the **commit's own** map
 * instead: the base is older than the map, so the diff's new side is projected
 * onto the map's line numbers, exactly as `cbd select --since` does. That mode
 * measures the projection rather than the base map.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildMap,
  headCommit,
  loadConfig,
  matchesAnyGlob,
  parseUnifiedDiff,
  sameCommit,
  select,
  testsForLine,
  writeSelection,
} from '../dist/src/index.js'
import { parseShard, summarizeShard, IncompleteShardError } from '../dist/src/adapter.js'

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { env: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`)
    const key = arg.slice(2)
    if (key === 'dry-run') {
      options['dry-run'] = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`)
    if (key === 'env') options.env.push(value)
    else options[key] = value
    i += 1
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
for (const required of ['repo', 'base', 'state', 'full-cmd']) {
  if (options[required] === undefined) throw new Error(`replay: --${required} is required`)
}
const selectorMode = options['selector-map'] ?? 'base'
if (selectorMode !== 'base' && selectorMode !== 'commit') {
  throw new Error(`replay: --selector-map must be "base" or "commit", got ${selectorMode}`)
}

/**
 * Every path this harness compares is canonical.
 *
 * A map's keys are whatever the recorded process reported: on macOS a module URL
 * is the realpath (`/private/tmp/…`) while a configured projection prefix, and a
 * shell's `/tmp/…`, are not. `select` and the oracles compare map keys with diff
 * paths by string, so one spelling on either side turns a known file into an
 * unknown one — silently, in the escalating direction for selection and in the
 * missing-from-Required direction for the oracle. The repository is resolved once
 * and both the map and the diff are rewritten into its spelling.
 */
const repo = realpathSync(resolve(options.repo))
const repoSpellings = [...new Set([resolve(options.repo), repo])]
const canonical = (path) => {
  for (const spelling of repoSpellings) {
    if (path === spelling) return repo
    if (path.startsWith(`${spelling}/`)) return `${repo}/${path.slice(spelling.length + 1)}`
  }
  return path
}

/** Rewrite every path a `CoverageMap` carries into the canonical repository spelling. */
function canonicalMap(map) {
  const files = {}
  for (const [path, entries] of Object.entries(map.files)) files[canonical(path)] = entries
  map.files = files
  map.seen = [...new Set(map.seen.map(canonical))]
  for (const bucket of ['load', 'between', 'teardown']) {
    map[bucket] = map[bucket].map((ref) => [canonical(ref[0]), ref[1], ref[2], ref[3]])
  }
  map.tests = map.tests.map((test) => ({
    ...test,
    file: test.file === null ? null : canonical(test.file),
  }))
  return map
}

const state = resolve(options.state)
const head = options.head ?? 'HEAD'
const limit = options.commits === undefined ? Infinity : Number(options.commits)
if (!Number.isFinite(limit) && limit !== Infinity) throw new Error('replay: --commits must be a number')
if (limit <= 0) throw new Error('replay: --commits must be positive')

/** An absolute path prefix a change must be under to matter, comma separated. */
const includes = (options.include ?? repo)
  .split(',')
  .map((prefix) => canonical(resolve(prefix.trim())))
  .filter((prefix) => prefix !== '')
const isIncluded = (absolute) => includes.some((prefix) => absolute === prefix || absolute.startsWith(`${prefix}/`))

const alwaysAll = options['always-all'] === undefined ? [] : options['always-all'].split(',').map((g) => g.trim())
const DEFAULT_TEST_FILES = ['**/*.spec.*', '**/*.test.*', '**/__tests__/**', '**/tests/**']
const testFiles =
  options['test-files'] === undefined ? DEFAULT_TEST_FILES : options['test-files'].split(',').map((g) => g.trim())

/**
 * The repository's own selection policy, from its committed `cbd.config.json`.
 *
 * A replay that ignored the config would answer a different question from the
 * product: take a repository whose config marks its tools directory as
 * `unknownPolicyFor: ignore` — without it every step whose cumulative diff touches the dev CLI
 * escalated to `all` — 20 of 20 steps, measuring the harness rather than the
 * selector. The CLI flags still win where they are given, so a caller can narrow
 * `--include` or override `--test-files` for a one-off question.
 */
const configured = (() => {
  try {
    return loadConfig(repo)?.config.select ?? {}
  } catch (error) {
    throw new Error(`replay: cannot read ${repo}/cbd.config.json: ${String(error)}`)
  }
})()

/** The policy both the scored and the load-failure paths select with. */
const selectConfig = {
  ...configured,
  include:
    options.include === undefined && configured.include !== undefined
      ? configured.include
      : (path) => isIncluded(path),
  ...(options['always-all'] === undefined ? {} : { alwaysAll }),
  ...(options['test-files'] === undefined ? {} : { testFiles }),
}

const extraEnv = Object.fromEntries(
  options.env.map((pair) => {
    const at = pair.indexOf('=')
    if (at <= 0) throw new Error(`replay: --env wants KEY=VALUE, got ${pair}`)
    return [pair.slice(0, at), pair.slice(at + 1)]
  }),
)

const fullCommand = options['full-cmd']
const subsetCommand = options['subset-cmd'] ?? fullCommand
const prepareCommand = options['prepare-cmd']
const teardownCommand = options['teardown-cmd']
const patch = options.patch === undefined ? null : resolve(options.patch)

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function run(command, env, logPath) {
  const started = Date.now()
  const result = spawnSync('/bin/sh', ['-c', command], {
    cwd: repo,
    env: { ...process.env, ...extraEnv, ...env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  const wall = (Date.now() - started) / 1000
  const text = `$ ${command}\n\n--- stdout ---\n${result.stdout ?? ''}\n--- stderr ---\n${result.stderr ?? ''}\n`
  writeFileSync(logPath, text)
  return { wall, status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Full SHA: the shard names the commit it was recorded at, and a tag is not one. */
const base = headCommit(repo, options.base)
const origin = headCommit(repo)
/** Where the worktree started. A branch must be restored by name, not by SHA. */
const originRef = (() => {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim()
  } catch {
    // A detached HEAD has no branch to return to; the SHA is the best there is.
    return origin
  }
})()
const dirty = git(['status', '--porcelain']).trim()
if (dirty !== '' && patch === null) {
  throw new Error(
    `replay: ${repo} has uncommitted changes and no --patch was given. The harness checks ` +
      'commits out in place; commit, stash, or capture the wiring as a patch first.',
  )
}

const commits = git(['rev-list', '--first-parent', '--reverse', `${base}..${head}`])
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '')
  .slice(0, limit === Infinity ? undefined : limit)

if (commits.length === 0) throw new Error(`replay: ${base}..${head} names no commits`)
if (!sameCommit(repo, base, `${commits[0]}^`)) {
  // Not fatal — a caller may replay a window that starts elsewhere — but the map
  // is taken at `base`, so a gap means the first diff spans more than one commit.
  process.stderr.write(`replay: note: the first replayed commit is not a child of ${base}\n`)
}

const plan = [{ commit: base, role: 'base' }, ...commits.map((commit) => ({ commit, role: 'replay' }))]

if (options['dry-run'] === true) {
  console.log(`base   ${base}`)
  for (const commit of commits) console.log(`replay ${commit}`)
  process.exit(0)
}

process.stdout.write(
  `replay: ${String(commits.length)} commit(s) ${base}..${head}\n` +
    `replay: in-place checkout, ${patch === null ? 'no patch' : `patch ${patch}`}\n`,
)

mkdirSync(state, { recursive: true })

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

function checkout(commit) {
  git(['checkout', '--quiet', '--detach', commit])
  if (patch !== null) {
    // `checkout` leaves a dirty tree behind if it can; applying on top of one
    // would fail obscurely, so the patch is the only change allowed here.
    const status = git(['status', '--porcelain']).trim()
    if (status !== '') git(['checkout', '--quiet', '--', '.'])
    git(['apply', patch])
  }
}

function prepare(commit, dir) {
  checkout(commit)
  if (prepareCommand !== undefined) {
    const prepared = run(prepareCommand, {}, resolve(dir, 'prepare.log'))
    if (prepared.status !== 0) {
      throw new Error(`replay: prepare-cmd failed at ${commit.slice(0, 8)}; see ${dir}/prepare.log`)
    }
  }
}

/** The merged map of a run: the parsed shard plus a service shard when one exists. */
function mapOf(records, shardPath, commit) {
  const shards = [{ name: shardPath, records }]
  const servicePath = shardPath.replace(/\.ndjson$/, '.service.ndjson')
  if (existsSync(servicePath)) {
    shards.push({
      name: servicePath,
      records: parseShard(readFileSync(servicePath, 'utf8'), servicePath),
    })
  }
  return canonicalMap(buildMap(shards, { commit }))
}

/**
 * The full run's records, or `null` when the run wrote no complete shard.
 *
 * A suite that fails at import time writes the header and dies, so the recorder
 * never writes its end record; an interrupted run looks the same. Either way the
 * step has no map and no test outcomes, which the caller reports as a load
 * failure rather than letting one step abort the whole replay.
 *
 * A shard that was never written at all is a harness or wiring mistake, not a
 * property of the commit, so it stays fatal.
 */
function fullRunRecords(shardPath) {
  if (!existsSync(shardPath)) {
    throw new Error(`replay: ${shardPath} was not written; --full-cmd must record to $CBD_SHARD`)
  }
  try {
    return parseShard(readFileSync(shardPath, 'utf8'), shardPath)
  } catch (error) {
    if (error instanceof IncompleteShardError) return null
    throw error
  }
}

/** The `mode: all` reasons in the console and report spelling. */
function allReasons(selection) {
  return [
    ...new Set(
      selection.reasons
        .filter((reason) => reason.kind === 'all')
        .map(
          (reason) =>
            `${reason.why}${reason.file === undefined ? '' : `:${reason.file.replace(`${repo}/`, '')}`}`,
        ),
    ),
  ]
}

function runTests(dir, shardPath, commit, selectionPath) {
  const env = {
    CBD_SHARD: shardPath,
    CBD_COMMIT: commit,
    ...(selectionPath === undefined ? {} : { CBD_SELECTION: selectionPath }),
  }
  const logName = selectionPath === undefined ? 'full.log' : 'subset.log'
  return run(selectionPath === undefined ? fullCommand : subsetCommand, env, resolve(dir, logName))
}

// ---------------------------------------------------------------------------
// Oracle helpers
// ---------------------------------------------------------------------------

/**
 * The diff between the base map's commit and `commit`, with abs paths.
 *
 * `git diff base commit` puts the base on the old side, which is the map's
 * coordinate system — exactly what `select` needs. `newHunks` carries the other
 * side for the oracle.
 */
function changesBetween(commit) {
  const diff = git([
    'diff',
    '--unified=0',
    '--find-renames',
    '--no-color',
    '--no-ext-diff',
    '--relative',
    base,
    commit,
  ])
  return parseUnifiedDiff(diff)
    .filter((change) => isIncluded(resolve(repo, change.path)))
    .map((change) => ({
      ...change,
      path: resolve(repo, change.path),
      ...(change.from === undefined ? {} : { from: resolve(repo, change.from) }),
      ...(change.newHunks === undefined ? {} : { newHunks: change.newHunks }),
    }))
}

/**
 * A base-to-commit diff read on the commit's side.
 *
 * `--selector-map commit` selects against the commit's own map, whose line
 * numbers are the NEW side of `base..commit`. A pure deletion has no new-side
 * hunk, so it is carried as a new-side insertion point; a deletion that predates
 * the map is not a change to the tree the map describes. This mirrors the
 * projection `createCbd.select` applies to a base older than the map's commit.
 */
function inMapCoordinates(changes) {
  return changes
    .filter((change) => change.status !== 'D')
    .map((change) => ({
      ...change,
      hunks: change.newHunks ?? [],
      insertions: change.newInsertions ?? [],
    }))
}

/** Tests the map knows are defined in a test file, by title. */
function testsDefinedIn(map, absolutePath) {
  return map.tests.filter((entry) => entry.file === absolutePath).map((entry) => entry.title)
}

/**
 * `Required` — the tests that execute code the commit's NEW-side hunks touch,
 * read from the commit's own map.
 *
 * A deleted file has no entry in the new map, so its old-side hunks are read
 * from the base map: those are the tests that used to reach it, which is what
 * rule 8 selects. A file the oracle map has never seen contributes nothing here;
 * the selector escalates it to `all`, and the outcome oracle covers what actually
 * failed.
 */
function requiredTitles(change, oracleMap, baseMap) {
  // A deleted file has no entry in the new map, so it answers from the base map:
  // the tests that used to reach it are what rule 8 selects.
  const map = change.status === 'D' ? baseMap : oracleMap
  const titles = new Set()

  // A test file answers with its own tests (§8.3 rule 3), which rule 4/5 would
  // otherwise miss because the test's own body may touch no mapped function.
  // The oracle must use the same notion of "test file" as the selector, or a
  // repository that scopes its test globs in `cbd.config.json` would have the
  // oracle require tests the product deliberately answers by ordinary rules.
  if (matchesAnyGlob(change.path, selectConfig.testFiles ?? DEFAULT_TEST_FILES) !== null) {
    for (const title of testsDefinedIn(map, change.path)) titles.add(title)
  }

  const ranges = change.status === 'D' ? change.hunks : (change.newHunks ?? change.hunks)
  for (const hunk of ranges) {
    for (let line = hunk.start; line <= hunk.end; line += 1) {
      for (const test of testsForLine(map, change.path, line)) titles.add(test.title)
    }
  }
  return titles
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

const results = []
let baseMap = null
let baseRun = null

try {
for (const [index, step] of plan.entries()) {
  const short = step.commit.slice(0, 8)
  const dir = resolve(state, String(index).padStart(3, '0'))
  mkdirSync(dir, { recursive: true })
  process.stdout.write(`\nreplay: [${index + 1}/${plan.length}] ${step.role} ${short}\n`)

  prepare(step.commit, dir)
  const shardPath = resolve(dir, 'full.ndjson')
  const full = runTests(dir, shardPath, step.commit)
  process.stdout.write(`replay:   full ${full.wall.toFixed(1)}s (exit ${full.status})\n`)
  const records = fullRunRecords(shardPath)
  const summary = records === null ? null : summarizeShard(records)

  if (step.role === 'base') {
    if (summary === null) {
      throw new Error(
        `replay: the base run at ${short} wrote no complete shard, so there is no map to select ` +
          `against. See ${resolve(dir, 'full.log')}`,
      )
    }
    baseMap = mapOf(records, shardPath, step.commit)
    baseRun = {
      commit: step.commit,
      wall: full.wall,
      status: full.status,
      tests: summary.tests.length,
    }
    if (teardownCommand !== undefined) run(teardownCommand, {}, resolve(dir, 'teardown.log'))
    continue
  }

  const rawChanges = changesBetween(step.commit)
  const changes = selectorMode === 'commit' ? inMapCoordinates(rawChanges) : rawChanges

  // The full run wrote no complete shard: it failed at import, crashed, or ran
  // no tests. There are no outcomes for either oracle, but the selector's answer
  // is still checkable against the map it would have used.
  if (summary === null || summary.tests.length === 0) {
    const selectorMap = selectorMode === 'commit' ? null : baseMap
    const universe = selectorMap === null ? [] : selectorMap.tests.map((test) => test.title)
    let mode = null
    let why = []
    let selected = 0
    let unverified = []
    if (selectorMap !== null && changes.length > 0) {
      const selection = select(selectorMap, changes, selectConfig, {
        commit: selectorMap.commit,
        distance: index,
        dirty: false,
      })
      mode = selection.mode
      const chosen =
        mode === 'all'
          ? universe
          : [...new Set(selection.tests.map((testIndex) => selectorMap.tests[testIndex].title))]
      const chosenSet = new Set(chosen)
      selected = chosen.length
      // Nothing ran, so only an answer that names every known test can be
      // trusted. A subset that leaves tests out is the unsafe direction.
      unverified = universe.filter((title) => !chosenSet.has(title))
      why = allReasons(selection)
    }
    results.push({
      commit: step.commit.slice(0, 12),
      files: new Set(changes.map((change) => change.path)).size,
      loadFailure: true,
      fullStatus: full.status,
      mode,
      why,
      tests: universe.length,
      selected,
      rCount: universe.length === 0 ? 0 : selected / universe.length,
      rTime: 0,
      tFull: full.wall,
      tSubset: full.wall,
      eTime: 0,
      required: null,
      miss: [],
      newTests: [],
      newFailures: [],
      missedFailures: [],
      subsetOnlyFailures: [],
      unverified,
    })
    const detail =
      selectorMap === null
        ? 'no commit map to select against'
        : changes.length === 0
          ? 'no in-scope changes'
          : `${String(mode)} · ${String(selected)}/${String(universe.length)} tests · ` +
            `unverified ${String(unverified.length)}`
    const failure =
      summary === null
        ? `no complete full-run shard (exit ${String(full.status)})`
        : 'no test outcomes in the full run'
    process.stdout.write(`replay:   ${failure}; load failure · ${detail}\n`)
    if (teardownCommand !== undefined) run(teardownCommand, {}, resolve(dir, 'teardown.log'))
    continue
  }

  const map = mapOf(records, shardPath, step.commit)
  const mapForSelection = selectorMode === 'commit' ? map : baseMap
  if (changes.length === 0) {
    process.stdout.write('replay:   no in-scope changes; nothing to select\n')
    if (teardownCommand !== undefined) run(teardownCommand, {}, resolve(dir, 'teardown.log'))
    continue
  }

  const selection = select(mapForSelection, changes, selectConfig, {
    commit: mapForSelection.commit,
    distance: selectorMode === 'commit' ? 0 : index,
    dirty: false,
  })

  const fullSummary = summary
  const universe = fullSummary.tests.map((test) => test.title)
  const fullFailed = fullSummary.tests.filter((test) => test.status === 'failed').map((test) => test.title)
  const totalMs = fullSummary.tests.reduce((sum, test) => sum + test.durationMs, 0)

  let selected
  let subset = null
  if (selection.mode === 'all') {
    selected = universe
  } else {
    selected = [...new Set(selection.tests.map((testIndex) => mapForSelection.tests[testIndex].title))]
    if (selected.length === 0) {
      // The selector answered "no test reaches this change" — the product's own
      // behaviour is to run nothing (`cbd collect` does not hand a runner an empty
      // filter, and an adapter refuses one). Running the command anyway would
      // measure a full run against an empty selection and crash the adapter.
      process.stdout.write('replay:   subset empty; nothing to run\n')
    } else {
      const selectionPath = resolve(dir, 'selection.json')
      // A v2 selection, so a runner that can narrow by file (the japa adapter) does:
      // a titles-only file leaves every spec file imported and the subset as slow as
      // the full run. Every other adapter reads the titles out of it unchanged.
      writeSelection(
        selectionPath,
        selection.tests.map((testIndex) => mapForSelection.tests[testIndex]),
      )
      const subsetShardPath = resolve(dir, 'subset.ndjson')
      subset = runTests(dir, subsetShardPath, step.commit, selectionPath)
      process.stdout.write(`replay:   subset ${subset.wall.toFixed(1)}s (exit ${subset.status})\n`)
    }
  }

  const selectedSet = new Set(selected)
  const selectedMs = fullSummary.tests
    .filter((test) => selectedSet.has(test.title))
    .reduce((sum, test) => sum + test.durationMs, 0)

  // --- coverage oracle -----------------------------------------------------
  const required = new Map()
  for (const change of changes) {
    for (const title of requiredTitles(change, map, baseMap)) {
      const relative = change.path.replace(`${repo}/`, '')
      if (!required.has(title)) required.set(title, relative)
    }
  }

  // A title the selector's map does not know cannot be selected at all — a test
  // added inside the replay window. That is a property of a one-map replay rather
  // than a selection failure, so it is reported apart from the miss count rather
  // than allowed to inflate it (`cbd-2jx`).
  const knownAtSelector = new Set(mapForSelection.tests.map((entry) => entry.title))
  const newTests = [...required].filter(([title]) => !knownAtSelector.has(title))
  const miss = [...required].filter(
    ([title]) => knownAtSelector.has(title) && !selectedSet.has(title),
  )

  // --- outcome oracle ------------------------------------------------------
  // A failure in a test the base map never knew is unselectable for the same
  // reason as a new test; report it apart.
  const newFailures = fullFailed.filter((title) => !knownAtSelector.has(title))
  const missedFailures = fullFailed.filter(
    (title) => knownAtSelector.has(title) && !selectedSet.has(title),
  )

  let subsetOnlyFailures = []
  let subsetSummary = null
  if (subset !== null) {
    const subsetShardPath = resolve(dir, 'subset.ndjson')
    if (existsSync(subsetShardPath)) {
      try {
        subsetSummary = summarizeShard(
          parseShard(readFileSync(subsetShardPath, 'utf8'), subsetShardPath),
        )
      } catch (error) {
        // A subset run that wrote no complete shard has no outcomes to compare;
        // the step's coverage and outcome oracles still stand. Refusing the whole
        // report over it would lose every earlier step.
        process.stderr.write(`replay:   subset shard unreadable: ${String(error)}\n`)
      }
      subsetOnlyFailures = (subsetSummary?.tests ?? [])
        .filter((test) => test.status === 'failed' && !fullFailed.includes(test.title))
        .map((test) => test.title)
    }
  }

  results.push({
    commit: step.commit.slice(0, 12),
    files: new Set(changes.map((change) => change.path)).size,
    mode: selection.mode,
    why: allReasons(selection),
    tests: universe.length,
    selected: selected.length,
    rCount: universe.length === 0 ? 0 : selected.length / universe.length,
    rTime: totalMs === 0 ? 0 : selectedMs / totalMs,
    tFull: full.wall,
    // `all` costs a full run; an empty selection runs nothing, so its subset time is
    // zero rather than the full run it deliberately skipped.
    tSubset: subset !== null ? subset.wall : selection.mode === 'all' ? full.wall : 0,
    eTime: selectedMs / 1000,
    required: required.size,
    miss: miss.map(([title, file]) => ({ title, file })),
    newTests: newTests.map(([title, file]) => ({ title, file })),
    newFailures,
    missedFailures,
    subsetOnlyFailures,
  })

  process.stdout.write(
    `replay:   ${selection.mode} · ${String(selected.length)}/${String(universe.length)} tests · ` +
      `miss ${String(miss.length)} · new ${String(newTests.length)} · ` +
      `missed failures ${String(missedFailures.length)}\n`,
  )
  if (teardownCommand !== undefined) run(teardownCommand, {}, resolve(dir, 'teardown.log'))
}
} finally {
  // Leave the repository where it started, even when a run failed part-way. The
  // patch is part of the worktree, not of any commit, so restoring means checking
  // the original out and re-applying it.
  //
  // The patch must be discarded *before* the checkout: when a patched file differs
  // between the replay commit and the branch, git refuses to switch with the change
  // in the way. That refusal used to escape the `finally` and lose the report the
  // run had already earned, so restoration is now best-effort and says so.
  try {
    git(['checkout', '--quiet', '--', '.'])
    git(['checkout', '--quiet', originRef])
    if (patch !== null && existsSync(patch)) git(['apply', patch])
  } catch (error) {
    process.stderr.write(
      `replay: the worktree could not be restored automatically (${String(error)}); ` +
        'it is still at the last replayed commit. The report below is unaffected.\n',
    )
  }
}

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

const scored = results.filter((result) => result.loadFailure !== true)
const loadFailures = results.length - scored.length
const escalations = scored.filter((result) => result.mode === 'all').length
const pAll = scored.length === 0 ? 0 : escalations / scored.length
const mean = (values) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length)
const rCount = mean(scored.map((result) => result.rCount))
const rTime = mean(scored.map((result) => result.rTime))
const misses = results.reduce((sum, result) => sum + result.miss.length, 0)
const unverified = results.reduce((sum, result) => sum + (result.unverified?.length ?? 0), 0)
const newTests = results.reduce((sum, result) => sum + result.newTests.length, 0)
const missedFailures = results.reduce((sum, result) => sum + result.missedFailures.length, 0)
const newFailures = results.reduce((sum, result) => sum + result.newFailures.length, 0)
const subsetOnly = results.reduce((sum, result) => sum + result.subsetOnlyFailures.length, 0)
const meanFull = mean(scored.map((result) => result.tFull))
const meanSubset = mean(scored.map((result) => result.tSubset))
const meanE = mean(scored.map((result) => result.eTime))

const report = {
  base,
  head: origin,
  commits: results.length,
  scored: scored.length,
  loadFailures,
  pAll,
  rCount,
  rTime,
  sCount: (1 - pAll) * (1 - rCount),
  sTime: (1 - pAll) * (1 - rTime),
  misses,
  unverified,
  newTests,
  newFailures,
  missedFailures,
  subsetOnlyFailures: subsetOnly,
  timing: { meanFull, meanSubset, meanE, saving: meanFull === 0 ? 0 : 1 - meanSubset / meanFull },
  baseRun,
  results,
}

if (options.json !== undefined) writeFileSync(resolve(options.json), JSON.stringify(report, null, 2))

console.log('\n=== replay ===')
console.log(`  commits     ${String(report.commits)} of ${String(commits.length)} replayed (base ${base.slice(0, 8)})` +
  (loadFailures === 0 ? '' : `; ${String(loadFailures)} load failure(s), ${String(scored.length)} scored`))
console.log(`  P(all)      ${(pAll * 100).toFixed(1)}%`)
console.log(`  r(count)    ${(rCount * 100).toFixed(1)}%   r(time) ${(rTime * 100).toFixed(1)}%`)
console.log(`  S(count)    ${(report.sCount * 100).toFixed(1)}%   S(time) ${(report.sTime * 100).toFixed(1)}%`)
console.log(
  `  miss        ${String(misses)}   new tests ${String(newTests)}   ` +
    `missed failures ${String(missedFailures)}   new failures ${String(newFailures)}   ` +
    `subset-only failures ${String(subsetOnly)}   unverified ${String(unverified)}`,
)
console.log(
  `  timing      full ${meanFull.toFixed(1)}s · subset ${meanSubset.toFixed(1)}s · ` +
    `E[time] ${meanE.toFixed(1)}s · saving ${(report.timing.saving * 100).toFixed(1)}%`,
)
if (misses > 0) {
  console.log('\n  MISSES')
  for (const result of results) {
    for (const miss of result.miss) console.log(`    ${result.commit}  ${miss.file}  ${miss.title}`)
  }
}
if (missedFailures > 0) {
  console.log('\n  FAILURES NOT SELECTED')
  for (const result of results) {
    for (const title of result.missedFailures) console.log(`    ${result.commit}  ${title}`)
  }
}
