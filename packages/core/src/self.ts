/**
 * Where the tool itself lives, so its own execution never enters a map (`cbd-qly`).
 *
 * **The instrument is inside every window it closes.** A take resets the counters
 * and then this package serializes the reply and writes it; the recorder's take
 * path runs `normalize`, `source-maps` and `line-index` after the reset too. None
 * of that is a mistake in a module — it is what serving coverage costs — but those
 * files then have a row in every window, are attributed to every test, and make an
 * empty window indistinguishable from one that only drove the tool.
 *
 * **The default prefilter hides it only when CBD is installed normally.** Scripts
 * under `node_modules` are dropped, and a published package is always there. A
 * pnpm workspace link is resolved by Node to a realpath outside `node_modules`, so
 * developing or dogfooding CBD (`cbd-0lu`) is exactly the case the prefilter does
 * not cover.
 *
 * **One root per package, not one for the repository.** Core cannot know where
 * `@spikedpunch/cbd-japa` was installed, so each package names its own root and the
 * adapter that imported it adds it to the scan. Core's own root is always
 * excluded; see the floor in `normalize.ts`.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The directory holding `packageName`'s `package.json`, found by walking up from
 * a module in that package.
 *
 * Walking rather than counting `../` hops is what makes this work in both places
 * the module runs from: `src/self.ts` and the built `dist/src/self.js` are at
 * different depths, and a third layout (a bundler's flat output) would be a third.
 */
export function packageRoot(moduleUrl: string, packageName: string): string {
  let dir = dirname(fileURLToPath(moduleUrl))
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown
      }
      if (manifest.name === packageName) return realpathSync(dir)
    } catch {
      // No manifest here, or an unreadable one: keep walking.
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`packageRoot: no package named "${packageName}" above ${moduleUrl}`)
    }
    dir = parent
  }
}

/**
 * The directories a package's *implementation* runs from: its source and its built
 * output.
 *
 * Deliberately not the package root. A package's own tests and fixtures live in it
 * too, and CBD's hermetic tests use in-package fixtures as the code under test; a
 * floor over the whole package would drop the very code a test is asserting on.
 * Consumers never have CBD's `tests/` directory at all, so the narrower roots cost
 * nothing there and keep this repository testable.
 */
export function packageCodeRoots(moduleUrl: string, packageName: string): string[] {
  const root = packageRoot(moduleUrl, packageName)
  return [join(root, 'src'), join(root, 'dist/src')]
}

/** This package's implementation roots. Always excluded from a scan, whatever the prefilter says. */
export const CBD_SELF_ROOTS = packageCodeRoots(import.meta.url, '@spikedpunch/cbd')
