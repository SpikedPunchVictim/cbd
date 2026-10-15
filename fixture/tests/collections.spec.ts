import { test } from '@japa/runner'
import { chunk, groupBy, partition, unique } from '../src/collections.js'
import { expectDeepEqual, expectThrows } from './support/harness.js'

test('chunk splits a list into fixed-size groups', () => {
  expectDeepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]], 'chunk')
})

test('chunk rejects a non-positive size', () => {
  expectThrows(() => chunk([1], 0), /size must be positive/)
})

test('unique removes duplicates', () => {
  expectDeepEqual(unique([1, 1, 2, 3, 3]), [1, 2, 3], 'unique')
})

// groupBy takes a callback — V8 reports it as an anonymous arrow in the map.
test('groupBy buckets by a key function', () => {
  const grouped = groupBy(['ant', 'bee', 'ape'], (word) => word[0])
  expectDeepEqual([...grouped.keys()], ['a', 'b'], 'groupBy keys')
})

test('partition splits by predicate', () => {
  const [even, odd] = partition([1, 2, 3, 4], (n) => n % 2 === 0)
  expectDeepEqual(even, [2, 4], 'even')
  expectDeepEqual(odd, [1, 3], 'odd')
})
