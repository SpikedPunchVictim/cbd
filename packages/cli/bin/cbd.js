#!/usr/bin/env node
// `--version` is answered before the CLI module is imported. That module imports
// `@spikedpunch/cbd` statically, so on a broken or partial install the error
// would arrive before a version check could run — exactly when someone needs to
// ask what is installed. `version.js` depends only on Node built-ins.
const argv = process.argv.slice(2)

// `cbd explain ... | head` closes the pipe before the last line. Node turns that
// into an unhandled 'error' event on stdout and prints a stack trace, which reads
// as a crash; a CLI at the head of a pipeline should exit quietly, like any other.
// The command's own exit code is kept (`select` answers 3 for "run all"), and the
// writers below stop writing once the pipe is gone.
let broken = false
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code === 'EPIPE') {
      broken = true
      process.exitCode ??= 0
      return
    }
    throw error
  })
}

const separator = argv.indexOf('--')
const beforeExec = separator === -1 ? argv : argv.slice(0, separator)

// Help wins over version when both are present — the same precedence the argument
// parser applies, so the two entry points cannot disagree about `cbd help
// --version`.
const wantsHelp =
  beforeExec.includes('--help') || beforeExec.includes('-h') || beforeExec[0] === 'help'
if (!wantsHelp && beforeExec.includes('--version')) {
  const formatFlag = beforeExec.findIndex((arg) => arg === '--format' || arg.startsWith('--format='))
  const format =
    formatFlag === -1
      ? undefined
      : beforeExec[formatFlag] === '--format'
        ? beforeExec[formatFlag + 1]
        : beforeExec[formatFlag].slice('--format='.length)

  const { versions } = await import('../dist/src/version.js')
  const v = versions()
  process.stdout.write(
    format === 'json' ? `${JSON.stringify(v)}\n` : `cbd ${v.cli} (@spikedpunch/cbd ${v.core})\n`,
  )
  process.exit(0)
}

const { run } = await import('../dist/src/cli.js')
process.exitCode = run(argv, {
  cwd: process.cwd(),
  out: (line) => {
    if (!broken) process.stdout.write(`${line}\n`)
  },
  err: (line) => {
    if (!broken) process.stderr.write(`${line}\n`)
  },
})
