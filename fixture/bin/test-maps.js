/**
 * Runs the fixture's suite from the SOURCE-MAPPED build.
 *
 * Note the file glob: tests are discovered in `out-maps/`, not in `tests/`.
 * That is deliberate — it reproduces the real shape where the test runner
 * executes compiled output while the repository tracks TypeScript.
 */
import { configure, processCLIArgs, run } from '@japa/runner'
import { cbd } from '@spikedpunch/cbd-japa'

// processCLIArgs MUST precede configure — see A0 F11. The reverse order makes
// japa discard CLI filters silently.
processCLIArgs(process.argv.slice(2))
configure({
  files: ['out-maps/tests/**/*.spec.js'],
  // The fixture is a stand-in for a real consumer, so it installs CBD the way a
  // consumer does: one plugin. It is inert unless CBD_SHARD (record) or
  // CBD_SELECTION (narrow) is set, so a plain `node bin/test-maps.js` is unchanged.
  plugins: [cbd({ commit: process.env.CBD_COMMIT })],
})
await run()
