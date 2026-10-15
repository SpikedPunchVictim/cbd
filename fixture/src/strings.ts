/** Depends on helpers — a two-hop case: test → strings → helpers. */

import { slug } from './helpers.js'

export function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

export function toSlug(value: string): string {
  return slug(value)
}

export function reverse(value: string): string {
  return [...value].reverse().join('')
}
