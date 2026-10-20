#!/usr/bin/env node
import { main } from '../dist/src/cli.js'

process.exitCode = main(process.argv.slice(2))
