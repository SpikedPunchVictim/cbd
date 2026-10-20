export function add(a, b) {
  return a + b
}

export function subtract(a, b) {
  return a - b
}

export function multiply(a, b) {
  return a * b
}

export function absolute(n) {
  return n < 0 ? -n : n
}

export function sign(n) {
  if (n > 0) return 1
  if (n < 0) return -1
  return 0
}

export function clamp(n, min, max) {
  if (n < min) return min
  if (n > max) return max
  return n
}

export function isEven(n) {
  return n % 2 === 0
}
