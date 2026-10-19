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
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  SELECTION_ENV,
  StaleShardError,
  mapPath,
  nearestMapCommit,
  type Cbd,
  type CbdConfig,
  type SelectionFile,
} from '@spikedpunch/cbd'
import { EXIT } from './exit.js'
import { plural, shown } from './render.js'

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
  changed: number
}

function planSelection(options: CollectOptions, selectionPath: string): SelectionPlan {
  const stateDir = options.config.stateDir ?? '.cbd'

  if (nearestMapCommit(options.root, stateDir) === undefined) {
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
  // runner filters by title, so the list is a set.
  const titles = [...new Set(result.selected.map((entry) => entry.title))]
  if (titles.length > 0) {
    writeSelection(selectionPath, titles)
    options.out(`selected ${plural(titles.length, 'test')} for ${files}`)
  }
  return { titles, changed: result.changes.length }
}

function writeSelection(path: string, titles: string[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const file: SelectionFile = { titles }
  writeFileSync(path, JSON.stringify(file))
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
  out: (line: string) => void,
  err: (line: string) => void,
): number | null {
  try {
    const built = options.cbd.build({ commit: options.commit })
    out(
      `map ${shown(options.root, built.path)}: ${plural(built.tests, 'test')}, ` +
        `${plural(built.files, 'file')} from ${plural(built.shards.length, 'shard')}`,
    )
    return null
  } catch (error) {
    const map = mapPath(options.root, options.commit, stateDir)
    if (error instanceof StaleShardError && existsSync(map)) {
      err(
        `cbd: left the map at ${shown(options.root, map)} unchanged — this run's shard is ` +
          `stale: ${error.message}`,
      )
      return null
    }
    err(`cbd: ${error instanceof Error ? error.message : String(error)}`)
    return EXIT.error
  }
}

export function collect(options: CollectOptions): number {
  const { out, err } = options
  const stateDir = options.config.stateDir ?? '.cbd'
  const selectionPath = join(options.root, stateDir, 'selection.json')
  const shard = options.shard ?? join(options.root, stateDir, 'shards', collectShardName())

  const plan: SelectionPlan = options.select
    ? planSelection(options, selectionPath)
    : { changed: 0 }
  if (plan.titles !== undefined && plan.titles.length === 0) {
    out(`nothing to run: 0 tests selected for ${plural(plan.changed, 'changed file')}`)
    return EXIT.ok
  }

  mkdirSync(dirname(shard), { recursive: true })
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
    err(`cbd: could not run ${options.exec[0]}: ${result.error.message}`)
    return EXIT.error
  }
  out(`recorded to ${shown(options.root, shard)} in ${elapsedMs} ms`)

  if (result.signal !== null) {
    err(
      `cbd: the test command was killed by ${result.signal}; its shard has no footer, ` +
        'so no map was built',
    )
    return EXIT.error
  }

  if (options.build) {
    const failure = buildAfterRun(options, stateDir, out, err)
    if (failure !== null) return failure
  }

  const status = result.status ?? EXIT.error
  if (status !== 0) err(`cbd: the test command exited ${status}`)
  return status
}
