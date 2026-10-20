import { describe, expect, test } from 'vitest'
import { absolute, add, clamp, isEven, multiply, sign, subtract } from '../src/math'

describe('math', () => {
  test('adds positive numbers', () => {
    expect(add(2, 3)).toBe(5)
  })

  test('adds negative numbers', () => {
    expect(add(-2, -3)).toBe(-5)
  })

  test('subtracts', () => {
    expect(subtract(5, 2)).toBe(3)
  })

  test('subtracts into negative', () => {
    expect(subtract(2, 5)).toBe(-3)
  })

  test('multiplies', () => {
    expect(multiply(3, 4)).toBe(12)
  })

  test('multiplies by zero', () => {
    expect(multiply(7, 0)).toBe(0)
  })

  test('absolute of negative', () => {
    expect(absolute(-4)).toBe(4)
  })

  test('absolute of positive', () => {
    expect(absolute(4)).toBe(4)
  })

  test('sign positive', () => {
    expect(sign(9)).toBe(1)
  })

  test('sign negative', () => {
    expect(sign(-9)).toBe(-1)
  })

  test('sign zero', () => {
    expect(sign(0)).toBe(0)
  })

  test('clamp below', () => {
    expect(clamp(-1, 0, 10)).toBe(0)
  })

  test('clamp above', () => {
    expect(clamp(11, 0, 10)).toBe(10)
  })

  test('clamp inside', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })

  test('clamp at bounds', () => {
    expect(clamp(0, 0, 10)).toBe(0)
    expect(clamp(10, 0, 10)).toBe(10)
  })

  test('is even', () => {
    expect(isEven(4)).toBe(true)
  })

  test('is odd', () => {
    expect(isEven(5)).toBe(false)
  })
})
