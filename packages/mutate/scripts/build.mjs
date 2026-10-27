import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// tsc's bin is a node script; running it with node needs no `.bin` shim, which on
// Windows is a `.cmd` that execFile cannot start.
const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')
// A removed source must not survive as a stale emit; japa would import it.
rmSync(join(root, 'dist'), { recursive: true, force: true })
execFileSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
  cwd: root,
  stdio: 'inherit',
})
