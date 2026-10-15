/** Generic functions — exercises V8's naming for arrows and default params. */

export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new RangeError('size must be positive')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

export function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const bucket = out.get(k)
    if (bucket) bucket.push(item)
    else out.set(k, [item])
  }
  return out
}

export function partition<T>(items: T[], predicate: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = []
  const no: T[] = []
  for (const item of items) (predicate(item) ? yes : no).push(item)
  return [yes, no]
}
