/**
 * The package, and the deployed-lane fixture, built in one step.
 *
 * Two projects rather than one, because the fixture is not part of the package: it
 * compiles the way a deployed lane is compiled — `tsc`, inline source maps, `dist/` beside
 * `src/` — and it has to, because the behaviour under test is what becomes of *those*
 * maps when a build is copied and run from the copy. A fixture built any other way
 * would not have the shape the bug needs.
 *
 * It lives here rather than in a script a reader has to know about, so that the
 * end-to-end suite cannot run against a fixture that was never built.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// tsc's bin is a node script; running it with node needs no `.bin` shim, which on
// Windows is a `.cmd` that execFile cannot start.
const tsc = join(dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')

for (const project of ['tsconfig.json', 'fixture/deployed/tsconfig.json']) {
  execFileSync(process.execPath, [tsc, '-p', project], { cwd: root, stdio: 'inherit' })
}
