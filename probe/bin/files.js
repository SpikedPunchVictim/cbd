/**
 * Entry point for the two-file probe. Separate from bin/test.js so the hook
 * probe's glob (`tests/**​/*.spec.js`) does not also pick up the fixtures, and
 * vice versa.
 */
import { configure, processCLIArgs, run } from '@japa/runner'
import { cbdFileProbe, fileProbeReport } from '../lib/file-probe-plugin.js'

configure({
  files: ['tests/files/*.js'],
  plugins: [cbdFileProbe()],
})

processCLIArgs(process.argv.slice(2))
await run()

await fileProbeReport()
