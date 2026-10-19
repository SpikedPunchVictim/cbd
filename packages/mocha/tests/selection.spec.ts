/**
 * The one filter mocha has, built from a list of titles.
 *
 * Hermetic on purpose: the e2e test proves the filter reaches a real run, and
 * these prove the pattern says exactly what it should, including the titles that
 * would be patterns if they were not escaped.
 */
import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { selectionPattern } from '../src/selection.js'

test.group('selectionPattern', () => {
  test('matches exactly the titles it names, not their prefixes or suffixes', () => {
    const pattern = selectionPattern(['calc adds two numbers', 'calc subtracts two numbers'])
    assert.ok(pattern.test('calc adds two numbers'))
    assert.ok(pattern.test('calc subtracts two numbers'))
    assert.ok(!pattern.test('calc adds two numbers twice'))
    assert.ok(!pattern.test('prefix calc adds two numbers'))
  })

  test('treats regexp metacharacters in a title as text', () => {
    const pattern = selectionPattern(['math adds 1 + 1 (carefully)'])
    assert.ok(pattern.test('math adds 1 + 1 (carefully)'))
    assert.ok(!pattern.test('math adds 11 carefully'), 'the + must not be a quantifier')
    assert.ok(!pattern.test('math adds 1 1 carefully'), 'the parentheses must be literal')
  })

  test('refuses an empty selection instead of matching nothing', () => {
    // Mocha reads "matches nothing" as "run no tests", which is the
    // under-selecting direction; the caller must be told, not silently obeyed.
    assert.throws(() => selectionPattern([]), /at least one test title/)
  })
})
