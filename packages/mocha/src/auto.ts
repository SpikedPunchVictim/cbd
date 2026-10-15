/**
 * `NODE_OPTIONS="--import @cbd/mocha/auto"` and mocha records itself.
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
 * Inert unless `CBD_SHARD` is set, so importing it by accident costs nothing.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileSink, inProcessSource, type ScanOptions } from '@cbd/core'
import { beginShard, installMochaAdapter, type InstalledAdapter } from './adapter.js'
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
  throw new Error(`@cbd/mocha/auto could not resolve "mocha":\n${failures.join('\n')}`)
}

/**
 * The scan options the adapter cannot guess for itself.
 *
 * `CBD_PROJECTION_FROM` / `CBD_PROJECTION_TO` describe one projection rule,
 * `<from>` → `<to>` with the default `.js` → `.ts` extension swap. For VS Code
 * that is `<root>/out` → `<root>`, turning `out/vs/platform/x.js` back into
 * `src/vs/platform/x.ts`. Projection is only needed for a build with no source
 * maps; where maps exist the resolver prefers them, and rightly so — an esbuild
 * transform is not line-preserving, so projecting its output would be a guess.
 */
function scanFromEnv(): ScanOptions | undefined {
  const from = process.env.CBD_PROJECTION_FROM
  const to = process.env.CBD_PROJECTION_TO
  const include = process.env.CBD_INCLUDE

  const scan: ScanOptions = {}
  if (from !== undefined && to !== undefined) scan.projection = [{ from, to }]
  if (include !== undefined) scan.include = (file) => file.startsWith(include)

  return Object.keys(scan).length === 0 ? undefined : scan
}

const shardPath = process.env.CBD_SHARD

if (shardPath !== undefined) {
  const source = await inProcessSource()
  const scan = scanFromEnv()
  const recorder = beginShard({
    source,
    sink: new FileSink(shardPath),
    commit: process.env.CBD_COMMIT ?? 'unknown',
    ...(scan === undefined ? {} : { scan }),
  })

  const MochaClass = resolveMocha()
  const originalRun = MochaClass.prototype.run
  let adapter: InstalledAdapter | null = null

  MochaClass.prototype.run = function (
    this: Mocha,
    callback?: (failures: number) => void,
  ): Mocha.Runner {
    if (adapter !== null) {
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

    return originalRun.call(this, (failures: number) => {
      first.finish()
      return callback?.(failures)
    })
  }
}
