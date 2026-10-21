/**
 * The Vitest adapter's work, with the runner's hook functions injected.
 *
 * **Why injection.** `import { beforeEach } from 'vitest'` must resolve to the
 * *consumer's* Vitest, or the hooks register in a different runner's state and never
 * run. A published package installed in the consumer's tree resolves its peer that
 * way naturally; this seam also makes the adapter testable against a project whose
 * Vitest is outside this package's dependency tree (a real app in a temp directory,
 * a second major version), by passing that project's own hooks in.
 *
 * The two entry points are:
 *   - `src/setup.ts`, the published `@spikedpunch/cbd-vitest/setup` specifier, which
 *     imports the hooks from its peer and calls this;
 *   - `installVitest(hooks)` for a wrapper setup inside a consumer that resolves
 *     them itself.
 */
import { realpathSync } from 'node:fs'
import { threadId } from 'node:worker_threads'
import {
  FileSink,
  Recorder,
  inProcessSource,
  installProcessTracking,
  installReadTracking,
  readSelection,
  scanFromEnv,
} from '@spikedpunch/cbd/adapter'
import { fileOf, shardPathFor, statusOf, titleOf, type VitestTaskLike } from './identity.js'
import { withSelfRoot } from './self.js'

/** The part of a hook's context this adapter reads. Structural, not Vitest's type. */
export interface VitestHookContext {
  task?: VitestTaskLike
  /** Skip the current test without running its body. */
  skip?: () => void
}

/** The runner's registration functions, as the consumer's Vitest provides them. */
export interface VitestHooks {
  beforeEach(fn: (context: VitestHookContext) => void): unknown
  afterEach(fn: (context: VitestHookContext) => void): unknown
  afterAll(fn: () => void): unknown
}

interface VitestWorkerScope {
  __vitest_worker__?: { filepath?: string }
  __cbdVitestNoService?: true
}

/**
 * Install the adapter for the current test file, if `CBD_SHARD` asks for it.
 *
 * Awaited by the setup entry: the source must be created (and the injected
 * instrument stood down) before the test file imports, which is what puts the
 * file's import phase in `@load`.
 */
export async function installVitest(hooks: VitestHooks): Promise<void> {
  const base = process.env.CBD_SHARD
  if (base === undefined || base === '') return

  const scope = globalThis as VitestWorkerScope
  const file = scope.__vitest_worker__?.filepath

  const socketDir = process.env.CBD_SOCKET_DIR
  if (socketDir !== undefined && socketDir !== '' && scope.__cbdVitestNoService !== true) {
    scope.__cbdVitestNoService = true
    process.stderr.write(
      'cbd: the Vitest adapter records the test process only; a separately started service is ' +
        'not collected, so a change to its code will run the whole suite.\n',
    )
  }

  const source = await inProcessSource()
  const recorder = new Recorder({
    source,
    sink: new FileSink(shardPathFor(base, file ?? `${String(process.pid)}-${String(threadId)}`)),
    commit: process.env.CBD_COMMIT ?? 'unknown',
    scan: withSelfRoot(scanFromEnv()),
  })
  recorder.runStart()
  // The test file imports after this setup file; a module-scope read belongs to
  // the tests in this file, and the worker filepath is the scope.
  recorder.specStart(file ?? null)
  // The setup file runs once per test file; installs form a stack so the active
  // file's recorder receives the reads.
  const stopReads = installReadTracking(recorder)
  const stopProcesses = installProcessTracking(recorder)

  const selection = readSelection(process.env)
  const wanted = selection === undefined ? null : new Set(selection)
  const opened = new WeakSet<object>()
  const filtered = new WeakSet<object>()
  let open = 0
  let refused = false

  hooks.beforeEach((context) => {
    const task = context.task
    // A statically skipped test opens no window: there is nothing to record.
    if (task === undefined || task.mode === 'skip') return
    const title = titleOf(task)
    if (title === null) return
    if (wanted !== null && !wanted.has(title)) {
      filtered.add(task)
      context.skip?.()
      return
    }
    // The Recorder attributes coverage and reads to one open window. A runner that
    // overlaps tests (`test.concurrent`, or `sequence.concurrent` in the config)
    // would charge one test's execution to another, so this adapter declines to
    // record rather than write a map that is confidently wrong.
    if (open > 0) {
      refused = true
      throw new Error(
        'cbd: Vitest is running tests concurrently, but recording attributes coverage ' +
          'and reads to one open test window. Record without test.concurrent (or with ' +
          'sequence.concurrent disabled). The shard is left incomplete so it cannot be ' +
          'selected from.',
      )
    }
    recorder.testStart(title, absolute(fileOf(task) ?? file ?? null))
    opened.add(task)
    open += 1
  })

  hooks.afterEach((context) => {
    const task = context.task
    if (task === undefined || !opened.has(task) || filtered.has(task)) return
    const title = titleOf(task)
    if (title === null) return
    recorder.testEnd(title, statusOf(task.result?.state))
    open -= 1
  })

  hooks.afterAll(async () => {
    // No end record after a refused run: the build refuses an incomplete shard,
    // so overlapping windows can never silently become a map. The source is still
    // closed (outside every window) so a recording run leaves no handle behind.
    if (refused) {
      source.close()
      stopReads()
      stopProcesses()
      return
    }
    // Outside every test window: the source fetches generated script text for
    // transformed modules before the table is finalized (`cbd-x2j`).
    await recorder.runEnd()
    source.close()
    stopReads()
    stopProcesses()
  })
}

/** The map keys are realpaths, and Vitest reports the path it was given. */
function absolute(file: string): string
function absolute(file: null): null
function absolute(file: string | null): string | null
function absolute(file: string | null): string | null {
  if (file === null) return null
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}
