import { describe, expect, test } from 'vitest'
import { capitalize, reverse, truncate, wordCount } from '../src/text'

describe('text', () => {
  test('capitalizes', () => {
    expect(capitalize('hello')).toBe('Hello')
  })

  test('capitalizes an empty string', () => {
    expect(capitalize('')).toBe('')
  })

  test('reverses', () => {
    expect(reverse('abc')).toBe('cba')
  })

  test('reverses an empty string', () => {
    expect(reverse('')).toBe('')
  })

  test('truncates a long string', () => {
    expect(truncate('abcdef', 3)).toBe('abc…')
  })

  test('keeps a short string', () => {
    expect(truncate('abc', 3)).toBe('abc')
  })

  test('counts words', () => {
    expect(wordCount('one two three')).toBe(3)
  })

  test('counts an empty string', () => {
    expect(wordCount('')).toBe(0)
  })

  test('counts whitespace as no words', () => {
    expect(wordCount('   ')).toBe(0)
  })
})
