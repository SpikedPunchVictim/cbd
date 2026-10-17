import { configure, processCLIArgs, run } from '@japa/runner'

// processCLIArgs MUST precede configure — see A0 F11.
processCLIArgs(process.argv.slice(2))
configure({ files: ['dist/tests/**/*.spec.js'] })
await run()
