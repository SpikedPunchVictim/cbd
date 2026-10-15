/**
 * The cross-cutting module. Imported by most test files on purpose: a change
 * here must select a large slice of the suite, which is the case a
 * coverage-based selector has to get right and a filename-based one cannot.
 */

export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i)
}

export function repeat<T>(value: T, times: number): T[] {
  return Array.from({ length: times }, () => value)
}

export function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function sum(numbers: number[]): number {
  return numbers.reduce((total, n) => total + n, 0)
}
