/**
 * `CBD_SELECTION` — the file `cbd collect` writes and an adapter reads.
 *
 * The failure modes are the point: a missing variable is "no filter" (normal), but
 * a file that exists and cannot be understood must not quietly become one, because
 * "no filter" runs the whole suite and looks like a slow run rather than a bug.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { readSelection, SELECTION_ENV } from '../src/env.js'

function tempDir(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-selection-'))
  return {
    dir,
    path: join(dir, 'selection.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test.group('CBD_SELECTION', () => {
  test('no variable means no filter', () => {
    assert.equal(readSelection({}), undefined)
    assert.equal(readSelection({ [SELECTION_ENV]: '' }), undefined)
  })

  test('a selection file yields its bare titles', () => {
    const { path, cleanup } = tempDir()
    try {
      writeFileSync(path, JSON.stringify({ titles: ['adds', 'reads'] }))
      assert.deepEqual(readSelection({ [SELECTION_ENV]: path }), ['adds', 'reads'])
    } finally {
      cleanup()
    }
  })

  test('a file that cannot be read is an error', () => {
    const { dir, cleanup } = tempDir()
    try {
      const missing = join(dir, 'absent.json')
      assert.throws(
        () => readSelection({ [SELECTION_ENV]: missing }),
        /cannot read the selection/,
      )
      writeFileSync(missing, '{ not json')
      assert.throws(
        () => readSelection({ [SELECTION_ENV]: missing }),
        /cannot read the selection/,
      )
    } finally {
      cleanup()
    }
  })

  test('the shape is checked, and an empty list is refused', () => {
    const { path, cleanup } = tempDir()
    try {
      writeFileSync(path, JSON.stringify({ titles: [1] }))
      assert.throws(
        () => readSelection({ [SELECTION_ENV]: path }),
        /must contain \{ "titles": string\[\] \}/,
      )

      writeFileSync(path, JSON.stringify({ titles: [] }))
      assert.throws(() => readSelection({ [SELECTION_ENV]: path }), /is empty/)
    } finally {
      cleanup()
    }
  })
})
