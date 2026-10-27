/**
 * Turns a test run into shard records.
 *
 * Buckets, and why each exists:
 *   per-test   the window between a test's start and its end. The product.
 *   @load      everything before the first test — module imports. Recorded at
 *              `runStart`, which only works because the source is created before
 *              the test files are imported.
 *   @between   everything outside a window: a background timer, a lazily loaded
 *              module, work between tests. Unattributable, so the selector has to
 *              treat it as reaching every test.
 *
 * ## Two sources, one bookkeeping, and why they are not two recorders
 *
 * A *synchronous* source answers in the tick its window closes, so its record is
 * written in that tick. That is a requirement rather than a style choice: japa does
 * not await its lifecycle hooks (A0 F1), and a write deferred to a microtask could
 * land after `runEnd` had already written the footer — a shard whose footer
 * precedes its records, which `parseShard` would have no way to notice.
 *
 * A *queued* source cannot answer in that tick. It can only be handed a boundary
 * and asked for the reply later, which is what `QueuedSource` is for. Its records
 * are therefore queued behind one another and written when the replies land.
 *
 * Everything else — which bucket a boundary belongs to, when `@load` is captured,
 * how a test's duration is derived — is identical, and it is precisely the part
 * that must not exist in two copies. The `@load` rule is a single boolean with three
 * call sites and a subtle one (a run with no tests still has a load phase, and it
 * is only discovered at `runEnd`); two copies that drifted would misfile an entire
 * import phase as `@between`, which escalates rather than under-selects. So the
 * bookkeeping below is written once and the *difference* is a `Windows` strategy:
 * four small functions that decide when a line reaches the sink.
 *
 * ## A v2 shard holds byte ranges, and the table is built once per run
 *
 * The recorder used to resolve every function of every window — read the file,
 * parse the source map, look up the position — and that cost 36× the coverage take
 * (ADR-0002). It now projects the V8 payload: script ids and byte ranges per
 * window, plus a script and function row the first time each is seen. Resolution
 * is the build's job, once per distinct function.
 *
 * The table is still run-scoped, and for the same reason the ordinal registry used
 * to be: V8 stops reporting a script's full function list after the take that
 * follows its compilation, so a function that first appears late is only knowable
 * from the union over every window. Recording each `(script, function)` once is
 * what lets the build assign source-order ordinals from a complete set. The queued
 * strategy projects each window *inside* its chain rather than when the reply
 * arrives, so the table is written in boundary order.
 */
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { CorrelatedTest, OwnerIndex } from './correlate.js'
import type { TestRefDetail } from './contract.js'
import { FileCache, sameLineStarts } from './line-index.js'
import { scriptPrefilter, type ScanOptions } from './normalize.js'
import { withoutReadTracking } from './read-tracker.js'
import { activateRecordSink } from './record.js'
import { hashEnvValue } from './env.js'
import { createRelocator } from './relocate.js'
import { sourceMapUrlOf } from './source-maps.js'
import {
  SHARD_VERSION,
  type RawRange,
  type ShardFunction,
  type ShardGroupTest,
  type ShardHealth,
  type ShardRecord,
  type ShardScript,
  type ShardSink,
  type ShardTest,
  type ShardTouch,
} from './shard.js'
import type { DriftStats, QueuedSource, Source, V8ScriptCoverage } from './types.js'

export type TestStatus = 'passed' | 'failed' | 'skipped'

/**
 * Which outcome a test had, from the plain booleans a runner reports.
 *
 * A skipped test still emits start and end events, and its `hasError` is false —
 * so mapping on `hasError` alone records a test that never ran as a passing one
 * with an empty window. That is precisely the "green runs only" hazard amendment
 * 5 exists for, so the caller must pass `isSkipped` through.
 */
export function classifyStatus(outcome: {
  hasError?: boolean
  isSkipped?: boolean
  isTodo?: boolean
}): TestStatus {
  // A todo has no window either, so it is grouped with skipped: the map cares
  // only about whether the recorded coverage can be trusted.
  if (outcome.isSkipped === true || outcome.isTodo === true) return 'skipped'
  return outcome.hasError === true ? 'failed' : 'passed'
}

export interface RecorderOptions {
  source: Source
  sink: ShardSink
  commit: string
  /**
   * The record-time half of the scan: `prefilter` (and the adapters' self roots)
   * decide which scripts enter the shard, and `relocate` chooses the stable file a
   * script's bytes are checked against.
   *
   * Projection and include/exclude are build-time in v2; the build must be given
   * the same rules. See `MapBuildOptions.scan`.
   */
  scan?: ScanOptions
  pid?: number
  /**
   * `'service'` records a process the suite observes rather than the process
   * running the tests. It changes one thing in the map: a `@load` touch is
   * attributed only to the tests that actually touched this shard, because the
   * adapters open a window for every test on every recorder.
   */
  role?: 'service'
  now?: () => number
  /**
   * Resolves a correlation id to the test that opened it.
   *
   * Absent for a run without correlation, in which case tagged windows cannot
   * arrive and every record is exactly what it was before. Present for both
   * recorders of a correlated run: the test process's shard and the service's
   * share one registry, so the service can name a test it never ran.
   */
  owners?: OwnerIndex
  /**
   * When a window is taken.
   *
   * `'test'` (the default) takes at every test boundary, twice per test: the gap
   * before the test as `@between`, then the test itself. `'group'` takes once at
   * `groupEnd()`, and every test that finished inside the group shares that one
   * window. A take walks the isolate's loaded functions, so its cost is per call
   * and not per payload; grouping is the only lever on the overhead a large
   * single-process suite pays (measured at 13 ms a take on VS Code).
   *
   * The trade is over-selection inside a group and never under-selection. The gap
   * between tests is not a bucket in this mode: it belongs to the window of the
   * group that follows. An adapter that never calls `groupEnd` records per test,
   * which is why the mode is opted into by the adapter rather than guessed here.
   */
  granularity?: 'test' | 'group'
}

/**
 * Unions one window's ranges into another, keyed by `(script, start offset)`.
 *
 * The identity of an executed function is its start offset: V8 reports one row per
 * function per script, and the same function in two windows is the same offset.
 * The end is the function's full extent and is invariant, but taking the max costs
 * nothing and makes the union robust to a payload that reports it differently.
 */
function unionTouch(target: ShardTouch, source: ShardTouch): void {
  for (const [scriptId, ranges] of Object.entries(source)) {
    const existing = target[scriptId]
    if (existing === undefined) {
      target[scriptId] = ranges.map(([start, end]): RawRange => [start, end])
      continue
    }
    for (const [start, end] of ranges) {
      const found = existing.find(([knownStart, knownEnd]) => knownStart === start && knownEnd === end)
      if (found === undefined) existing.push([start, end])
    }
  }
}

const hasTouches = (touch: ShardTouch): boolean =>
  Object.values(touch).some((ranges) => ranges.length > 0)

/** One delta and the requests that were open for it, before projection. */
export interface RawCapture {
  coverage: V8ScriptCoverage[]
  ids: string[]
  requests: Array<{ ids: string[]; coverage: V8ScriptCoverage[] }>
  /** Files the target read during this window; see `TakeCapture` in the adapter seam. */
  reads?: string[]
  dirReads?: string[]
}

/**
 * A window projected into the shard's vocabulary: the executed byte ranges plus
 * the script and function rows this window made newly known.
 *
 * The rows are incremental and deduplicated across the whole run. A function's
 * first sighting is not always complete (A4), so a script's function set is only
 * known once every window has been read — but each `(script, function)` is still
 * written exactly once, not once per window.
 */
export interface ProjectedWindow {
  touches: ShardTouch
  scripts: ShardScript[]
  functions: ShardFunction[]
}

/** The same capture in the vocabulary the shard stores, plus the tags that survive. */
export interface ProjectedCapture {
  window: ProjectedWindow
  /**
   * Requests in flight at this boundary. `window.touches` belongs to their tests
   * as well as to the window this record was taken for; see `#attributed`.
   */
  ids: string[]
  /** Deltas the source took at its own request boundaries. */
  requests: Array<{ ids: string[]; window: ProjectedWindow }>
  /** Files the target read during this window, canonical. */
  reads?: string[]
  dirReads?: string[]
}

/** Turns one capture's deltas into the ranges and table rows the shard stores. */
interface Projector {
  project(capture: RawCapture): ProjectedCapture
  /** Script ids recorded so far, for the source's end-of-run generated fetch. */
  scriptIds(): string[]
  /** Update rows for transformed scripts, after the source has prepared. */
  finish(): ShardScript[]
}

const EMPTY_RAW: RawCapture = { coverage: [], ids: [], requests: [] }

/** Union of two path lists, deduplicated and sorted. */
function unionSorted(a: string[], b: string[] | undefined): string[] {
  if (b === undefined || b.length === 0) return a
  return [...new Set([...a, ...b])].sort()
}

/**
 * The recorder's hot projection.
 *
 * `takeSync()` gives a V8 payload; this turns it into script ids and byte ranges.
 * Nothing here reads a source file, parses a source map or resolves a position —
 * that is `resolve.ts`, in `cbd build`, once per distinct function (ADR-0002).
 *
 * The two table rows are written at most once per `(script)` and `(function)`,
 * which is also what makes the build's ordinal assignment possible: the union over
 * every window is complete, including functions V8 surfaced late (A4).
 */
function projectorFor(source: Source, scan: ScanOptions): Projector {
  const prefilter = scriptPrefilter(scan)
  const relocate = createRelocator(scan.relocate ?? [])
  // One read per distinct script, at first sighting. The same file is read again
  // by the build; this copy exists only to decide whether the shard must carry the
  // map as well (`cbd-n9t.1`).
  const cache = new FileCache()
  const knownScripts = new Set<string>()
  const knownFunctions = new Set<string>()
  const rows = new Map<string, ShardScript>()

  /**
   * The script's table row, or `null` when the script cannot be recorded.
   *
   * A script whose file cannot be stat'ed now cannot have its offsets verified
   * later, and a build that guessed at them would attribute ranges to whatever
   * occupies those bytes — under-selection. Leaving the script out keeps the
   * failure in the safe direction: its file never enters the map, and a change to
   * it escalates to `mode: all`.
   *
   * The URL is the relocated one. A deployed lane runs a copy that is gone by
   * build time; the rule says the copy came from the checkout, and the checkout's
   * file is the one whose bytes the offsets describe (ADR-0006).
   */
  const tableRow = (script: V8ScriptCoverage): ShardScript | null => {
    if (!script.url.startsWith('file:')) return null
    const info = source.scripts().get(script.scriptId)
    const url = info?.url ?? script.url
    let path: string
    try {
      path = relocate(fileURLToPath(url))
    } catch {
      return null
    }
    let stat
    try {
      stat = statSync(path)
    } catch {
      return null
    }
    // A map the file itself declares does not need repeating in the shard: the
    // build reads the same stat-verified file and can recover it. Only a map that
    // exists *solely* in `Debugger.scriptParsed` — a loader's injected map, with no
    // comment on disk — is recorded. When the file declares one that differs from
    // what the inspector reported, the inspector's wins: it describes the bytes V8
    // actually executed.
    const text = cache.text(path)
    const declared = text === null ? undefined : sourceMapUrlOf(text)
    const reported = info?.sourceMapURL
    const keep = reported !== undefined && declared !== reported

    let hash: string | undefined
    try {
      hash = createHash('sha256').update(readFileSync(path)).digest('hex')
    } catch {
      // A file that cannot be re-read cannot be hash-checked; the size/mtime guard
      // still applies, and the build may refuse a rebuild it could have accepted.
    }

    return {
      type: 'script',
      scriptId: script.scriptId,
      url: pathToFileURL(path).href,
      ...(keep ? { sourceMapURL: reported } : {}),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(hash === undefined ? {} : { hash }),
    }
  }

  const project = (coverage: V8ScriptCoverage[]): ProjectedWindow => {
    const touches: ShardTouch = {}
    const scripts: ShardScript[] = []
    const functions: ShardFunction[] = []

    for (const script of coverage) {
      if (!prefilter(script.url)) continue

      const executed = script.functions.filter((fn) => {
        const range = fn.ranges[0]
        return range !== undefined && range.count > 0
      })
      if (executed.length === 0) continue

      if (!knownScripts.has(script.scriptId)) {
        const row = tableRow(script)
        if (row === null) continue
        knownScripts.add(script.scriptId)
        rows.set(script.scriptId, row)
        scripts.push(row)
      }

      const ranges: RawRange[] = []
      for (const fn of executed) {
        const range = fn.ranges[0]!
        // The function's identity is its *range*, not its start: Jest's VM wrapper
        // and the first function it contains can both begin at offset 0 (`add` at
        // 0-38 inside the wrapper at 0-777), and a start-only key merged them into
        // one `<module>` row.
        const id = `${script.scriptId}\u0000${String(range.startOffset)}\u0000${String(range.endOffset)}`
        if (!knownFunctions.has(id)) {
          knownFunctions.add(id)
          functions.push({
            type: 'function',
            scriptId: script.scriptId,
            start: range.startOffset,
            end: range.endOffset,
            // Raw V8 data, not resolution. The build decides the module body and
            // the anonymous name, because only it knows the script's full extent.
            name: fn.functionName,
          })
        }
        ranges.push([range.startOffset, range.endOffset])
      }
      touches[script.scriptId] = ranges
    }

    return { touches, scripts, functions }
  }

  return {
    project(capture) {
      // The projector's own stat/read of a script is not a test dependency; a
      // queued source may run it after the next test's window has opened.
      return withoutReadTracking(() => ({
        window: project(capture.coverage),
        ids: capture.ids,
        requests: capture.requests.map((request) => ({
          ids: request.ids,
          window: project(request.coverage),
        })),
        ...(capture.reads === undefined ? {} : { reads: capture.reads }),
        ...(capture.dirReads === undefined ? {} : { dirReads: capture.dirReads }),
      }))
    },
    scriptIds: () => [...rows.keys()],
    finish() {
      // The source has fetched generated text for these scripts at the end of the
      // run, outside every window. An update row is written only when the text is
      // not the file's — an untransformed script needs nothing (`cbd-x2j`).
      const updates: ShardScript[] = []
      for (const row of rows.values()) {
        if (row.generated !== undefined) continue
        const generated = source.generated?.(row.scriptId)
        if (generated === undefined) continue
        let fileIndex
        try {
          fileIndex = cache.index(fileURLToPath(row.url))
        } catch {
          fileIndex = null
        }
        if (
          fileIndex !== null &&
          generated.length === fileIndex.length &&
          sameLineStarts(generated.lineStarts, fileIndex.starts)
        ) {
          continue
        }
        updates.push({ ...row, generated })
      }
      return updates
    },
  }
}

/** One record per line, whether the boundary produced one or a correlated run produced several. */
function appendRecords(sink: ShardSink, records: ShardRecord | ShardRecord[]): void {
  for (const record of Array.isArray(records) ? records : [records]) {
    sink.append(JSON.stringify(record))
  }
}

/**
 * When a record reaches the sink, and what a window boundary does.
 *
 * The only thing the two kinds of recorder disagree about. Every method is
 * called synchronously from a lifecycle hook, so a strategy that has to wait must
 * do its waiting in its own time — the boundary is crossed when the hook calls
 * `commitWindow`, never when the reply lands.
 */
interface Windows {
  /** A record that is already known: the header, the footer. */
  commit(record: ShardRecord): void
  /**
   * A record that needs a window. `build` is handed the window's touches and
   * returns the record, or `null` for a window with nothing in it that is not
   * worth a line.
   *
   * `build` must be a pure function of its argument. It runs at a different time
   * for the two strategies — in the same tick for a synchronous source, whenever
   * the reply lands for a queued one — so anything it reads from the surrounding
   * scope is read at two different points in the run. Capture first, build second.
   */
  commitWindow(build: (capture: ProjectedCapture) => ShardRecord | ShardRecord[] | null): void
  /**
   * The end of the run: let every window settle, prepare the source (generated
   * script text), then write the table updates and the footer.
   *
   * The footer is the one record whose content is not settled until every window
   * ahead of it has been read: it reports drift, and the boundary this same call
   * just sent is still in flight. Preparing the source here keeps its reads outside
   * every window (`cbd-x2j`), and the footer stays behind the windows it follows.
   */
  prepareAndFinish(
    prepare: () => Promise<void> | void,
    updates: () => ShardRecord[],
    footer: () => ShardRecord | ShardRecord[],
  ): void
  /**
   * Boundaries that produced no capture, over the run so far.
   *
   * A dead inspector session, a throwing `takeSync`, or a queued reply that never
   * arrived all substitute an empty window. The window is genuinely lost, and an
   * empty window under-selects for whatever test it belonged to, so the count goes
   * into the shard's health record instead of being swallowed.
   */
  failedTakes(): number
  /** Resolves once every record has reached the sink. */
  drained(): Promise<void>
  /**
   * Forgets the run so far, for a Recorder driven through a second run.
   *
   * The header is written by `runStart`, and the count it reports belongs to that
   * run; a second run inheriting the first's failures would report a clean shard as
   * unhealthy.
   */
  reset?(): void
}

/**
 * How far this source's boundaries have landed from where they were meant.
 *
 * `null` for a source with no boundary to miss. Taken by calling rather than by
 * reading a field, so that a source which keeps the number live cannot accidentally
 * have it read once and captured.
 */
function driftOf(source: Source): DriftStats | null {
  const maybe = source as { drift?: () => DriftStats }
  return typeof maybe.drift === 'function' ? maybe.drift.call(source) : null
}

/**
 * Writes the script and function rows a capture made newly known, before the
 * window record that references them.
 *
 * Order is not required by the build — it reads the whole shard — but a shard cut
 * short by a crash should never reference a table row it had not written yet.
 */
function appendTable(sink: ShardSink, projected: ProjectedCapture): void {
  for (const row of projected.window.scripts) sink.append(JSON.stringify(row))
  for (const row of projected.window.functions) sink.append(JSON.stringify(row))
  for (const request of projected.requests) {
    for (const row of request.window.scripts) sink.append(JSON.stringify(row))
    for (const row of request.window.functions) sink.append(JSON.stringify(row))
  }
}

/** A source that answers in the same tick: write the record in that same tick. */
function syncWindows(source: Source, sink: ShardSink, project: Projector): Windows {
  let failedTakes = 0
  return {
    commit(record) {
      sink.append(JSON.stringify(record))
    },
    commitWindow(build) {
      let capture: RawCapture
      try {
        capture = { coverage: source.takeSync(), ids: [], requests: [] }
      } catch {
        // A dead inspector session must not take the test run down with it. An
        // empty window under-selects for that test, so the loss is counted and the
        // shard's health record makes the map answer `all`.
        failedTakes += 1
        capture = EMPTY_RAW
      }
      const projected = project.project(capture)
      appendTable(sink, projected)
      const records = build(projected)
      if (records !== null) appendRecords(sink, records)
    },
    prepareAndFinish(prepare, updates, footer) {
      // Nothing to wait for: a synchronous source has already answered every window
      // by the time this is called, which is why its footer carries no drift.
      const pending = prepare()
      if (pending instanceof Promise) {
        throw new Error(
          'a synchronous source must prepare generated script text synchronously; ' +
            `${source.kind} returned a promise`,
        )
      }
      for (const row of updates()) sink.append(JSON.stringify(row))
      appendRecords(sink, footer())
    },
    failedTakes: () => failedTakes + (source.lostTakes?.() ?? 0),
    drained: () => Promise.resolve(),
    reset() {
      failedTakes = 0
    },
  }
}

/** A source that answers later: queue the records so they stay in boundary order. */
function queuedWindows(source: QueuedSource, sink: ShardSink, project: Projector): Windows {
  let chain: Promise<void> = Promise.resolve()
  let failedTakes = 0

  /**
   * Appends to the queue. `work` must *return* its promise — returning void from an
   * async worker resolves the chain immediately and the ordering is silently gone,
   * which is a mistake this function's first version made and the byte-comparison
   * test caught.
   */
  const queue = (work: () => void | Promise<void>): void => {
    chain = chain.then(work)
  }

  return {
    commit(record) {
      queue(() => {
        sink.append(JSON.stringify(record))
      })
    },
    commitWindow(build) {
      let reply: Promise<RawCapture>
      try {
        // Here, in this tick, with nothing awaited before it: this call is the
        // boundary. Everything below is bookkeeping.
        const pending = source.dispatch()
        reply =
          pending.settleTagged === undefined
            ? pending.settle().then((coverage) => ({ coverage, ids: [], requests: [] }))
            : pending.settleTagged()
      } catch {
        failedTakes += 1
        reply = Promise.resolve(EMPTY_RAW)
      }

      queue(async () => {
        let capture: RawCapture
        try {
          capture = await reply
        } catch {
          // The socket died mid-run, or the target went away with no snapshot to
          // recover the window from. Same answer as the synchronous path gives: an
          // empty window, counted so the shard is visibly unhealthy rather than
          // silently under-selecting.
          failedTakes += 1
          capture = EMPTY_RAW
        }
        // Projected inside the chain, not when the reply landed, so the table's
        // first-sighting bookkeeping sees windows in boundary order.
        const projected = project.project(capture)
        appendTable(sink, projected)
        const records = build(projected)
        if (records !== null) appendRecords(sink, records)
      })
    },
    prepareAndFinish(prepare, updates, footer) {
      queue(async () => {
        await prepare()
        for (const row of updates()) sink.append(JSON.stringify(row))
        appendRecords(sink, footer())
      })
    },
    failedTakes: () => failedTakes + (source.lostTakes?.() ?? 0),
    drained: () => chain,
    reset() {
      failedTakes = 0
    },
  }
}

/**
 * The strategy a source needs, or a refusal to build one at all.
 *
 * A source that can neither take synchronously nor accept a boundary cannot be
 * recorded — and the failure it produces if allowed through is the worst kind
 * this project has: every window comes back empty, every test is recorded as
 * touching nothing, and the resulting map is complete, well-formed and says no
 * test reaches any code. That reads as a confident answer rather than as a fault,
 * so it is refused here, where the source is still in hand and can be named.
 */
function windowsFor(source: Source, sink: ShardSink, project: Projector): Windows {
  if (source.supportsSync) return syncWindows(source, sink, project)
  if (typeof (source as QueuedSource).dispatch === 'function') {
    return queuedWindows(source as QueuedSource, sink, project)
  }
  throw new Error(
    `the source "${source.kind}" can neither take synchronously nor accept a window boundary, ` +
      'so every window it produced would be empty and the map would record that no test reaches ' +
      'anything. Implement QueuedSource (dispatch plus settle) on it, or drive it from a caller ' +
      'that owns the whole run rather than from the Recorder.',
  )
}

export class Recorder {
  #windows: Windows
  #source: Source
  #projector: Projector
  #commit: string
  #sink: ShardSink
  #pid: number
  #role: 'service' | undefined
  #now: () => number
  #testCount = 0
  #loadCaptured = false
  #open:
    | ({ title: string; file: string | null; startedAt: number; ordinal?: number } & TestRefDetail)
    | null = null
  /** `(file, title)` -> occurrences seen this run. The first has no ordinal. */
  #ordinals = new Map<string, number>()
  /**
   * Reads noted during a spec's import phase, before any test window.
   *
   * `file` is the spec the adapter scoped them to, or `null` when it cannot say
   * (a process that imports several spec files). The build attributes a scoped
   * record to that spec's tests and an unscoped one to every test in the shard.
   */
  #spec: {
    file: string | null
    reads: Set<string>
    dirReads: Set<string>
    env: Set<string>
  } | null = null
  /**
   * Record-API declarations made after a test ended and before the next one
   * started, or before the run closed: a hook between tests, a `beforeAll` of a
   * later group, a global teardown. No test owns them, so they are filed like an
   * unscoped import-phase record, against every test in the shard — the
   * conservative reading of the `@between`/`@teardown` buckets they fall in.
   */
  #outside: {
    reads: Set<string>
    dirReads: Set<string>
    env: Set<string>
    opaque: Set<string>
  } | null = null
  /** Reads noted while a test window is open; cleared at each boundary. */
  #reads = new Set<string>()
  #dirReads = new Set<string>()
  /** Invisible dependencies the open test declared, by reason. */
  #opaque = new Set<string>()
  /** Environment variables the open test declared. Values are hashed, never kept. */
  #env = new Set<string>()
  /** Detaches the record API from this recorder when the window closes. */
  #releaseSink: (() => void) | null = null
  #owners: OwnerIndex | undefined
  #granularity: 'test' | 'group'
  /**
   * Tests that finished since the last take, in group mode.
   *
   * Their identity and evidence are taken at `testEnd`, synchronously, exactly as
   * the per-test record's fields are; only the window is deferred. `groupEnd`
   * hands the whole list to one take, so a queued source builds the record from
   * what was captured at the boundary rather than from the recorder's state later.
   */
  #pending: ShardGroupTest[] = []

  constructor(options: RecorderOptions) {
    this.#commit = options.commit
    this.#sink = options.sink
    this.#pid = options.pid ?? process.pid
    this.#role = options.role
    this.#now = options.now ?? Date.now
    this.#owners = options.owners
    this.#granularity = options.granularity ?? 'test'

    const scan = options.scan ?? {}
    const source = options.source
    this.#source = source
    // Projection only: no file is read and no position is resolved here. The
    // build does that once per distinct function (ADR-0002).
    this.#projector = projectorFor(source, scan)
    this.#windows = windowsFor(source, options.sink, this.#projector)
  }

  /**
   * A boundary's records: the ordinary one, plus whatever the correlation tags
   * make attributable.
   *
   * `build` receives the whole capture so it can say which ordinary record the
   * boundary produced. It must stay a pure function of that capture, for the same
   * reason the old builder did: a queued source runs it whenever the reply lands.
   */
  #emit(build: (capture: ProjectedCapture) => ShardRecord | null): void {
    this.#windows.commitWindow((capture) => {
      const records: ShardRecord[] = []
      const ordinary = build(capture)
      if (ordinary !== null) records.push(ordinary)

      const groups = [...capture.requests]
      // The ordinary window's coverage ran while these requests were open, so it
      // belongs to their tests too. Crediting it twice is what keeps one test's
      // boundary from stealing another test's request work; `buildMap` unions the
      // duplicate test records by title and file.
      if (capture.ids.length > 0 && hasTouches(capture.window.touches)) {
        groups.push({ ids: capture.ids, window: capture.window })
      }
      records.push(...this.#attributed(groups))
      return records.length === 0 ? null : records
    })
  }

  /**
   * Turns tagged coverage into `test` records, one per owning test.
   *
   * An id no test owns becomes `@between` rather than being dropped: the coverage
   * ran somewhere, and the only honest answer is the bucket that escalates. When
   * some ids resolve and others do not, the whole delta goes to the owners — a
   * take cannot be split, and crediting a known test with extra work costs a
   * selection; dropping it would cost a miss.
   */
  #attributed(groups: ProjectedCapture['requests']): ShardRecord[] {
    const records: ShardRecord[] = []
    for (const group of groups) {
      if (!hasTouches(group.window.touches)) continue
      const byOwner = new Map<string, ShardTest>()
      for (const id of group.ids) {
        const owner: CorrelatedTest | undefined = this.#owners?.ownerOf(id)
        if (owner === undefined) continue
        const key = `${owner.title}\u0000${owner.file ?? ''}\u0000${String(owner.ordinal ?? 0)}`
        const existing = byOwner.get(key)
        if (existing === undefined) {
          byOwner.set(key, {
            type: 'test',
            title: owner.title,
            file: owner.file,
            ...(owner.ordinal === undefined ? {} : { ordinal: owner.ordinal }),
            // Request coverage, not the owner's outcome. The builder unions the
            // touches into the owner's real test entry and never invents one from
            // this record, so a failed test cannot enter the map as passed.
            attributed: true,
            status: 'passed',
            durationMs: 0,
            touches: {},
          })
        }
        unionTouch(byOwner.get(key)!.touches, group.window.touches)
      }
      if (byOwner.size === 0) records.push({ type: 'between', touches: group.window.touches })
      else records.push(...byOwner.values())
    }
    return records
  }

  #bucket(kind: 'load' | 'between' | 'teardown'): void {
    this.#emit((capture) => {
      // Reads a service made outside any test (its startup config, a file between
      // tests, at teardown) arrive with this window. Without them a change to that
      // file would select nothing; the bucket carries them so the build files them
      // against the whole shard.
      const reads = unionSorted([], capture.reads)
      const dirReads = unionSorted([], capture.dirReads)
      const touched = hasTouches(capture.window.touches)
      if (!touched && reads.length === 0 && dirReads.length === 0) return null
      return {
        type: kind,
        touches: capture.window.touches,
        ...(reads.length === 0 ? {} : { reads }),
        ...(dirReads.length === 0 ? {} : { dirReads }),
      }
    })
  }

  /**
   * Writes the shard header. Call it as early as possible — at plugin-install
   * time, before the test files are imported — so that a crash leaves evidence
   * of how far the run got.
   *
   * It deliberately does NOT take a window. Importing the test files is what
   * produces the `@load` activity, and that happens *after* the source is
   * created but *before* the runner starts, so an early take would capture an
   * empty window and silently mis-file the entire load phase as `@between`.
   */
  runStart(): void {
    // A new recording owns its path — and its bookkeeping. A second run on the same
    // instance must not inherit the first run's header, tests, footer, ordinals,
    // load phase, open window, pending reads or failure count; before this, the
    // second run's import phase was filed as `@between` and its footer counted both
    // runs' tests.
    this.#sink.reset?.()
    this.#windows.reset?.()
    this.#testCount = 0
    this.#loadCaptured = false
    this.#ordinals.clear()
    this.#pending = []
    this.#open = null
    this.#spec = null
    this.#outside = null
    this.#reads.clear()
    this.#dirReads.clear()
    this.#opaque.clear()
    this.#env.clear()
    this.#releaseSink?.()
    this.#releaseSink = null
    this.#windows.commit({
      type: 'shard',
      version: SHARD_VERSION,
      commit: this.#commit,
      pid: this.#pid,
      startedAt: new Date(this.#now()).toISOString(),
      ...(this.#role === undefined ? {} : { role: this.#role }),
    })
  }

  /**
   * Open the import phase for a spec, so reads made before the first test are
   * recorded instead of dropped.
   *
   * Call it right after `runStart`, before the test file is imported. An adapter
   * that knows the file passes it; the others pass `null` and the build attributes
   * the reads to every test in the shard. The scope closes at the first `testStart`
   * (imports are over) or at `runEnd` for a file with no tests.
   */
  specStart(file: string | null = null): void {
    if (this.#spec !== null) return
    const spec = { file, reads: new Set<string>(), dirReads: new Set<string>(), env: new Set<string>() }
    this.#spec = spec
    // `recordEnv` has no open test here, and the record API reaches no recorder
    // outside a window, so the call would be dropped without a word. Point it at the
    // spec scope; `testStart` or `runEnd` releases it when the import phase is over.
    this.#releaseSink?.()
    this.#releaseSink = activateRecordSink({
      noteRead: () => {},
      noteReadDir: () => {},
      noteOpaque: () => {},
      noteDependency: () => {},
      noteEnv: (keys) => {
        for (const key of keys) spec.env.add(key)
      },
    })
  }

  #flushSpecReads(): void {
    const spec = this.#spec
    this.#spec = null
    if (spec === null) return
    this.#releaseSink?.()
    this.#releaseSink = null
    if (spec.reads.size === 0 && spec.dirReads.size === 0 && spec.env.size === 0) return
    // Hashed here, at the end of the import phase: the value in force when the
    // first test is about to run, and never the value itself.
    const env: Record<string, string> = {}
    for (const key of [...spec.env].sort()) env[key] = hashEnvValue(process.env[key])
    this.#windows.commit({
      type: 'loadReads',
      file: spec.file,
      ...(spec.reads.size === 0 ? {} : { reads: [...spec.reads].sort() }),
      ...(spec.dirReads.size === 0 ? {} : { dirReads: [...spec.dirReads].sort() }),
      ...(spec.env.size === 0 ? {} : { env }),
    })
  }

  /**
   * Point the record API at the out-of-window scope once a test window closes.
   *
   * Only explicit `record*` calls land here. The read tracker's incidental reads
   * between tests stay unattributed, as before: a recorder's own bookkeeping and a
   * runner's housekeeping would otherwise tie every change to every test.
   */
  #openOutside(): void {
    const scope = {
      reads: new Set<string>(),
      dirReads: new Set<string>(),
      env: new Set<string>(),
      opaque: new Set<string>(),
    }
    this.#outside = scope
    this.#releaseSink?.()
    this.#releaseSink = activateRecordSink({
      noteRead: (path) => scope.reads.add(path),
      noteReadDir: (dir) => scope.dirReads.add(dir),
      noteOpaque: (reason) => scope.opaque.add(reason),
      noteDependency: (paths) => {
        for (const path of paths) scope.reads.add(path)
      },
      noteEnv: (keys) => {
        for (const key of keys) scope.env.add(key)
      },
    })
  }

  #flushOutside(): void {
    const scope = this.#outside
    this.#outside = null
    if (scope === null) return
    this.#releaseSink?.()
    this.#releaseSink = null
    if (
      scope.reads.size === 0 &&
      scope.dirReads.size === 0 &&
      scope.env.size === 0 &&
      scope.opaque.size === 0
    ) {
      return
    }
    const env: Record<string, string> = {}
    for (const key of [...scope.env].sort()) env[key] = hashEnvValue(process.env[key])
    this.#windows.commit({
      type: 'loadReads',
      file: null,
      ...(scope.reads.size === 0 ? {} : { reads: [...scope.reads].sort() }),
      ...(scope.dirReads.size === 0 ? {} : { dirReads: [...scope.dirReads].sort() }),
      ...(scope.env.size === 0 ? {} : { env }),
      ...(scope.opaque.size === 0 ? {} : { opaque: [...scope.opaque].sort() }),
    })
  }

  testStart(title: string, file: string | null = null, detail: TestRefDetail = {}): void {
    this.#flushOutside()
    // Imports are over, so the spec's import-phase reads are complete. Commit
    // them before the first window: they are a plain record, not a capture.
    this.#flushSpecReads()
    // The first test's start is the moment the load phase ends: everything the
    // process executed up to here is module import, which is `@load`.
    if (!this.#loadCaptured) {
      this.#loadCaptured = true
      this.#bucket('load')
    } else if (this.#granularity === 'test') {
      // In group mode the gap belongs to the window of the group that follows:
      // the next take covers it (a group window cannot split its own interval).
      this.#bucket('between')
    }
    const key = `${file ?? ''}\u0000${title}`
    const seen = this.#ordinals.get(key) ?? 0
    this.#ordinals.set(key, seen + 1)
    this.#reads.clear()
    this.#dirReads.clear()
    this.#opaque.clear()
    this.#env.clear()
    this.#open = {
      title,
      file,
      startedAt: this.#now(),
      ...(seen === 0 ? {} : { ordinal: seen }),
      ...detail,
    }
    // The record API talks to whatever recorder is open, with no runner context
    // to pass. Releasing any previous sink first keeps a crashed window from
    // leaving the API pointed at a recorder that will never close it.
    this.#releaseSink?.()
    this.#releaseSink = activateRecordSink({
      noteRead: (path) => this.noteRead(path),
      noteReadDir: (dir) => this.noteReadDir(dir),
      noteOpaque: (reason) => this.noteOpaque(reason),
      noteEnv: (keys) => {
        for (const key of keys) this.noteEnv(key)
      },
      noteDependency: (paths) => {
        for (const path of paths) this.noteRead(path)
      },
    })
  }

  testEnd(title: string, status: TestStatus, durationMs?: number): void {
    // Every field that is not the window is read *here*, before the record is
    // handed over, and that is not tidiness. A queued source builds its record when
    // the reply lands, so anything read inside the builder would be read after the
    // run had moved on — the duration would absorb whatever happened in between,
    // and on a run whose windows are milliseconds long that is most of the value.
    // The builder's only job is to supply the touches.
    const open = this.#open
    const file = open?.title === title ? open.file : (open?.file ?? null)
    const elapsed = durationMs ?? (open === null ? 0 : this.#now() - open.startedAt)
    const ordinal = open?.title === title ? open.ordinal : undefined
    // Read synchronously, like every other field: a queued source builds the
    // record later, after the next test may already have started its own reads.
    const reads = [...this.#reads].sort()
    const dirReads = [...this.#dirReads].sort()
    const opaque = [...this.#opaque].sort()
    // Hashes, never values: a shard lives in the repository's state directory and a
    // CI secret must not. Read here, with the window's other fields.
    const env: Record<string, string> = {}
    for (const key of [...this.#env].sort()) env[key] = hashEnvValue(process.env[key])
    const titlePath = open?.title === title ? open.titlePath : undefined
    const line = open?.title === title ? open.line : undefined
    const column = open?.title === title ? open.column : undefined
    this.#reads.clear()
    this.#dirReads.clear()
    this.#opaque.clear()
    this.#env.clear()
    // The record API is bound to this window; detach it before the window closes
    // so a helper called during projection cannot be charged to the test.
    this.#releaseSink?.()
    this.#releaseSink = null
    this.#openOutside()
    // Close the window *before* emitting. A queued source projects the captured
    // bytes inside the builder, and the projector reads the generated file — a
    // read by the recorder itself, not by the test. Leaving the window open made
    // every test that ended with an async boundary look as if it had read every
    // source the window touched.
    this.#open = null

    const test: ShardGroupTest = {
      title,
      file,
      ...(ordinal === undefined ? {} : { ordinal }),
      ...(titlePath === undefined ? {} : { titlePath }),
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
      status,
      durationMs: elapsed,
      ...(reads.length === 0 ? {} : { reads }),
      ...(dirReads.length === 0 ? {} : { dirReads }),
      ...(opaque.length === 0 ? {} : { opaque }),
      ...(Object.keys(env).length === 0 ? {} : { env }),
    }

    if (this.#granularity === 'group') {
      // The window is not taken here; `groupEnd` takes it once for every test
      // that finished inside the group.
      this.#pending.push(test)
      this.#testCount += 1
      return
    }

    this.#emit((capture) => {
      // Reads a target made reach the recorder with the window they belong to, after
      // the boundary; the synchronous sets above hold this process's. One test record
      // carries both, so a service's read of a data file selects the test that drove
      // it exactly as a read in the test process does.
      const allReads = unionSorted(reads, capture.reads)
      const allDirReads = unionSorted(dirReads, capture.dirReads)
      return {
        ...test,
        type: 'test',
        touches: capture.window.touches,
        ...(allReads.length === 0 ? {} : { reads: allReads }),
        ...(allDirReads.length === 0 ? {} : { dirReads: allDirReads }),
      }
    })
    this.#testCount += 1
  }

  /**
   * Drop the open window without recording it.
   *
   * A runner can announce a test and then skip it: Jest emits `test_start`
   * followed by `test_skip`, never `test_done`, for a test its selection pattern
   * filtered out. That window is not a result. Recording it as skipped would put
   * a filtered test in the shard, and leaving it open would charge the next test's
   * start to it. The window and its pending evidence are discarded.
   */
  testAbandon(): void {
    if (this.#open === null) return
    this.#reads.clear()
    this.#dirReads.clear()
    this.#opaque.clear()
    this.#env.clear()
    this.#releaseSink?.()
    this.#releaseSink = null
    this.#openOutside()
    this.#open = null
  }

  /**
   * Close a group, taking the one window its tests share.
   *
   * Called by an adapter at its runner's group boundary (mocha's `suite end`,
   * japa's `group:end`). In group mode this is the only thing that takes coverage
   * during the run — `testEnd` accumulates instead — so the number of takes is the
   * number of groups, not twice the number of tests.
   *
   * An empty group takes nothing: a suite that ran no test has no window to
   * attribute, and its coverage belongs to whatever runs next (or to `@teardown`).
   * The tests are handed over by value before the take, because a queued source
   * builds the record when the reply lands.
   */
  groupEnd(): void {
    if (this.#granularity !== 'group') return
    if (this.#pending.length === 0) return
    const tests = this.#pending.splice(0)
    this.#emit((capture) => {
      // A target's reads arrive with this window, and a group window cannot say
      // which of its tests drove one; every test in the group carries them.
      const reads = unionSorted([], capture.reads)
      const dirReads = unionSorted([], capture.dirReads)
      return {
        type: 'group',
        tests,
        touches: capture.window.touches,
        ...(reads.length === 0 ? {} : { reads }),
        ...(dirReads.length === 0 ? {} : { dirReads }),
      }
    })
  }

  /**
   * Note a file read made while a test window is open.
   *
   * Called by `installReadTracking`, not by adapters directly. Reads before the
   * first test, between tests, and after the last one are not attributed: there is
   * no window to charge them to, and the load/between rules already cover startup
   * dependencies. A text oracle that runs inside a test is the case this exists
   * for.
   */
  noteRead(path: string): void {
    if (this.#open !== null) this.#reads.add(path)
    else this.#spec?.reads.add(path)
  }

  /** Note a directory listing made while a test window is open. */
  noteReadDir(path: string): void {
    if (this.#open !== null) this.#dirReads.add(path)
    else this.#spec?.dirReads.add(path)
  }

  /** Note an invisible dependency of the open test. See `recordOpaque`. */
  /**
   * Note an environment variable the open test declared.
   *
   * Synchronous, like the other record calls: the hash is taken at `testEnd` from
   * the value in force while the window runs, so a test that mutates its own
   * environment is recorded against the value it actually used.
   */
  noteEnv(key: string): void {
    if (this.#open !== null) this.#env.add(key)
  }

  noteOpaque(reason: string): void {
    if (this.#open !== null) this.#opaque.add(reason)
  }

  runEnd(): void {
    // A file with no tests never reached `testStart`, so its import-phase reads
    // are still open.
    this.#flushSpecReads()
    this.#flushOutside()
    // A test that never reported its end (a crash in the runner) must not leave
    // the record API pointed at a window that is about to be torn down.
    this.#releaseSink?.()
    this.#releaseSink = null
    // A run with no tests never reached the first `testStart`, so the load
    // window is still outstanding.
    if (!this.#loadCaptured) {
      this.#loadCaptured = true
      this.#bucket('load')
    }
    // A group the runner never closed — root-level tests, or an adapter whose last
    // boundary came before its last test — is flushed here. Its window covers
    // everything since the previous take, so it over-attributes rather than
    // dropping tests that ran.
    this.groupEnd()
    // Post-run activity — global teardown hooks, a timer from the last test that
    // fired late. Filed separately from @between because §8.3 treats a file
    // reached only by teardown as startup code, like @load.
    this.#bucket('teardown')

    // The footer is built after every window (including teardown) settles, so a
    // queued source's drift count is whole. The source then prepares generated
    // script text — outside every window, because a fetch in a closing window
    // lengthened it and showed up as drift (`cbd-x2j`, the straddle e2e) — and the
    // table updates and footer are written behind the windows they follow.
    const tests = this.#testCount
    const finishedAt = new Date(this.#now()).toISOString()
    const source = this.#source
    const projector = this.#projector
    this.#windows.prepareAndFinish(
      () => source.prepare?.(projector.scriptIds()),
      () => projector.finish(),
      () => {
        // Built after `prepare`, so the generated fetch has recorded what it could
        // not produce. A clean run has nothing to say and writes no health record.
        const missing = source.generatedMissing?.() ?? []
        const failed = this.#windows.failedTakes()
        const drift = driftOf(source)
        const end: ShardRecord = {
          type: 'end',
          tests,
          finishedAt,
          ...(drift === null ? {} : { drift }),
        }
        if (missing.length === 0 && failed === 0) return end
        const health: ShardHealth = {
          type: 'health',
          ...(missing.length === 0 ? {} : { generatedMissing: [...missing] }),
          ...(failed === 0 ? {} : { failedTakes: failed }),
        }
        return [health, end]
      },
    )
  }

  /**
   * Resolves once every record has reached the sink.
   *
   * A caller driving a synchronous source can ignore this — its `runEnd` has
   * already written the footer. A caller driving a queued one must await it, or
   * the process can exit with records still in flight and the shard left without
   * its footer, which `parseShard` refuses.
   */
  drained(): Promise<void> {
    return this.#windows.drained()
  }

  /**
   * Releases the coverage source. Call it once the run is over, after `drained()`.
   *
   * A source holds a resource, and the resource is not inert. `socketSource` holds an
   * open `net.Socket`, and an open socket keeps Node's event loop alive — so a
   * recorded run that never closes its source prints its summary, reports every test
   * green, and then hangs forever. Measured: `packages/japa/bin/e2e.js` with a socket
   * directory set never exited, and the same entry point without one exited in 0.06s.
   * That failure is worse than a crash, because the output says the run succeeded and
   * only a CI timeout says otherwise.
   *
   * The recorder closes what it was handed rather than expecting the caller to keep a
   * second reference to it. Ownership follows the constructor argument.
   *
   * Closing before `drained()` would lose records rather than merely tidy up, which is
   * why the adapters close afterwards and not at the first opportunity.
   */
  close(): void {
    this.#source.close()
  }
}
