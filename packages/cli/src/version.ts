/**
 * The installed CLI and core versions, for `--version` and the select answer.
 *
 * Read from each package's `package.json` at run time rather than stamped at
 * build time: a linked workspace, a tarball and a published install all resolve
 * their own manifests, and a stale stamped constant is exactly the thing a
 * version check exists to catch. Both lookups walk upward from the resolved
 * entry point, so they work from `src` during development and `dist` when built.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Versions {
  cli: string
  core: string
}

const require = createRequire(import.meta.url)

function versionOf(entry: string, name: string): string {
  let dir = dirname(entry)
  for (;;) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: unknown
          version?: unknown
        }
        if (parsed.name === name && typeof parsed.version === 'string') return parsed.version
      } catch {
        // A malformed manifest is not a version; keep walking rather than fail.
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return 'unknown'
    dir = parent
  }
}

export function versions(): Versions {
  const cli = versionOf(fileURLToPath(import.meta.url), '@spikedpunch/cbd-cli')
  let core = 'unknown'
  try {
    core = versionOf(require.resolve('@spikedpunch/cbd'), '@spikedpunch/cbd')
  } catch {
    // A broken or partial install still has to answer `--version`; the core's
    // absence is reported rather than thrown from a diagnostic command.
  }
  return { cli, core }
}
