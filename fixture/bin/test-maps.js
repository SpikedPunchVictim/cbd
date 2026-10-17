/**
 * Runs the fixture's suite from the SOURCE-MAPPED build.
 *
 * Note the file glob: tests are discovered in `out-maps/`, not in `tests/`.
 * That is deliberate — it reproduces the real shape where the test runner
 * executes compiled output while the repository tracks TypeScript.
 */
import { configure, processCLIArgs, run } from '@japa/runner'

// processCLIArgs MUST precede configure — see A0 F11. The reverse order makes
// japa discard CLI filters silently.
processCLIArgs(process.argv.slice(2))
configure({ files: ['out-maps/tests/**/*.spec.js'] })
await run()
