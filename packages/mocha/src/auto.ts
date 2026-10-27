/**
 * `NODE_OPTIONS="--import @spikedpunch/cbd-mocha/auto"` and mocha records itself.
 *
 * The same bargain the japa adapter makes: no `cbd` command to remember, and
 * nothing to add to the consumer's test files or npm scripts. japa handed its
 * adapter the emitter, so it needed no patch at all (A0 F7); mocha has no such
 * hand-off, so this patches the one method every mocha run goes through.
 *
 * `run()` is called *after* the test files have been imported — VS Code's
 * `test/unit/node/index.js` does its own loading and only then calls
 * `runner.run()` — but that is not too late. Mocha reads root hooks off the root
 * suite when the runner reaches each test, not when the suite was built, so hooks
 * added at `run()` time still bound every window.
 *
 * The top-level await is load-bearing rather than decorative. `run()` is
 * synchronous and cannot await an inspector connection, so the session is opened
 * here, while Node is still resolving the `--import` list — before the consumer's
 * entry point exists. Racing an async install against the first test instead
 * would risk opening that window late, and a window that opens late is missing
 * coverage, which under-selects.
 *
 * **Selecting and recording are independent**, as they are in the japa plugin. A
 * run can be narrowed without being recorded (`CBD_SELECTION` alone) or recorded
 * without being narrowed (`CBD_SHARD` alone). `cbd collect` sets both; a consumer
 * that never runs it sets neither, and the module is inert.
 *
 * **An inert process must not load the core.** Every child a test spawns inherits
 * `NODE_OPTIONS`, so this module runs in each of them; without a shard or a
 * selection there is nothing to do. Importing the core graph statically to
 * discover that cost 60 ms per child against 6 ms for a bare node, and a large
 * suite spawns hundreds (measured: 140 on VS Code's `vs/platform` scope, ~8 s of
 * the run's overhead). The core and the adapter are therefore dynamic imports
 * behind the branch that needs them, and only their types are static.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Recorder } from '@spikedpunch/cbd/adapter'
import type { InstalledAdapter } from './adapter.js'
import { selectionPattern } from './selection.js'
import type Mocha from 'mocha'

/**
 * Find the consumer's mocha.
 *
 * It has to be *their* mocha, not ours: the adapter patches `Mocha.prototype`, and
 * `import Mocha from 'mocha'` in the consumer's runner only sees that patch if
 * both resolve to the same module instance.
 *
 * Under pnpm's strict layout the consumer's mocha is not reachable from a
 * repository root, so the search starts at the working directory and falls back
 * to this package's own copy — which is the one that answers when the adapter is
 * being exercised by its own tests.
 */
function resolveMocha(): typeof import('mocha') {
  const candidates = [
    process.env.CBD_MOCHA_ROOT === undefined
      ? null
      : join(process.env.CBD_MOCHA_ROOT, 'package.json'),
    join(process.cwd(), 'package.json'),
    fileURLToPath(new URL('../../package.json', import.meta.url)),
  ].filter((path): path is string => path !== null)

  const failures: string[] = []
  for (const base of candidates) {
    try {
      return createRequire(base)('mocha') as typeof import('mocha')
    } catch (error) {
      failures.push(`  from ${base}: ${(error as Error).message}`)
    }
  }
  throw new Error(`@spikedpunch/cbd-mocha/auto could not resolve "mocha":\n${failures.join('\n')}`)
}

/** Set by the first process that checks a selection ran something, so no descendant does. */
const GUARD_ENV = 'CBD_MOCHA_SELECTION_GUARD'

const shardPath = process.env.CBD_SHARD || undefined
// The runner owns this shard for this process only. A child a test spawns inherits
// both the preload (`NODE_OPTIONS`) and this variable, and its own preload would
// reset the shard this process is writing — measured: one `node -e` child replaced
// a complete parent shard with its own header line. The value has been read, so
// removing it makes every descendant inert, exactly as the japa entry point does.
if (shardPath !== undefined) delete process.env.CBD_SHARD
/** Whether this process has anything to do at all; an empty selection is nothing. */
const selecting = (process.env.CBD_SELECTION ?? '') !== ''

if (shardPath !== undefined || selecting) {
  // Loaded here rather than at the top of the module: an inert process (a child a
  // test spawned) must not pay for the core graph. See the docblock.
  const core = await import('@spikedpunch/cbd/adapter')
  const { attachGroupEnd, beginShard, installMochaAdapter } = await import('./adapter.js')
  // Read before the suite is imported: a malformed or empty selection must fail
  // here, while the message can still say which file is wrong, rather than after
  // mocha has already loaded every test file.
  const only = core.readSelection(process.env)

  let recorder: Recorder | null = null
  let stopReads: (() => void) | null = null
  let stopProcesses: (() => void) | null = null
  if (shardPath !== undefined) {
    const source = await core.inProcessSource()
    const scan = core.scanFromEnv()
    recorder = beginShard({
      source,
      sink: new core.FileSink(shardPath),
      commit: process.env.CBD_COMMIT || 'unknown',
      ...(scan === undefined ? {} : { scan }),
      ...(core.granularityFromEnv() === undefined ? {} : { granularity: 'group' }),
    })
    stopReads = core.installReadTracking(recorder)
    stopProcesses = core.installProcessTracking(recorder)
  }

  const MochaClass = resolveMocha()
  const originalRun = MochaClass.prototype.run
  const pattern = only === undefined ? undefined : selectionPattern(only)
  let adapter: InstalledAdapter | null = null

  MochaClass.prototype.run = function (
    this: Mocha,
    callback?: (failures: number) => void,
  ): Mocha.Runner {
    // The selection wins over a grep the consumer's own command line named.
    // `collect` computed the subset from the map; a second filter can only make
    // the run narrower than the set that was selected, which is the direction this
    // project refuses. Replacing it can only run more, which is safe.
    if (pattern !== undefined) {
      // `--invert` is the exception: it would run the complement of the selection,
      // skipping every test collect chose, with no sign that it happened. Mocha has
      // no way to unset it, so the run stops instead of measuring the wrong set.
      if (this.options.invert === true) {
        throw new Error(
          'cbd: a selection was supplied, but mocha was started with --invert; ' +
            'running the complement would skip every selected test',
        )
      }
      this.grep(pattern)
    }

    // Only the process that runs the suite checks that something ran. A test that
    // spawns its own mocha, and every parallel worker (a file with none of the
    // selected tests is normal there), inherits the selection and must not fail on it;
    // the marker is set before any of them exist.
    const guard = pattern !== undefined && process.env[GUARD_ENV] === undefined
    if (guard) process.env[GUARD_ENV] = '1'
    let ran = 0
    const settle = (failures: number): number => {
      if (!guard || ran > 0) return failures
      process.stderr.write(
        'cbd: the selection named tests, but no test ran, so the run proves nothing. ' +
          'Failing the run rather than reporting a pass with nothing run.\n',
      )
      process.exitCode = 1
      return failures === 0 ? 1 : failures
    }
    const counted = (runner: Mocha.Runner): Mocha.Runner => {
      // A skipped test is reported as pending and is not "nothing ran".
      runner.on('test end', () => void (ran += 1))
      runner.on('pending', () => void (ran += 1))
      return runner
    }

    if (recorder !== null && this.options.parallel === true) {
      // Workers run the tests in other processes, where nothing records: this
      // process sees no windows, and an empty shard is a valid one.
      process.stderr.write(
        'cbd: mocha is running with --parallel, whose tests run in worker processes the ' +
          'recorder does not reach, so this run records no tests. Run without --parallel to collect.\n',
      )
    }

    if (recorder === null || adapter !== null) {
      // A second Mocha instance in the same process. VS Code's node runner builds
      // exactly one — the extra instance the mocha CLI constructs when it is
      // invoked *that* way is the reason to prefer `node test/unit/node/index.js`.
      // Recording two instances into one shard would interleave their windows and
      // lose the boundaries, so the first instance wins and the second runs
      // unrecorded rather than corrupting the first.
      return counted(originalRun.call(this, (failures: number) => callback?.(settle(failures))))
    }

    const first = installMochaAdapter(this, recorder)
    adapter = first

    const runner = originalRun.call(this, async (failures: number) => {
      // Mocha's CLI exits from this callback, so the footer and the generated
      // coordinates must be written before it is called.
      await first.finish()
      stopReads?.()
      stopProcesses?.()
      stopProcesses = null
      return callback?.(settle(failures))
    })
    counted(runner)
    // One window per suite, when the recording asked for group granularity. The
    // listener is inert in per-test mode (`groupEnd` is a no-op). A suite end is
    // asynchronous, so attaching after `run` returns still sees every one; a
    // root-level test with no suite boundary of its own is flushed at `runEnd`.
    attachGroupEnd(runner, recorder)
    return runner
  }
}
