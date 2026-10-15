import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { projectPath } from '../src/projection.js'

const rules = [{ from: '/repo/out-nomaps', to: '/repo' }]

test('projects a nested compiled path back to its source', () => {
  assert.equal(projectPath('/repo/out-nomaps/src/math.js', rules), '/repo/src/math.ts')
})

test('projects a deeply nested path without losing depth', () => {
  assert.equal(projectPath('/repo/out-nomaps/src/a/b/c.js', rules), '/repo/src/a/b/c.ts')
})

test('returns null for a file outside the output directory', () => {
  assert.equal(projectPath('/repo/src/math.ts', rules), null)
})

// The prefix trap: a plain startsWith would rewrite this to /repo-extra/...,
// silently pointing the map at files that do not exist.
test('does not match a sibling directory sharing the prefix', () => {
  assert.equal(projectPath('/repo/out-nomaps-extra/src/math.js', rules), null)
})

test('honours a custom extension map', () => {
  const custom = [{ from: '/repo/out', to: '/repo', extensions: { '.mjs': '.mts' } }]
  assert.equal(projectPath('/repo/out/a/b.mjs', custom), '/repo/a/b.mts')
})

test('leaves an extension it has no mapping for unchanged', () => {
  assert.equal(projectPath('/repo/out-nomaps/src/theme.css', rules), '/repo/src/theme.css')
})

test('tries rules in order, so a narrow rule can precede a broad one', () => {
  const ordered = [
    { from: '/repo/out-nomaps/generated', to: '/repo/gen' },
    { from: '/repo/out-nomaps', to: '/repo' },
  ]
  assert.equal(projectPath('/repo/out-nomaps/generated/x.js', ordered), '/repo/gen/x.ts')
  assert.equal(projectPath('/repo/out-nomaps/src/x.js', ordered), '/repo/src/x.ts')
})

test('tolerates a trailing slash on either prefix', () => {
  const trailing = [{ from: '/repo/out-nomaps/', to: '/repo/' }]
  assert.equal(projectPath('/repo/out-nomaps/src/x.js', trailing), '/repo/src/x.ts')
})
