#!/usr/bin/env node
import { run } from '../dist/src/cli.js'

process.exitCode = run(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
})
