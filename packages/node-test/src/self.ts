/**
 * This package's implementation roots, added to the scan so the adapter never
 * enters the map.
 *
 * Core excludes its own package (`cbd-qly`); it cannot know where this adapter is
 * installed. The register module is the one thing that knows, so it merges these
 * roots into every recorder it opens.
 */
import { packageCodeRoots, type ScanOptions } from '@spikedpunch/cbd/adapter'

export const NODE_TEST_SELF_ROOTS = packageCodeRoots(import.meta.url, '@spikedpunch/cbd-node-test')

/** The scan with this package's implementation excluded, keeping any roots the caller named. */
export function withSelfRoot(scan: ScanOptions | undefined): ScanOptions {
  return { ...(scan ?? {}), selfRoots: [...(scan?.selfRoots ?? []), ...NODE_TEST_SELF_ROOTS] }
}
