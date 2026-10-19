import { expect, test } from 'vitest'
import { add } from '../../src/math.mjs'

test('another file also adds', () => {
  expect(add(2, 2)).toBe(4)
})
