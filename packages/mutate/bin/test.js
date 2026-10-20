import { configure, processCLIArgs, run } from '@japa/runner'

// processCLIArgs MUST precede configure — A0 F11. `configure` hydrates with a
// snapshot of the parsed args taken at call time, so the reverse order silently
// discards every CLI filter.
processCLIArgs(process.argv.slice(2))
configure({ files: ['dist/tests/**/*.spec.js'] })
await run()
