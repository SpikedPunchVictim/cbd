/**
 * A minimal golden-file helper, mimicking the `__snapshots__/<testfile>.snap`
 * convention so amendment 4's path-convention-owner rule has a real subject:
 * the snapshot has no code relationship to the test, only a naming one.
 *
 * Read-only on purpose — the fixture must be deterministic, so a mismatch fails
 * rather than rewriting the file.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findPackageRoot } from '../../src/paths.js'

const SNAPSHOT_FILE = 'golden.spec.ts.snap'

function parse(raw: string): Map<string, string> {
  const entries = new Map<string, string>()
  let key: string | null = null
  let body: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('[/')) {
      if (key !== null) entries.set(key, body.join('\n'))
      key = null
    } else if (line.startsWith('[')) {
      key = line.slice(1, -1)
      body = []
    } else if (key !== null) {
      body.push(line)
    }
  }
  return entries
}

export function snapshotPath(): string {
  return join(findPackageRoot(), 'tests', '__snapshots__', SNAPSHOT_FILE)
}

export function expectGolden(key: string, actual: string): void {
  const entries = parse(readFileSync(snapshotPath(), 'utf8'))
  const expected = entries.get(key)
  assert.ok(
    expected !== undefined,
    `no golden entry "${key}" in tests/__snapshots__/${SNAPSHOT_FILE}`,
  )
  assert.equal(actual, expected, `golden mismatch for "${key}"`)
}
