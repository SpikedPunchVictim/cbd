import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { buildLineIndex, columnAt, lineAt } from '../src/line-index.js'

const index = buildLineIndex('abc\ndef\nghi')

test('lineAt maps an offset to its 1-based line', () => {
  assert.equal(lineAt(index, 0), 1)
  assert.equal(lineAt(index, 2), 1)
  assert.equal(lineAt(index, 4), 2)
  assert.equal(lineAt(index, 8), 3)
})

test('lineAt treats the newline itself as belonging to the line it ends', () => {
  assert.equal(lineAt(index, 3), 1)
})

test('columnAt is the offset within its line', () => {
  assert.equal(columnAt(index, 4), 0)
  assert.equal(columnAt(index, 6), 2)
})

test('an empty file still has one line starting at zero', () => {
  const empty = buildLineIndex('')
  assert.equal(lineAt(empty, 0), 1)
  assert.equal(columnAt(empty, 0), 0)
})
