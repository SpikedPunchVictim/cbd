#!/usr/bin/env node
// `--version` is answered before the CLI module is imported. That module imports
// `@spikedpunch/cbd` statically, so on a broken or partial install the error
// would arrive before a version check could run — exactly when someone needs to
// ask what is installed. `version.js` depends only on Node built-ins.
const argv = process.argv.slice(2)
const separator = argv.indexOf('--')
const beforeExec = separator === -1 ? argv : argv.slice(0, separator)

if (beforeExec.includes('--version')) {
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
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
})
