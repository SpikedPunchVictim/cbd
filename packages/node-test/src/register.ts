/**
 * `node --import @spikedpunch/cbd-node-test/register --test`.
 *
 * With `CBD_SHARD` unset the register module is inert for recording, so the flag
 * can live in a committed command; it still applies `CBD_SELECTION`.
 *
 * **Selection is a re-execution, not a runtime skip.** `node:test` marks a test
 * skipped only before its hooks run, and a `beforeEach` call to `t.skip()` does not
 * stop the body — so filtering from inside a hook is not available. The pattern is
 * the runner's own filter, but `--test` never loads user preloads in the *parent*
 * runner, and the child's harness reads its options before this module runs. The
 * child can, however, re-execute itself with one extra argument: the register
 * module is loaded before the test file, so the file is spawned once more with
 * `--test-name-pattern` and the inner process inherits the child's stdout, where
 * the parent runner expects TAP. That is one extra process per test file during a
 * subset run.
 *
 * A pattern the caller already set is left alone: CBD cannot compose it safely
 * with its own, and running more tests than selected is the safe direction.
 */
import { spawnSync } from 'node:child_process'
import { after, afterEach, beforeEach } from 'node:test'
import { readSelection } from '@spikedpunch/cbd/adapter'
import { existingPattern, selectionPattern } from './identity.js'
import { installNodeTest, type NodeTestHooks } from './install.js'

const titles = readSelection(process.env)
if (titles !== undefined) {
  const pattern = selectionPattern(titles)
  const flag = `--test-name-pattern=${pattern}`
  const existing = existingPattern(process.execArgv)

  if (process.env.NODE_TEST_CONTEXT === undefined) {
    // In process isolation the parent runner never loads this module, so an
    // undefined context here means `--test-isolation=none`: there is no child to
    // re-execute, and the runner reads its pattern before this module runs.
    if (isolationNone([...process.execArgv, ...process.argv])) {
      process.stderr.write(
        'cbd: node:test is running without process isolation (--test-isolation=none), so ' +
          'CBD_SELECTION cannot be applied; the whole suite runs.\n',
      )
    }
  } else if (existing === undefined) {
    const result = spawnSync(
      process.execPath,
      [...process.execArgv, flag, ...process.argv.slice(1)],
      { stdio: 'inherit', env: process.env },
    )
    if (result.error !== undefined) {
      process.stderr.write(`cbd: cannot re-execute node:test with the selection: ${String(result.error)}\n`)
      process.exit(1)
    }
    process.exit(result.status ?? 1)
  } else if (existing !== pattern) {
    process.stderr.write(
      `cbd: the run already sets --test-name-pattern (${existing}); CBD_SELECTION was not ` +
        'applied, so more tests may run than selected.\n',
    )
  }
}

await installNodeTest({ beforeEach, afterEach, after } as unknown as NodeTestHooks)

/** `--test-isolation=none` is the one mode that runs test files in this process. */
function isolationNone(argv: string[]): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--test-isolation=none' || arg === '--experimental-test-isolation=none') return true
    if (arg === '--test-isolation' || arg === '--experimental-test-isolation') {
      return argv[index + 1] === 'none'
    }
  }
  return false
}
