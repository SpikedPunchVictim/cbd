export function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

export function max(values: number[]): number | undefined {
  return values.length === 0 ? undefined : Math.max(...values)
}
