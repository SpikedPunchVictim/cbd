/**
 * End-to-end proof that the built plugin narrows a real japa run.
 *
 * The unit tests pin the wiring; this pins the thing the product is actually sold
 * on — that a selection takes effect — against real japa, a real config and real
 * test files. It is run by `bin/e2e.js`, not by the unit suite, because japa's
 * `configure`/`run` are module globals and there is one run per process.
 *
 * Usage: node bin/e2e.js <mode>
 *   full    — no plugin            → 4 tests
 *   only    — plugin with a filter → 1 test
 *   narrow  — plugin with no options; CBD_SELECTION (if set) decides which of two spec
 *             files japa imports. Each file logs on import.
 *   record  — plugin with a shard  → a shard naming both files
 *   service — a suite that drives a separately started service, recorded from two
 *             processes. Needs `CBD_SOCKET_DIR` (the variable the service itself was
 *             started with) and `CBD_FIXTURE_URL` (where it is listening); both are
 *             the caller's to set, because both describe a service this process did
 *             not start and must not start — `cbd-a3v.3.4`.
 *   early   — the `record` wiring, but the entry imports a helper before the plugin is
 *             installed, as a consumer's shared test-kit would be. Whether the helper is
 *             recorded depends on whether the run carries the `register` preload.
 *   straddle — the same wiring over a service that keeps working after it answers, so
 *             that a test can leave server execution running past its own window —
 *             `cbd-a3v.3.5`.
 *   deployed — the same wiring over a service started from a COPY of its build, so the
 *             paths its maps resolve and the paths a repository diff names are two
 *             different trees. `CBD_RELOCATE_FROM` / `CBD_RELOCATE_TO` are the caller's
 *             to set: absent is the defect, naming the copy is the fix — `cbd-jmn`.
 *   own-service — a suite that starts a service of its own part-way through the run and
 *             drives it from the tests after that. Needs `CBD_SOCKET_DIR` and
 *             `CBD_FIXTURE_URL` for the service the run WAS pointed at, and expects this
 *             process to be carrying `NODE_OPTIONS`, because the whole claim is that what
 *             the suite spawns inherits the instrument module rather than being told about
 *             it — `cbd-0gw`.
 */
import { fileURLToPath } from 'node:url'
import { configure, processCLIArgs, run } from '@japa/runner'
import { cbd } from '../dist/src/index.js'

const mode = process.argv[2] ?? 'full'
// `files` is a glob *string*, and japa resolves those against its cwd — an
// absolute pattern becomes cwd + absolute path and fails to resolve. So the cwd
// is given explicitly and the glob stays relative.
const cwd = fileURLToPath(new URL('..', import.meta.url))

const files =
  mode === 'narrow'
    ? ['fixture/narrow-tests/*.spec.js']
    : mode === 'service'
    ? ['fixture/service-tests/*.spec.js']
    : mode === 'straddle'
      ? ['fixture/straddle-tests/*.spec.js']
      : mode === 'deployed'
        ? ['fixture/deployed-tests/*.spec.js']
        : mode === 'own-service'
          ? ['fixture/own-service-tests/*.spec.js']
          : ['fixture/tests/*.spec.js']

// A module the entry itself imports ahead of `configure`: with only the plugin, coverage
// has not started by now; with the preload it has.
if (mode === 'early') await import('../fixture/early/helper.js')

const plugins = []
if (mode === 'only') plugins.push(cbd({ only: ['alpha-grouped'] }))
// No options: the selection comes from CBD_SELECTION, which is the path `cbd select
// --emit-selection` and `cbd collect` use.
if (mode === 'narrow') plugins.push(cbd())
// The service mode is the `record` mode plus a `CBD_SOCKET_DIR` in the environment:
// the plugin needs no second switch to know a service is out there, because the
// service's own start-up already had to set that variable (ADR-0005).
if (
  mode === 'record' ||
  mode === 'early' ||
  mode === 'service' ||
  mode === 'straddle' ||
  mode === 'deployed' ||
  mode === 'own-service'
) {
  plugins.push(cbd({ shard: process.env.CBD_SHARD, commit: 'e2e' }))
}

// processCLIArgs first — A0 F11.
processCLIArgs([])
configure({ cwd, files, plugins })
await run()
