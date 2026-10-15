/**
 * Locating the package root from a compiled module.
 *
 * Tests execute from `out-maps/` or `out-nomaps/`, so `import.meta.url` points
 * into a build directory rather than at the source tree. Walking up to
 * `package.json` gives one answer that is correct from either build.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function findPackageRoot(from: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(from))
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`findPackageRoot: no package.json above ${from}`)
}
