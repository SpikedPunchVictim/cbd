/**
 * The package, and the deployed-lane fixture, built in one step.
 *
 * Two projects rather than one, because the fixture is not part of the package: it
 * compiles the way grizzly compiles a lane — `tsc`, inline source maps, `dist/` beside
 * `src/` — and it has to, because the behaviour under test is what becomes of *those*
 * maps when a build is copied and run from the copy. A fixture built any other way
 * would not have the shape the bug needs.
 *
 * It lives here rather than in a script a reader has to know about, so that the
 * end-to-end suite cannot run against a fixture that was never built.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tsc = join(root, 'node_modules', '.bin', 'tsc')

for (const project of ['tsconfig.json', 'fixture/deployed/tsconfig.json']) {
  execFileSync(tsc, ['-p', project], { cwd: root, stdio: 'inherit' })
}
