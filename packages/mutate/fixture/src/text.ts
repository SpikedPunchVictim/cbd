export function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

export function reverse(value: string): string {
  return [...value].reverse().join('')
}

export function truncate(value: string, length: number): string {
  return value.length <= length ? value : value.slice(0, length) + '…'
}

export function wordCount(value: string): number {
  return value.trim() === '' ? 0 : value.trim().split(/\s+/).length
}
