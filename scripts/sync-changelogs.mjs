/**
 * Writes the shared changelog into the package being packed.
 *
 * Every published package carries the same version and the same history, so each
 * tarball carries the same CHANGELOG.md. Generating it at pack time keeps one
 * source of truth at the repository root: the copies are gitignored and cannot
 * drift from the log they are made from.
 *
 * Run by each package's `prepack`, from the package directory, so `npm pack` and
 * `pnpm publish` both see the file before they collect the tarball.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'CHANGELOG.md')
const destination = join(process.cwd(), 'CHANGELOG.md')

// Run from the repository root (by hand, rather than from a package directory by
// `prepack`), the destination is the source: writing would prepend a generated
// header to the file this script reads.
if (resolve(destination) === resolve(source)) process.exit(0)

const log = readFileSync(source, 'utf8')
writeFileSync(
  destination,
  '<!-- generated from the repository CHANGELOG.md by scripts/sync-changelogs.mjs -->\n\n' + log,
)
