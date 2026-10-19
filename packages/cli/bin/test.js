import { configure, processCLIArgs, run } from '@japa/runner'

// processCLIArgs MUST precede configure — A0 F11. The reverse order drops every
// CLI filter silently, and the run looks green while running everything.
processCLIArgs(process.argv.slice(2))
configure({ files: ['dist/tests/**/*.spec.js'] })
await run()
