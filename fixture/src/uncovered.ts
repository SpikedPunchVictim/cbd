/**
 * No test imports this module. It is the inverse map's headline case at module
 * granularity: the whole file should show as unreached, not merely unreached
 * functions within a reached file.
 */

export function neverCalled(): string {
  return 'nobody calls me'
}

export function alsoNeverCalled(n: number): number {
  return n * 2
}
