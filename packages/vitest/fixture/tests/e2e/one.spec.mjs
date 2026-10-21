import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { add, sub } from '../../src/math.mjs'

// A module-scope read: a text oracle reading source before any test window exists.
// The adapter scopes it to this spec, so both tests here depend on math.mjs.
readFileSync(new URL('../../src/math.mjs', import.meta.url))

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
