import { configure, processCLIArgs, run } from '@japa/runner'
import { cbdProbe, probeReport } from '../lib/probe-plugin.js'

configure({
  files: ['tests/**/*.spec.js'],
  plugins: [cbdProbe()],
})

processCLIArgs(process.argv.slice(2))
await run()

// Reported after the runner settles, so pending async listeners have landed and
// the ordering evidence is complete. (japa does not await emit, so a listener on
// `runner:end` cannot be trusted to run last.)
await probeReport()
