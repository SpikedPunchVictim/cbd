import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { capitalize, reverse, truncate, wordCount } from '../src/text.mjs'

describe('text', () => {
  test('capitalizes', () => {
    assert.equal(capitalize('hello'), 'Hello')
  })

  test('capitalizes an empty string', () => {
    assert.equal(capitalize(''), '')
  })

  test('reverses', () => {
    assert.equal(reverse('abc'), 'cba')
  })

  test('reverses an empty string', () => {
    assert.equal(reverse(''), '')
  })

  test('truncates a long string', () => {
    assert.equal(truncate('abcdef', 3), 'abc…')
  })

  test('keeps a short string', () => {
    assert.equal(truncate('abc', 3), 'abc')
  })

  test('counts words', () => {
    assert.equal(wordCount('one two three'), 3)
  })

  test('counts an empty string', () => {
    assert.equal(wordCount(''), 0)
  })

  test('counts whitespace as no words', () => {
    assert.equal(wordCount('   '), 0)
  })
})
