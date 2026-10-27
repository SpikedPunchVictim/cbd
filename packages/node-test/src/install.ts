/**
 * The adapter's work, with `node:test`'s hooks and functions injected.
 *
 * The register entry imports the hooks from the consumer's Node and passes them
 * here; this module imports nothing from the runner, so it can be read and tested
 * without a `node --test` run.
 *
 * **One source and one shard per test file.** `node:test` runs each file in a
 * child process by default, and the register module is loaded in that child before
 * the test file is evaluated — which is where a recorder must start, because the
 * file's import phase is `@load`. The file's `after` hook writes the footer.
 *
 * Events used:
 *   beforeEach -> a window opens (statically skipped tests never reach a hook); a
 *                 subtest, whose name extends the open window's, opens none
 *   afterEach  -> a window closes with `passed`
 *   after      -> the footer
 *
 * A test that skips itself from inside its body still reports `passed: true`, so
 * the hook wraps the context's `skip`/`todo` calls to remember that it happened.
 * Node 22 does not call `afterEach` for such a test at all: the next
 * `beforeEach`, or the file's `after`, closes the window as skipped. A
 * non-skipped window still open at `after` refuses the shard.
 * A test registered `{todo: true}` never runs its body but *does* reach the hooks,
 * and Node exposes no marker for it; it is recorded as passed with a hooks-only
 * window, which can only over-select. Selection is handled by the register entry
 * (`--test-name-pattern`), not here.
 */
import {
  FileSink,
  Recorder,
  inProcessSource,
  installProcessTracking,
  installReadTracking,
  granularityFromEnv,
  scanFromEnv,
  realpath,
} from '@spikedpunch/cbd/adapter'
import {
  fileOf,
  shardPathFor,
  statusOf,
  titleOf,
  type NodeTestContextLike,
} from './identity.js'
import { withSelfRoot } from './self.js'

/** Warn once per process, not once per test file. */
let warnedGranularity = false

/** The runner's registration functions, as the consumer's Node provides them. */
export interface NodeTestHooks {
  beforeEach(fn: (context: NodeTestContextLike) => void): unknown
  afterEach(fn: (context: NodeTestContextLike) => void): unknown
  after(fn: () => void): unknown
}

/** `node:test` exports `beforeEach` etc. as functions with more overloads than we use. */
export async function installNodeTest(hooks: NodeTestHooks): Promise<void> {
  const base = process.env.CBD_SHARD
  if (base === undefined || base === '') return

  if (process.env.NODE_TEST_CONTEXT === undefined) {
    process.stderr.write(
      'cbd: node:test is running without process isolation (--test-isolation=none); the ' +
        'adapter records one shard per test-file process, so nothing was recorded.\n',
    )
    return
  }

  const file = absolute(process.argv[1] ?? `${String(process.pid)}-${String(process.ppid)}`)

  // No suite boundary is reported here, so a group request would collapse the
  // file's tests into one window. Warn and record per test.
  if (granularityFromEnv() === 'group' && !warnedGranularity) {
    warnedGranularity = true
    process.stderr.write(
      'cbd: the node:test adapter has no group boundary, so granularity "group" records per test.\n',
    )
  }

  const source = await inProcessSource()
  const recorder = new Recorder({
    source,
    sink: new FileSink(shardPathFor(base, file)),
    commit: process.env.CBD_COMMIT || 'unknown',
    scan: withSelfRoot(scanFromEnv()),
  })
  recorder.runStart()
  // The test file imports after this module; its module-scope reads belong to it.
  recorder.specStart(null)
  const stopReads = installReadTracking(recorder)
  const stopProcesses = installProcessTracking(recorder)

  const opened = new WeakSet<object>()
  const skipped = new WeakSet<object>()
  /** Subtests: they share their top-level test's window. */
  const nested = new WeakSet<object>()
  let open = 0
  let refused = false
  let warnedNoFullName = false
  /** The window `afterEach` has not closed yet, and the title it was opened with. */
  let pending: { context: NodeTestContextLike; title: string } | null = null

  /**
   * Close a window whose `afterEach` never ran.
   *
   * Node 22 does not call `afterEach` for a test whose body called `t.skip()`.
   * The next `beforeEach`, or the file's `after`, is the first chance to close
   * it; without this the next test looked concurrent and the file was refused,
   * or a skipped last test vanished from the shard.
   */
  const closePendingSkip = (): void => {
    if (pending === null || !skipped.has(pending.context)) return
    const { context, title } = pending
    pending = null
    opened.delete(context)
    open -= 1
    recorder.testEnd(title, statusOf(context, true))
  }

  hooks.beforeEach((context) => {
    closePendingSkip()
    const title = titleOf(context)
    if (title === null) return
    // A subtest (`t.test(...)`) reaches this hook while its parent's window is open,
    // and its full name extends the parent's. It opens no window: everything it
    // touches belongs to the top-level test, and selecting that test re-runs it.
    if (pending !== null && title.startsWith(`${pending.title} > `)) {
      nested.add(context)
      return
    }
    if (!warnedNoFullName && (context.fullName === undefined || context.fullName === '')) {
      warnedNoFullName = true
      process.stderr.write(
        'cbd: this Node reports no `fullName` on TestContext (added in Node 20.16/22.8); ' +
          'tests are recorded by bare name, so same-named tests in one file can conflate.\n',
      )
    }

    // `t.skip()`/`t.todo()` inside the body do not change `passed`; remember the
    // call so `afterEach` (or `closePendingSkip`) can classify the window honestly.
    remember(context, 'skip')
    remember(context, 'todo')

    // A concurrent subtree (`{ concurrency: true }`, or a concurrent describe)
    // opens a second window while the first is still recording. A consumer
    // `afterEach` that threw stops Node's hook chain before this adapter's own
    // `afterEach`, which leaves the previous window open with the same symptom. The
    // two cannot be told apart here, and both lose a boundary the recorder cannot
    // attribute, so the run stops and the shard is left incomplete either way.
    if (open > 0) {
      refused = true
      throw new Error(
        'cbd: a test window was still open when the next test started — the runner ' +
          'overlapped tests, or a hook stopped the boundary from closing (a throwing ' +
          'afterEach does this). Recording cannot attribute coverage to one window then, ' +
          'so the run stops and the shard is left incomplete. Record with concurrency ' +
          'disabled.',
      )
    }
    recorder.testStart(title, absolute(fileOf(context) ?? file))
    opened.add(context)
    pending = { context, title }
    open += 1
  })

  hooks.afterEach((context) => {
    if (nested.has(context)) return
    if (!opened.has(context)) return
    opened.delete(context)
    if (pending?.context === context) pending = null
    open -= 1
    const title = titleOf(context)
    if (title === null) return
    recorder.testEnd(title, statusOf(context, skipped.has(context)))
  })

  hooks.after(async () => {
    // A body skip that is the file's last test never reaches another
    // `beforeEach`; close it here with its own status.
    closePendingSkip()
    if (refused || pending !== null) {
      // No end record: a window that did not close where the runner should have
      // closed it cannot be attributed honestly, so the build must refuse it.
      source.close()
      stopReads()
      stopProcesses()
      return
    }
    // Outside every test window: transformed-script coordinates are fetched here.
    await recorder.runEnd()
    source.close()
    stopReads()
    stopProcesses()
  })

  function remember(context: NodeTestContextLike, method: 'skip' | 'todo'): void {
    const original = context[method]
    if (typeof original !== 'function') return
    context[method] = (...args: unknown[]) => {
      skipped.add(context)
      return original.apply(context, args)
    }
  }
}

/** The map keys are realpaths, and the runner reports the path it was given. */
function absolute(file: string): string
function absolute(file: null): null
function absolute(file: string | null): string | null
function absolute(file: string | null): string | null {
  if (file === null) return null
  try {
    return realpath(file)
  } catch {
    return file
  }
}
