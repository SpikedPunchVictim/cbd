import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { add, clamp, multiply } from '../src/math.js'

test('add sums two numbers', () => {
  assert.equal(add(2, 3), 5)
})

test('multiply multiplies two numbers', () => {
  assert.equal(multiply(3, 4), 12)
})

test('clamp bounds a value from either side', () => {
  assert.equal(clamp(11, 0, 10), 10)
  assert.equal(clamp(-1, 0, 10), 0)
  assert.equal(clamp(5, 0, 10), 5)
})
