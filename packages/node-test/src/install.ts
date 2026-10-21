/**
 * The adapter's work, with `node:test`'s hook functions injected.
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
 *   beforeEach -> a window opens (statically skipped tests never reach a hook)
 *   afterEach  -> a window closes with `passed`
 *   after      -> the footer
 *
 * A test that skips itself from inside its body still reports `passed: true`, so
 * the hook wraps the context's `skip`/`todo` calls to remember that it happened.
 * A test registered `{todo: true}` never runs its body but *does* reach the hooks,
 * and Node exposes no marker for it; it is recorded as passed with a hooks-only
 * window, which can only over-select. Selection is handled by the register entry
 * (`--test-name-pattern`), not here.
 */
import { realpathSync } from 'node:fs'
import {
  FileSink,
  Recorder,
  inProcessSource,
  installReadTracking,
  scanFromEnv,
} from '@spikedpunch/cbd/adapter'
import {
  fileOf,
  shardPathFor,
  statusOf,
  titleOf,
  type NodeTestContextLike,
} from './identity.js'
import { withSelfRoot } from './self.js'

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

  const source = await inProcessSource()
  const recorder = new Recorder({
    source,
    sink: new FileSink(shardPathFor(base, file)),
    commit: process.env.CBD_COMMIT ?? 'unknown',
    scan: withSelfRoot(scanFromEnv()),
  })
  recorder.runStart()
  const stopReads = installReadTracking(recorder)

  const opened = new WeakSet<object>()
  const skipped = new WeakSet<object>()
  let open = 0
  let refused = false
  let warnedNoFullName = false

  hooks.beforeEach((context) => {
    const title = titleOf(context)
    if (title === null) return
    if (!warnedNoFullName && (context.fullName === undefined || context.fullName === '')) {
      warnedNoFullName = true
      process.stderr.write(
        'cbd: this Node reports no `fullName` on TestContext (added in Node 20.16/22.8); ' +
          'tests are recorded by bare name, so same-named tests in one file can conflate.\n',
      )
    }

    // `t.skip()`/`t.todo()` inside the body do not change `passed`; remember the
    // call so `afterEach` can classify the window honestly.
    remember(context, 'skip')
    remember(context, 'todo')

    // A concurrent subtree (`{ concurrency: true }`, or a concurrent describe)
    // opens a second window while the first is still recording. The Recorder
    // attributes coverage and reads to one open window, so the run is refused
    // rather than recorded wrongly.
    if (open > 0) {
      refused = true
      throw new Error(
        'cbd: node:test is running tests concurrently, but recording attributes coverage ' +
          'and reads to one open test window. Record with concurrency disabled. The shard ' +
          'is left incomplete so it cannot be selected from.',
      )
    }
    recorder.testStart(title, absolute(fileOf(context) ?? file))
    opened.add(context)
    open += 1
  })

  hooks.afterEach((context) => {
    if (!opened.has(context)) return
    opened.delete(context)
    open -= 1
    const title = titleOf(context)
    if (title === null) return
    recorder.testEnd(title, statusOf(context, skipped.has(context)))
  })

  hooks.after(async () => {
    if (refused) {
      // No end record: the build refuses an incomplete shard, so an overlapping
      // run cannot silently become a map.
      source.close()
      stopReads()
      return
    }
    // Outside every test window: transformed-script coordinates are fetched here.
    await recorder.runEnd()
    source.close()
    stopReads()
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
    return realpathSync(file)
  } catch {
    return file
  }
}
