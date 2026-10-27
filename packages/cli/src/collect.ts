/**
 * `cbd collect` — run a test command with CBD's environment, then build the map.
 *
 * **Collect is opt-in, select and build follow it automatically.** Nothing records
 * a suite the developer did not ask to record, because a recorded run costs the
 * inspector session and the extra bytes; once collection is asked for, narrowing
 * the run and merging its shard are what the command is for, so both are on by
 * default and each has an off switch (`--no-select`, `--no-build`).
 *
 * **The build happens in this process, not detached.** A build that continued
 * after `cbd collect` exited would race the next run reading the map: a half-written
 * `map.json` is a silent wrong answer, while a slow command is merely slow. The
 * shard is complete before the child's exit is observed, so merging it here is the
 * only ordering that cannot half-write.
 *
 * **An interrupted child is not built.** A shard whose footer is missing is refused
 * by `parseShard`, and a process killed by a signal is exactly that case. Saying so
 * is better than either building a short map or hiding the crash.
 *
 * **A missing map means a full recording, not a failure.** The first run of a
 * repository has no map to select from; CBD.md §10's rule is that a missing map is
 * never a failure, and here the safe reading is "record everything so the first map
 * is complete".
 *
 * **An attach target is checked here, not in the suite.** `--target` names an
 * `--inspect` process whose environment cannot carry the instrument. The recorder
 * lives in the test process, so the target travels there in `CBD_INSPECT`; this
 * command resolves it, refuses a target another collector already holds, and says
 * so in its own voice — a runner would print the same refusal as a stack trace,
 * after the suite had started.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  GRANULARITY_ENV,
  INSPECT_ALLOW_REMOTE_ENV,
  INSPECT_ENV,
  SELECTION_ENV,
  StaleShardError,
  allowRemoteFromEnv,
  assertInspectorUnheld,
  mapPath,
  nearestMapCommit,
  parseInspectorTarget,
  writeSelection,
  type Cbd,
  type CbdConfig,
} from '@spikedpunch/cbd'
import { EXIT } from './exit.js'
import { plural, shown } from './render.js'
import { UsageError } from './args.js'

export interface CollectOptions {
  cbd: Cbd
  config: CbdConfig
  /** Canonical repository root; map and state paths are rooted here. */
  root: string
  /** Where the test command runs: the directory `cbd` was invoked from. */
  cwd: string
  commit: string
  exec: string[]
  select: boolean
  build: boolean
  shard?: string
  /** Carry untouched tests forward from the nearest map instead of a full one. */
  incremental: boolean
  /** The map commit to carry from. */
  base?: string
  /**
   * `--target`: attach to this `--inspect` process for the service coverage,
   * instead of reading an instrumented socket directory.
   */
  target?: string
  /** `--allow-remote`: the target is not loopback, and that is intended. */
  allowRemote: boolean
  out(line: string): void
  err(line: string): void
}

/**
 * A shard name that sorts by recording time and does not collide between runs.
 *
 * The PID is not decoration: two CI shards of the same commit can start in the same
 * millisecond, and `buildMap` keys shards by name.
 */
export function collectShardName(now = new Date(), pid = process.pid): string {
  return `collect-${now.toISOString().replace(/[:.]/g, '-')}-${pid}.ndjson`
}

interface SelectionPlan {
  /** Set only for a subset; `undefined` means run everything. */
  titles?: string[]
  /** The map commit the selection read; a narrowed run carries the rest from it. */
  base?: string
  changed: number
}

/**
 * Resolves `--target` and refuses one another collector holds.
 *
 * The attach itself happens in the test process, where the Recorder lives, and the
 * target reaches it through the environment. Checking here is what makes a
 * malformed target a usage error and a held target one `cbd:` line, instead of a
 * runner stack trace after the suite has already started. No connection is opened:
 * the CLI would hold the very lock it is checking.
 */
function checkInspectTarget(target: string, allowRemote: boolean): void {
  let parsed
  try {
    parsed = parseInspectorTarget(target, allowRemote)
  } catch (error) {
    // A target that cannot be read is the command's mistake, not a failed run.
    throw new UsageError((error as Error).message)
  }
  assertInspectorUnheld(parsed)
}

function planSelection(options: CollectOptions, selectionPath: string): SelectionPlan {
  const stateDir = options.config.stateDir ?? '.cbd'

  const base = nearestMapCommit(options.root, stateDir, options.config.mapsDir)
  if (base === undefined) {
    options.err(
      'cbd: warning: no map yet; running the full suite so the first map covers everything',
    )
    return { changed: 0 }
  }

  const result = options.cbd.select()
  const files = plural(result.changes.length, 'changed file')
  if (result.selection.mode === 'all') {
    options.out(`running all tests: ${plural(result.selection.reasons.length, 'reason')} for ${files}`)
    return { changed: result.changes.length }
  }

  // A title can name more than one test when two files use the same name; the
  // runner filters by title, so the list is a set. The file itself carries the
  // ids as well, so a v2-aware adapter need not fall back to titles.
  const titles = [...new Set(result.selected.map((entry) => entry.title))]
  if (titles.length > 0) {
    writeSelection(selectionPath, result.selected)
    options.out(`selected ${plural(titles.length, 'test')} for ${files}`)
  }
  return { titles, base, changed: result.changes.length }
}


function childEnv(
  options: CollectOptions,
  shard: string,
  selectionPath: string,
  titles: string[] | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Absolute on purpose: the child's working directory is the consumer's, not
    // necessarily the repository root.
    CBD_SHARD: shard,
    CBD_COMMIT: options.commit,
  }
  if (titles !== undefined) env[SELECTION_ENV] = selectionPath
  else delete env[SELECTION_ENV]
  if (options.target !== undefined) env[INSPECT_ENV] = options.target
  // Absent means "the target is loopback"; the adapter checks it again either way.
  if (options.allowRemote) env[INSPECT_ALLOW_REMOTE_ENV] = '1'
  // Only "group" needs saying: the recorder's default is per test, and an adapter
  // with no group wiring must not claim it.
  if (options.config.granularity === 'group') env[GRANULARITY_ENV] = 'group'
  else delete env[GRANULARITY_ENV]
  return env
}

/**
 * Build the map after the run, keeping a refused rebuild non-fatal when a map for
 * the commit already exists.
 *
 * A v2 shard records the size and mtime of every script it ran, and a build
 * refuses a shard whose bytes changed. On a dirty tree that is the ordinary case:
 * the previous full recording is at the map's commit and the developer has edited
 * since. The map selection just used is still correct for its commit, so it is
 * left alone — refusing the *rebuild* must not fail the test run the developer
 * asked for.
 */
function buildAfterRun(
  options: CollectOptions,
  stateDir: string,
  shards: string[],
  plan: SelectionPlan,
  out: (line: string) => void,
  err: (line: string) => void,
): number | null {
  const base = options.base ?? plan.base
  try {
    const built = options.cbd.build({
      commit: options.commit,
      // This run's shards, not every shard ever written for this commit. An
      // older run's shard is stale the moment the tree moved on, and merging it
      // would refuse a rebuild the current run can answer for.
      shards,
      // A narrowed run recorded only the selected tests; a map of just those would
      // make every later selection miss the rest. The map the selection read is
      // the base the skipped tests are carried from.
      ...(options.incremental || plan.titles !== undefined ? { incremental: true } : {}),
      ...(base === undefined ? {} : { base }),
    })
    out(
      `map ${shown(options.root, built.path)}: ${plural(built.tests, 'test')}, ` +
        `${plural(built.files, 'file')} from ${plural(built.shards.length, 'shard')}`,
    )
    return null
  } catch (error) {
    const map = mapPath(options.root, options.commit, stateDir, options.config.mapsDir)
    if (error instanceof StaleShardError && existsSync(map)) {
      err(
        `cbd: left the map at ${shown(options.root, map)} unchanged — this run's shard is ` +
          `stale: ${error.message}`,
      )
      return null
    }
    const message = error instanceof Error ? error.message : String(error)
    // Core's errors already carry the prefix; adding a second one read as
    // `cbd: cbd: no shards under …`.
    err(message.startsWith('cbd:') ? message : `cbd: ${message}`)
    return EXIT.error
  }
}

/**
 * Sizes of the shards present before a run, by file name.
 *
 * The names are unique per run for the base shard, but an older run's files must
 * still be distinguishable from this one's when the build picks its inputs.
 */
interface ShardStamp {
  size: number
  mtimeMs: number
}

/** Stamps of the shards present before a run, by file name. */
function shardSizes(dir: string): Map<string, ShardStamp> {
  const stamps = new Map<string, ShardStamp>()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ndjson')) continue
    try {
      const stat = statSync(join(dir, entry.name))
      stamps.set(entry.name, { size: stat.size, mtimeMs: stat.mtimeMs })
    } catch {
      // A file that disappeared between the listing and the stat is simply not a
      // pre-existing shard.
    }
  }
  return stamps
}

/** The shard files this run created or appended to, sorted for stable provenance. */
function shardsWrittenSince(
  dir: string,
  before: ReadonlyMap<string, ShardStamp>,
  runStem: string,
  baseName: string,
): string[] {
  const written: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ndjson')) continue
    // Adapters derive per-file and service names beside the base, sharing its
    // stem. Another concurrent run's shards have a different stem and are not
    // this run's evidence.
    if (entry.name !== baseName && !entry.name.startsWith(`${runStem}.`)) continue
    const path = join(dir, entry.name)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    const prior = before.get(entry.name)
    // Size alone misses a same-path rerun that recorded fewer bytes; the mtime
    // catches it without treating an untouched older shard as this run's.
    if (prior === undefined || prior.size !== stat.size || prior.mtimeMs !== stat.mtimeMs) {
      written.push(path)
    }
  }
  return written.sort()
}

export function collect(options: CollectOptions): number {
  const { out, err } = options
  // Before the selection: a target that cannot be attached to is worth saying
  // before any work, and before a suite is spawned that would spend its setup
  // discovering it. An inherited `CBD_INSPECT` is the same target by another route —
  // the adapter will attach to it, so the same checks have to run — and its
  // allow-remote flag can only have come from the environment.
  const target = options.target ?? process.env[INSPECT_ENV]
  const allowRemote =
    options.target !== undefined
      ? options.allowRemote
      : allowRemoteFromEnv(process.env[INSPECT_ALLOW_REMOTE_ENV])
  if (target !== undefined && target !== '') checkInspectTarget(target, allowRemote)

  const stateDir = options.config.stateDir ?? '.cbd'
  const shard = options.shard ?? join(options.root, stateDir, 'shards', collectShardName())
  const shardDir = dirname(shard)
  const runStem = basename(shard, extname(shard))
  // Per-run, so two collects cannot overwrite each other's selection between
  // the write and the adapter's read; removed when the run ends.
  const selectionPath = join(options.root, stateDir, `selection-${runStem}.json`)

  const plan: SelectionPlan = options.select
    ? planSelection(options, selectionPath)
    : { changed: 0 }
  if (plan.titles !== undefined && plan.titles.length === 0) {
    out(`nothing to run: 0 tests selected for ${plural(plan.changed, 'changed file')}`)
    rmSync(selectionPath, { force: true })
    return EXIT.ok
  }

  mkdirSync(shardDir, { recursive: true })
  // A run can write several shards: one per test file (Jest, Vitest, node:test),
  // a service shard (japa), or one at the base path (mocha, japa). Snapshot the
  // directory so the build takes the ones this run touched, not an older run's.
  const shardsBefore = shardSizes(shardDir)
  const started = performance.now()
  const result = spawnSync(options.exec[0]!, options.exec.slice(1), {
    cwd: options.cwd,
    env: childEnv(options, shard, selectionPath, plan.titles),
    // The suite is the user's to watch: forwarding rather than capturing keeps it
    // interactive and keeps its output where they expect it.
    stdio: 'inherit',
  })
  const elapsedMs = Math.round(performance.now() - started)

  if (result.error !== undefined) {
    rmSync(selectionPath, { force: true })
    err(`cbd: could not run ${options.exec[0]}: ${result.error.message}`)
    return EXIT.error
  }

  // A shard is created by the adapter's first record, so a command that died
  // before the runner started leaves no file at all. Printing "recorded to" for
  // a path that does not exist, and then failing to build it, told the user two
  // contradictory things in a row.
  const written = shardsWrittenSince(shardDir, shardsBefore, runStem, basename(shard))
  const wroteShard = written.length > 0
  out(
    wroteShard
      ? `recorded ${plural(written.length, 'shard')} in ${shown(options.root, shardDir)} in ${elapsedMs} ms`
      : 'no tests ran; nothing recorded',
  )

  // The selection file belongs to this run and this run only. Every exit from here
  // removes it, including a failed build: leaving it behind left a file naming a
  // test set no later run asked for.
  try {
    if (result.signal !== null) {
      err(
        `cbd: the test command was killed by ${result.signal}; its shard has no footer, ` +
          'so no map was built',
      )
      return EXIT.error
    }

    const status = result.status ?? EXIT.error
    // A failed run is an incomplete recording: the tests that failed are not in
    // the shard as passing, so a map built from it would stop selecting them. The
    // previous map, if any, is the better answer.
    if (status !== 0 && options.build && wroteShard) {
      err('cbd: no map was built from the failed run; fix the failures and collect again')
    } else if (options.build && wroteShard) {
      const failure = buildAfterRun(options, stateDir, written, plan, out, err)
      if (failure !== null) return failure
    }

    if (status !== 0) err(`cbd: the test command exited ${status}`)
    return status
  } finally {
    rmSync(selectionPath, { force: true })
  }
}
