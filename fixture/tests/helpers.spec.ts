import { test } from '@japa/runner'
import { range, repeat, slug, sum } from '../src/helpers.js'
import { expectDeepEqual, expectEqual } from './support/harness.js'

test('range produces a sequence from zero', () => {
  expectDeepEqual(range(4), [0, 1, 2, 3], 'range(4)')
})

test('repeat duplicates a value', () => {
  expectDeepEqual(repeat('x', 3), ['x', 'x', 'x'], 'repeat')
})

test('slug normalises whitespace and punctuation', () => {
  expectEqual(slug('  Hello, World!  '), 'hello-world', 'slug')
})

test('sum adds every element', () => {
  expectEqual(sum([1, 2, 3, 4]), 10, 'sum')
})
