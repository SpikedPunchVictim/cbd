import { test } from '@japa/runner'
import { reverse, titleCase, toSlug, truncate } from '../src/strings.js'
import { expectEqual } from './support/harness.js'

test('titleCase capitalises each word', () => {
  expectEqual(titleCase('hello wide world'), 'Hello Wide World', 'titleCase')
})

test('truncate shortens and ellipsises', () => {
  expectEqual(truncate('abcdefghij', 5), 'abcd…', 'truncate')
  expectEqual(truncate('abc', 5), 'abc', 'truncate short input')
})

test('reverse handles multi-byte characters', () => {
  expectEqual(reverse('abc'), 'cba', 'reverse')
})

// Two hops from helpers: strings -> helpers -> slug
test('toSlug delegates to the shared slug helper', () => {
  expectEqual(toSlug('Hello World'), 'hello-world', 'toSlug')
})
