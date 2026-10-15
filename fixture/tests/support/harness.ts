/**
 * Test-side cross-cutting helper. Imported by most spec files, so a change here
 * must select most of the suite — the mirror of `src/helpers.ts` on the source
 * side, and the reason selection cannot work from filenames alone.
 */
import assert from 'node:assert/strict'

export function expectEqual<T>(actual: T, expected: T, label = 'value'): void {
  assert.equal(actual, expected, `${label}: expected ${String(expected)}, got ${String(actual)}`)
}

export function expectDeepEqual<T>(actual: T, expected: T, label = 'value'): void {
  assert.deepEqual(actual, expected, `${label} did not deep-equal`)
}

export function expectThrows(fn: () => unknown, match?: RegExp): void {
  // assert.throws has no overload taking `undefined` as its second argument,
  // so the matcher has to be passed only when there is one.
  if (match) assert.throws(fn, match)
  else assert.throws(fn)
}
