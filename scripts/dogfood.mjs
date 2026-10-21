/**
 * Dogfooding: CBD records this repository's own suites and answers selection
 * for it with the same commands a consumer runs.
 *
 * **One shard per package, not one `cbd collect -- pnpm -r test`.** A shard is a
 * single header and footer, and its script ids are shard-local. Every package's
 * japa run is a separate process, so several appending to one file would leave
 * several headers and colliding script ids — a file the reader accepts and turns
 * into a wrong map. Each suite therefore gets its own file, and `cbd build`
 * merges them by commit.
 *
 * **Build once, then record without rebuilding.** A shard records the size and
 * mtime of every script it ran, and the build refuses a script whose bytes changed.
 * Each package's `test` script begins by running `tsc`, which rewrites `dist` even
 * when nothing changed; running those scripts in sequence makes the first suite's
 * shard stale before the last one is written. `pnpm -r build` therefore happens
 * first, and the suites are invoked at the step after their build.
 *
 * Usage:
 *   node scripts/dogfood.mjs record
 *   node scripts/dogfood.mjs select [cbd select flags]
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'packages/cli/bin/cbd.js')
const shards = join(root, '.cbd', 'shards')

/**
 * Suites wired to the japa adapter, in build order. `commands` is each package's
 * `test` script minus its build step. `@spikedpunch/cbd-probe` is a research
 * harness with its own plugin, not a consumer suite, so it is recorded nowhere.
 *
 * The fixture is a consumer example: it records its own `src`, so it stays a clean
 * demo of a consumer map and does not opt into the tool's self-inclusive scan.
 */
const SUITES = [
  { name: '@spikedpunch/cbd', dir: 'packages/core', commands: [['bin/test.js']] },
  { name: '@spikedpunch/cbd-cli', dir: 'packages/cli', commands: [['bin/test.js']] },
  { name: '@spikedpunch/cbd-japa', dir: 'packages/japa', commands: [['bin/test.js']] },
  { name: '@spikedpunch/cbd-mocha', dir: 'packages/mocha', commands: [['bin/test.js']] },
  { name: '@spikedpunch/cbd-vitest', dir: 'packages/vitest', commands: [['bin/test.js']] },
  { name: '@spikedpunch/cbd-jest', dir: 'packages/jest', commands: [['bin/test.js']] },
  { name: '@spikedpunch/cbd-node-test', dir: 'packages/node-test', commands: [['bin/test.js']] },
  { name: '@spikedpunch/cbd-mutate', dir: 'packages/mutate', commands: [['bin/test.js']] },
  {
    name: '@spikedpunch/cbd-fixture',
    dir: 'fixture',
    commands: [['scripts/check-builds.mjs'], ['bin/test-maps.js']],
  },
]

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    env: options.env ?? process.env,
  })
  if (result.error !== undefined) {
    console.error(`dogfood: could not run ${command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function headCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined || result.status !== 0) {
    console.error(`dogfood: git rev-parse HEAD failed: ${result.stderr ?? result.error?.message}`)
    process.exit(1)
  }
  return result.stdout.trim()
}

function record() {
  const commit = headCommit()
  console.log(`dogfood: recording every suite at ${commit}`)

  run('pnpm', ['-r', 'build'])
  mkdirSync(shards, { recursive: true })

  for (const suite of SUITES) {
    const shard = join(shards, `dogfood-${suite.name.replace('@spikedpunch/', '')}.ndjson`)
    // A shard is append-only, so recording the same package twice into one file
    // would leave two headers. Start each recording from an empty file.
    rmSync(shard, { force: true })
    console.log(`dogfood: ${suite.name}`)
    const env = {
      ...process.env,
      CBD_SHARD: shard,
      CBD_COMMIT: commit,
      // The suite is the tool's own code. Without this the self-root floor drops
      // core's `packages/core/src` scripts, and a change there answers `mode: all`.
      ...(suite.name === '@spikedpunch/cbd-fixture' ? {} : { CBD_INCLUDE_SELF: '1' }),
    }
    for (const command of suite.commands) {
      run(process.execPath, command, { cwd: join(root, suite.dir), env })
    }
  }

  run(process.execPath, [cli, 'build', '--commit', commit])
}

const command = process.argv[2] ?? 'record'

if (command === 'record') {
  record()
} else if (command === 'select') {
  run(process.execPath, [cli, 'select', ...process.argv.slice(3)])
} else {
  console.error(`dogfood: unknown command ${command} (expected record or select)`)
  process.exit(2)
}
