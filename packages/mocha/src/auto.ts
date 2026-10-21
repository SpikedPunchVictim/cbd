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
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FileSink,
  inProcessSource,
  installReadTracking,
  readSelection,
  scanFromEnv,
  type Recorder,
} from '@spikedpunch/cbd/adapter'
import { beginShard, installMochaAdapter, type InstalledAdapter } from './adapter.js'
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

const shardPath = process.env.CBD_SHARD
// Read before the suite is imported: a malformed or empty selection must fail
// here, while the message can still say which file is wrong, rather than after
// mocha has already loaded every test file.
const only = readSelection(process.env)

let recorder: Recorder | null = null
let stopReads: (() => void) | null = null
if (shardPath !== undefined) {
  const source = await inProcessSource()
  const scan = scanFromEnv()
  recorder = beginShard({
    source,
    sink: new FileSink(shardPath),
    commit: process.env.CBD_COMMIT ?? 'unknown',
    ...(scan === undefined ? {} : { scan }),
  })
  stopReads = installReadTracking(recorder)
}

if (recorder !== null || only !== undefined) {
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

    if (recorder === null || adapter !== null) {
      // A second Mocha instance in the same process. VS Code's node runner builds
      // exactly one — the extra instance the mocha CLI constructs when it is
      // invoked *that* way is the reason to prefer `node test/unit/node/index.js`.
      // Recording two instances into one shard would interleave their windows and
      // lose the boundaries, so the first instance wins and the second runs
      // unrecorded rather than corrupting the first.
      return originalRun.call(this, callback)
    }

    const first = installMochaAdapter(this, recorder)
    adapter = first

    return originalRun.call(this, async (failures: number) => {
      // Mocha's CLI exits from this callback, so the footer and the generated
      // coordinates must be written before it is called.
      await first.finish()
      stopReads?.()
      return callback?.(failures)
    })
  }
}
