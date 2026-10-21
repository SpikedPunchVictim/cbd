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
import {
  readSelection,
  readSelectionTests,
  scanFromEnv,
  INCLUDE_SELF_ENV,
  SELECTION_ENV,
} from '../src/env.js'

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

// A v2 file names tests the way the map does. The titles stay derivable, so an
// adapter that can only filter by title keeps working.
test.group('selection v2', () => {
  test('the tests are exposed both structurally and as titles', () => {
    const { path, cleanup } = tempDir()
    try {
      writeFileSync(
        path,
        JSON.stringify({
          version: 2,
          tests: [
            { id: 'tests/a.spec.ts::adds', file: 'tests/a.spec.ts', title: 'adds' },
            {
              id: 'tests/a.spec.ts::divides',
              file: 'tests/a.spec.ts',
              title: 'divides',
              titlePath: ['math', 'divides'],
              line: 12,
            },
          ],
        }),
      )
      const env = { [SELECTION_ENV]: path }
      assert.deepEqual(readSelectionTests(env), [
        { id: 'tests/a.spec.ts::adds', file: 'tests/a.spec.ts', title: 'adds' },
        {
          id: 'tests/a.spec.ts::divides',
          file: 'tests/a.spec.ts',
          title: 'divides',
          titlePath: ['math', 'divides'],
          line: 12,
        },
      ])
      assert.deepEqual(readSelection(env), ['adds', 'divides'])
    } finally {
      cleanup()
    }
  })

  test('a v1 file has no structural form but still yields titles', () => {
    const { path, cleanup } = tempDir()
    try {
      writeFileSync(path, JSON.stringify({ titles: ['adds'] }))
      const env = { [SELECTION_ENV]: path }
      assert.equal(readSelectionTests(env), undefined)
      assert.deepEqual(readSelection(env), ['adds'])
    } finally {
      cleanup()
    }
  })

  test('a malformed v2 entry is an error, not a fall back to titles', () => {
    const { path, cleanup } = tempDir()
    try {
      writeFileSync(path, JSON.stringify({ version: 2, tests: [{ id: 'x', title: 1 }] }))
      assert.throws(() => readSelection({ [SELECTION_ENV]: path }), /malformed test at index 0/)
    } finally {
      cleanup()
    }
  })
})

// Recording CBD's own suites needs the self-root floor lifted. A value of `0` is
// "off", like an absent one; only the two documented spellings turn it on.
test.group(INCLUDE_SELF_ENV, () => {
  test('absent or off leaves the scan unchanged', () => {
    assert.equal(scanFromEnv({}), undefined)
    assert.equal(scanFromEnv({ [INCLUDE_SELF_ENV]: '' }), undefined)
    assert.equal(scanFromEnv({ [INCLUDE_SELF_ENV]: '0' }), undefined)
  })

  test('1 and true lift the floor', () => {
    assert.deepEqual(scanFromEnv({ [INCLUDE_SELF_ENV]: '1' }), { includeSelf: true })
    assert.deepEqual(scanFromEnv({ [INCLUDE_SELF_ENV]: 'true' }), { includeSelf: true })
  })

  test('it composes with the other scan rules', () => {
    assert.deepEqual(
      scanFromEnv({
        [INCLUDE_SELF_ENV]: '1',
        CBD_PROJECTION_FROM: '/out',
        CBD_PROJECTION_TO: '/src',
      }),
      { projection: [{ from: '/out', to: '/src' }], includeSelf: true },
    )
  })
})
