/** Same suite, but from the build with `sourceMap: false` — the VS Code shape. */
import { configure, processCLIArgs, run } from '@japa/runner'

// processCLIArgs MUST precede configure — see A0 F11.
processCLIArgs(process.argv.slice(2))
configure({ files: ['out-nomaps/tests/**/*.spec.js'] })
await run()
