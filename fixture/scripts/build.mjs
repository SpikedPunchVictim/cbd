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
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsc = join(root, 'node_modules', '.bin', 'tsc')

for (const project of ['tsconfig.maps.json', 'tsconfig.nomaps.json']) {
  execFileSync(tsc, ['-p', project], { cwd: root, stdio: 'inherit' })
}

console.log('built: out-maps (sourceMap: true) and out-nomaps (sourceMap: false)')
