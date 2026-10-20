import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { absolute, add, clamp, isEven, multiply, sign, subtract } from '../src/math.mjs'

describe('math', () => {
  test('adds positive numbers', () => {
    assert.equal(add(2, 3), 5)
  })

  test('adds negative numbers', () => {
    assert.equal(add(-2, -3), -5)
  })

  test('subtracts', () => {
    assert.equal(subtract(5, 2), 3)
  })

  test('subtracts into negative', () => {
    assert.equal(subtract(2, 5), -3)
  })

  test('multiplies', () => {
    assert.equal(multiply(3, 4), 12)
  })

  test('multiplies by zero', () => {
    assert.equal(multiply(7, 0), 0)
  })

  test('absolute of negative', () => {
    assert.equal(absolute(-4), 4)
  })

  test('absolute of positive', () => {
    assert.equal(absolute(4), 4)
  })

  test('sign positive', () => {
    assert.equal(sign(9), 1)
  })

  test('sign negative', () => {
    assert.equal(sign(-9), -1)
  })

  test('sign zero', () => {
    assert.equal(sign(0), 0)
  })

  test('clamp below', () => {
    assert.equal(clamp(-1, 0, 10), 0)
  })

  test('clamp above', () => {
    assert.equal(clamp(11, 0, 10), 10)
  })

  test('clamp inside', () => {
    assert.equal(clamp(5, 0, 10), 5)
  })

  test('is even', () => {
    assert.equal(isEven(4), true)
  })

  test('is odd', () => {
    assert.equal(isEven(5), false)
  })
})
