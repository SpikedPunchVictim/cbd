import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { selectionPattern } from '../src/config.js'

function withSelection<T>(content: string, body: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-jest-config-'))
  const path = join(dir, 'selection.json')
  writeFileSync(path, content)
  try {
    return body(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('reads the v2 selection the writers emit', () => {
  withSelection(
    JSON.stringify({ version: 2, tests: [{ id: 'a::b', file: 'a', title: 'b' }] }),
    (path) => assert.equal(selectionPattern(path), '^(?:b)$'),
  )
})

test('still reads a v1 titles file', () => {
  withSelection(JSON.stringify({ titles: ['b'] }), (path) =>
    assert.equal(selectionPattern(path), '^(?:b)$'),
  )
})

test('an empty v2 selection is refused', () => {
  withSelection(JSON.stringify({ version: 2, tests: [] }), (path) =>
    assert.throws(() => selectionPattern(path), /selection is empty/),
  )
})

test('a malformed v2 test is refused', () => {
  withSelection(JSON.stringify({ version: 2, tests: [{ file: 'a' }] }), (path) =>
    assert.throws(() => selectionPattern(path), /v2 selection needs/),
  )
})
