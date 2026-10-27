import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from '@spikedpunch/cbd/adapter'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { MAP_VERSION, saveMap, type CoverageMap, type FunctionEntry } from '@spikedpunch/cbd'
import { main, parseSelectArgs, selectMutant } from '../src/cli.js'

const COMMIT = 'c0ffee'

function mapFor(file: string): CoverageMap {
  const alpha: FunctionEntry = { startLine: 10, endLine: 20, tests: [0, 1] }
  return {
    version: MAP_VERSION,
    commit: COMMIT,
    builtAt: '2026-10-19T00:00:00Z',
    tests: [
      { title: 'alpha one', file: '/repo/tests/a.spec.ts' },
      { title: 'alpha two', file: '/repo/tests/a.spec.ts' },
      { title: 'beta', file: null },
    ],
    files: { [file]: { alpha } },
    load: [],
    between: [],
    teardown: [],
    seen: [file],
    shards: ['run.ndjson'],
  }
}

function fixture(): { root: string; file: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'cbd-mutate-cli-'))
  mkdirSync(join(root, 'src'))
  const path = join(root, 'src', 'a.ts')
  writeFileSync(path, '\n'.repeat(30))
  const file = realpath(path)
  saveMap(root, mapFor(file))
  return { root, file, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('arguments are validated and the root is resolved', () => {
  assert.throws(() => parseSelectArgs(['select', '--line', '3']), /--file is required/)
  assert.throws(() => parseSelectArgs(['select', '--file', 'a.ts']), /--line is required/)
  assert.throws(
    () => parseSelectArgs(['select', '--file', 'a.ts', '--line', '0']),
    /1-based/,
  )
  assert.throws(
    () => parseSelectArgs(['select', '--file', 'a.ts', '--line', '3', '--format', 'yaml']),
    /text or json/,
  )
  const parsed = parseSelectArgs(['select', '--file', 'src/a.ts', '--line', '15'])
  assert.equal(parsed === 'help' ? null : parsed.file, 'src/a.ts')
})

test('a line inside a function selects its tests from a saved map', () => {
  const { root, cleanup } = fixture()
  try {
    const selection = selectMutant({
      file: 'src/a.ts',
      line: 15,
      root,
      stateDir: '.cbd',
      commit: COMMIT,
      format: 'json',
      policy: { root, betweenPolicy: 'all', unknownPolicy: 'all' },
    })
    assert.equal(selection.mode, 'subset')
    assert.equal(selection.why, 'function')
    assert.deepEqual(selection.tests.map((entry) => entry.title), ['alpha one', 'alpha two'])
  } finally {
    cleanup()
  }
})

test('the CLI prints JSON that a driver can consume', () => {
  const { root, cleanup } = fixture()
  const lines: string[] = []
  try {
    const code = main(
      [
        'select',
        '--root',
        root,
        '--commit',
        COMMIT,
        '--file',
        'src/a.ts',
        '--line',
        '15',
        '--format',
        'json',
      ],
      { out: (line) => lines.push(line), err: () => {} },
    )
    assert.equal(code, 0)
    const output = JSON.parse(lines.join('\n')) as {
      mode: string
      why: string
      titles: string[]
    }
    assert.equal(output.mode, 'subset')
    assert.equal(output.why, 'function')
    assert.deepEqual(output.titles, ['alpha one', 'alpha two'])
  } finally {
    cleanup()
  }
})

test('a missing map is an error, not an empty selection', () => {
  const root = mkdtempSync(join(tmpdir(), 'cbd-mutate-nomap-'))
  const errors: string[] = []
  try {
    const code = main(
      ['select', '--root', root, '--commit', COMMIT, '--file', 'src/a.ts', '--line', '1'],
      { out: () => {}, err: (line) => errors.push(line) },
    )
    assert.equal(code, 1)
    assert.match(errors.join('\n'), /ENOENT|no such file/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
