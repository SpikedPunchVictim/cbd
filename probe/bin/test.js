import { configure, processCLIArgs, run } from '@japa/runner'
import { cbdProbe, probeReport, runnerEndSettledBeforeReport } from '../lib/probe-plugin.js'

configure({
  files: ['tests/**/*.spec.js'],
  plugins: [cbdProbe()],
})

processCLIArgs(process.argv.slice(2))
await run()

// Snapshot the runner:end experiment here, on the line after `run()` resolves.
// Any later read is worthless: the report sleeps to let detached listeners land,
// which would set this flag whether or not japa ever waited for it.
const awaitedAtRunEnd = runnerEndSettledBeforeReport()

// Reported after the runner settles, so pending async listeners have landed and
// the ordering evidence is complete. (japa does not await emit for the per-test
// events, so a listener on `runner:end` cannot be trusted to run last.)
await probeReport(awaitedAtRunEnd)
