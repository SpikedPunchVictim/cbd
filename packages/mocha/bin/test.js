import { configure, processCLIArgs, run } from '@japa/runner'

configure({ files: ['dist/tests/**/*.spec.js'] })
processCLIArgs(process.argv.slice(2))
await run()
