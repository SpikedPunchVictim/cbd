import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// A removed source must not survive as a stale emit; japa would import it.
rmSync(join(root, 'dist'), { recursive: true, force: true })
execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
  cwd: root,
  stdio: 'inherit',
})
