import { describe, expect, test } from 'vitest'
import { add, sub } from '../../src/math.mjs'

describe('math', () => {
  test('adds', () => {
    expect(add(1, 2)).toBe(3)
  })

  test('subtracts', () => {
    expect(sub(5, 2)).toBe(3)
  })

  test.skip('is skipped', () => {
    // Statically skipped: the adapter must open no window for it.
  })
})
