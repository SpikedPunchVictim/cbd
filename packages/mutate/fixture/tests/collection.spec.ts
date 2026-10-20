import { describe, expect, test } from 'vitest'
import { max, sum, unique } from '../src/collection'

describe('collection', () => {
  test('unique keeps the first occurrence order', () => {
    expect(unique([1, 2, 1, 3])).toEqual([1, 2, 3])
  })

  test('unique of an empty array', () => {
    expect(unique([])).toEqual([])
  })

  test('sums values', () => {
    expect(sum([1, 2, 3])).toBe(6)
  })

  test('sums an empty array', () => {
    expect(sum([])).toBe(0)
  })

  test('finds the maximum', () => {
    expect(max([1, 9, 3])).toBe(9)
  })

  test('maximum of an empty array', () => {
    expect(max([])).toBeUndefined()
  })
})
