export function add(a: number, b: number): number {
  return a + b
}

export function subtract(a: number, b: number): number {
  return a - b
}

export function multiply(a: number, b: number): number {
  return a * b
}

export function absolute(n: number): number {
  return n < 0 ? -n : n
}

export function sign(n: number): number {
  if (n > 0) return 1
  if (n < 0) return -1
  return 0
}

export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min
  if (n > max) return max
  return n
}

export function isEven(n: number): boolean {
  return n % 2 === 0
}
