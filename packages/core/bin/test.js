import { configure, processCLIArgs, run } from '@japa/runner'

// processCLIArgs MUST precede configure. `configure` hydrates with a snapshot of
// the parsed args taken at call time, so the reverse order silently discards
// every CLI filter — `--tests <anything>` would run the whole suite and report a
// clean pass. See A0 F11.
processCLIArgs(process.argv.slice(2))
configure({ files: ['dist/tests/**/*.spec.js'] })
await run()
