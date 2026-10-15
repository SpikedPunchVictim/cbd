/**
 * Turns a test run into shard records.
 *
 * The whole thing is synchronous, and that is a requirement rather than a style
 * choice: japa does not await its lifecycle hooks (A0 F1), so a handler that
 * awaited anything would take its coverage after the next test had already
 * started and attribute one test's execution to another. The `Source` is used
 * through `takeSync()` for the same reason.
 *
 * Buckets, and why each exists:
 *   per-test   the window between a test's start and its end. The product.
 *   @load      everything before the first test — module imports. Recorded at
 *              `runStart`, which only works because the source is created before
 *              the test files are imported.
 *   @between   everything outside a window: a background timer, a lazily loaded
 *              module, work between tests. Unattributable, so the selector has to
 *              treat it as reaching every test.
 */
import { normalize, type ScanOptions, type Touch } from './normalize.js'
import { SHARD_VERSION, type ShardSink, type TouchRef } from './shard.js'
import type { Source } from './types.js'

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
  /** Forwarded to `normalize` — projection rules, include/exclude, prefilter. */
  scan?: ScanOptions
  pid?: number
  now?: () => number
}

function toRefs(touches: Touch[]): TouchRef[] {
  return touches.map((touch) => [touch.file, touch.key, touch.startLine, touch.endLine])
}

export class Recorder {
  #source: Source
  #sink: ShardSink
  #commit: string
  #scan: ScanOptions
  #pid: number
  #now: () => number
  #testCount = 0
  #loadCaptured = false
  #open: { title: string; file: string | null; startedAt: number } | null = null

  constructor(options: RecorderOptions) {
    this.#source = options.source
    this.#sink = options.sink
    this.#commit = options.commit
    this.#scan = options.scan ?? {}
    this.#pid = options.pid ?? process.pid
    this.#now = options.now ?? Date.now
  }

  #take(): TouchRef[] {
    try {
      return toRefs(normalize(this.#source.takeSync(), this.#source, this.#scan))
    } catch {
      // A dead inspector session must not take the test run down with it. An
      // empty window under-selects for that test, which is why the run should
      // also be reported as unhealthy rather than silently trusted.
      return []
    }
  }

  #bucket(kind: 'load' | 'between'): void {
    const touches = this.#take()
    if (touches.length === 0) return
    this.#sink.append(JSON.stringify({ type: kind, touches }))
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
    this.#sink.append(
      JSON.stringify({
        type: 'shard',
        version: SHARD_VERSION,
        commit: this.#commit,
        pid: this.#pid,
        startedAt: new Date(this.#now()).toISOString(),
      }),
    )
  }

  testStart(title: string, file: string | null = null): void {
    // The first test's start is the moment the load phase ends: everything the
    // process executed up to here is module import, which is `@load`.
    if (!this.#loadCaptured) {
      this.#loadCaptured = true
      this.#bucket('load')
    } else {
      this.#bucket('between')
    }
    this.#open = { title, file, startedAt: this.#now() }
  }

  testEnd(title: string, status: TestStatus, durationMs?: number): void {
    const touches = this.#take()
    const open = this.#open
    this.#sink.append(
      JSON.stringify({
        type: 'test',
        title,
        file: open?.title === title ? open.file : (open?.file ?? null),
        status,
        durationMs: durationMs ?? (open === null ? 0 : this.#now() - open.startedAt),
        touches,
      }),
    )
    this.#testCount += 1
    this.#open = null
  }

  runEnd(): void {
    // A run with no tests never reached the first `testStart`, so the load
    // window is still outstanding.
    if (!this.#loadCaptured) {
      this.#loadCaptured = true
      this.#bucket('load')
    }
    this.#bucket('between')
    this.#sink.append(
      JSON.stringify({
        type: 'end',
        tests: this.#testCount,
        finishedAt: new Date(this.#now()).toISOString(),
      }),
    )
  }
}
