const { add } = require('../src/math.js')
describe('outer', () => {
  test('passes', () => { expect(add(1, 2)).toBe(3) })
  test('fails', () => { expect(add(1, 1)).toBe(3) })
  test.skip('skipped', () => {})
  describe('inner', () => {
    test('nested passes', () => { expect(add(2, 2)).toBe(4) })
  })
})

describe('rows', () => {
  test.each([
    ['a', 1],
    ['b', 2],
  ])('row %s', (name, value) => {
    expect(value).toBeGreaterThan(0)
  })
})
