import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { FixtureError, assertPositive, safeDivide } from '../src/errors.js'
import { expectEqual, expectThrows } from './support/harness.js'

test('assertPositive accepts a positive number', () => {
  assert.doesNotThrow(() => assertPositive(1))
})

test('assertPositive rejects zero and negatives', () => {
  expectThrows(() => assertPositive(0), /positive/)
  expectThrows(() => assertPositive(-5), /positive/)
})

test('safeDivide throws a FixtureError on zero', () => {
  expectThrows(() => safeDivide(1, 0), /division by zero/)
  expectEqual(safeDivide(10, 2), 5, 'safeDivide')
})

test('FixtureError carries its name', () => {
  const error = new FixtureError('boom')
  expectEqual(error.name, 'FixtureError', 'error.name')
})
