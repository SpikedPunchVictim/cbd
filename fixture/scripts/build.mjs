/**
 * Compiles the fixture twice, on purpose.
 *
 *   out-maps/    sourceMap: true   — the normal case; the Normalizer resolves
 *                                    generated JS back to src/*.ts through the map.
 *   out-nomaps/  sourceMap: false  — the VS Code shape. Tests execute out/…/*.js
 *                                    while git tracks src/…/*.ts and no map
 *                                    exists, so path projection (amendment 1) is
 *                                    the only thing that can join them.
 *
 * Both must load, or the projection work in A2 is being built against a fiction.
 */
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// tsc's bin is a node script; running it with node needs no `.bin` shim, which on
// Windows is a `.cmd` that execFile cannot start.
const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')

const TARGETS = [
  { project: 'tsconfig.maps.json', outDir: 'out-maps' },
  { project: 'tsconfig.nomaps.json', outDir: 'out-nomaps' },
]

for (const { project, outDir } of TARGETS) {
  // tsc does not clean its outDir, so turning source maps off would otherwise
  // leave the previous build's .map files behind — and the no-maps build would
  // quietly still have maps, defeating the whole point of having two builds.
  rmSync(join(root, outDir), { recursive: true, force: true })
  execFileSync(process.execPath, [tsc, '-p', project], { cwd: root, stdio: 'inherit' })
}

console.log('built: out-maps (sourceMap: true) and out-nomaps (sourceMap: false)')
