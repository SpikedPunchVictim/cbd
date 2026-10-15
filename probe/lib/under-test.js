/**
 * The code under test. Deliberately tiny and trivially normalizable — the point
 * is to prove per-test attribution, not to be realistic.
 *
 * `unused` is never called by any test. If the probe's per-test deltas are
 * correct, it must be absent from every one of them: that is the inverse map
 * ("what code does no test reach?") demonstrated in three functions.
 */
export function addOne(n) {
  return n + 1
}

export function double(n) {
  return n * 2
}

export function unused(n) {
  return n - 1
}
