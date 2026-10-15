/** Pure functions. The easy case: no dependencies, trivially attributable. */

export function add(a: number, b: number): number {
  return a + b
}

export function multiply(a: number, b: number): number {
  return a * b
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

/** Never called by any test — the inverse map's subject at module level. */
export function factorial(n: number): number {
  return n <= 1 ? 1 : n * factorial(n - 1)
}
