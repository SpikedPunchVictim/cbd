/**
 * End-to-end: a selection keeps japa from importing the spec files it does not name.
 *
 * Filtering by title (`applyTests`) happens after japa has imported every file, so
 * it saves no import time. Each fixture file logs on import, which is the one thing
 * a title filter cannot hide: if the line is in the output, the file was loaded.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { writeSelection } from '@spikedpunch/cbd'

const BIN = fileURLToPath(new URL('../../bin/e2e.js', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../fixture/narrow-tests/', import.meta.url))

function runNarrow(env: NodeJS.ProcessEnv): string {
  const out = execFileSync(process.execPath, [BIN, 'narrow'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return out.replace(/\u001b\[[0-9;]*m/g, '')
}

function withSelection<T>(
  tests: Parameters<typeof writeSelection>[1],
  body: (path: string) => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-japa-narrow-e2e-'))
  try {
    const path = join(dir, 'selection.json')
    writeSelection(path, tests)
    return body(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test.group('japa narrowing e2e', () => {
  test('an unselected run imports every spec file', () => {
    const out = runNarrow({})
    assert.match(out, /IMPORTED selected\.spec\.js/)
    assert.match(out, /IMPORTED unselected\.spec\.js/)
  })

  test('a selection never imports the files it does not name', () => {
    const out = withSelection(
      [{ file: `${FIXTURE}selected.spec.js`, title: 'narrow-selected' }],
      (path) => runNarrow({ CBD_SELECTION: path }),
    )
    assert.match(out, /IMPORTED selected\.spec\.js/)
    assert.doesNotMatch(out, /IMPORTED unselected\.spec\.js/)
    assert.match(out, /1 passed/)
  })

  test('a selection with no file for a test imports everything and still filters by title', () => {
    const out = withSelection([{ file: null, title: 'narrow-selected' }], (path) =>
      runNarrow({ CBD_SELECTION: path }),
    )
    assert.match(out, /IMPORTED selected\.spec\.js/)
    assert.match(out, /IMPORTED unselected\.spec\.js/)
    assert.match(out, /1 passed/)
  })

  // A selection whose file japa never resolves must fail loudly. Here the file is
  // real but outside the suite's `files`, so the narrowed filter matches nothing.
  test('a selection that matches no resolved file fails instead of passing green', () => {
    const elsewhere = fileURLToPath(new URL('../../fixture/tests/a.spec.js', import.meta.url))
    const result = withSelection([{ file: elsewhere, title: 'alpha-lone' }], (path) => {
      try {
        runNarrow({ CBD_SELECTION: path })
        return { status: 0, stderr: '' }
      } catch (error) {
        const failed = error as { status: number; stderr: string }
        return { status: failed.status, stderr: failed.stderr }
      }
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /fixture\/tests\/a\.spec\.js/)
  })
})
