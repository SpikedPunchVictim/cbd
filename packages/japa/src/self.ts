/**
 * This package's implementation roots, added to the scan so the adapter never
 * enters the map.
 *
 * Core excludes its own package by default (`self.ts` there, `cbd-qly`); it cannot
 * know where `@spikedpunch/cbd-japa` lives, because that is a different install
 * location under npm, a link under pnpm, and a sibling directory in this
 * repository. The adapter is the one thing that knows, so `beginShard` merges the
 * roots into every recorder it opens. A consumer's own prefilter narrows the scan
 * further; it cannot put the adapter back in.
 */
import { packageCodeRoots, type ScanOptions } from '@spikedpunch/cbd/adapter'

export const JAPA_SELF_ROOTS = packageCodeRoots(import.meta.url, '@spikedpunch/cbd-japa')

/** The scan with this package's implementation excluded, keeping any roots the caller named. */
export function withSelfRoot(scan: ScanOptions | undefined): ScanOptions {
  return { ...(scan ?? {}), selfRoots: [...(scan?.selfRoots ?? []), ...JAPA_SELF_ROOTS] }
}
