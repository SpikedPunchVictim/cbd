export function capitalize(value) {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1)
}

export function reverse(value) {
  return [...value].reverse().join('')
}

export function truncate(value, length) {
  return value.length <= length ? value : value.slice(0, length) + '…'
}

export function wordCount(value) {
  return value.trim() === '' ? 0 : value.trim().split(/\s+/).length
}
