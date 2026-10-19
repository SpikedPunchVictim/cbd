/**
 * Two output shapes in one step.
 *
 * The package is ESM, but Jest loads a test environment with `require`. The two
 * entries Jest names are therefore bundled to CommonJS with esbuild's API (not its
 * CLI shim), which keeps the dynamic import of the ESM-only core intact and leaves
 * `jest-environment-node` to be resolved by the worker. Everything else is ESM.
 */
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// The CJS entries are written next to nothing else; a stale emit from an older
// build must not survive into dist (the package's exports would still name them).
rmSync(join(root, 'dist', 'cjs'), { recursive: true, force: true })
execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
  cwd: root,
  stdio: 'inherit',
})

for (const entry of ['environment', 'config']) {
  await build({
    absWorkingDir: root,
    entryPoints: [`src/${entry}.ts`],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['jest-environment-node', '@spikedpunch/cbd/*'],
    outfile: `dist/cjs/${entry}.cjs`,
  })
}
