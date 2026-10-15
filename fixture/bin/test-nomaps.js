/** Same suite, but from the build with `sourceMap: false` — the VS Code shape. */
import { configure, processCLIArgs, run } from '@japa/runner'

configure({ files: ['out-nomaps/tests/**/*.spec.js'] })
processCLIArgs(process.argv.slice(2))
await run()
