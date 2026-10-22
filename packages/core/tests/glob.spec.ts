import assert from 'node:assert/strict'
import { test } from '@japa/runner'
import { matchesGlob } from '../src/glob.js'

test('brace alternatives are globs, not literals', () => {
  assert.equal(matchesGlob('src/a.ts', 'src/**/*.{ts,tsx}'), true)
  assert.equal(matchesGlob('src/deep/a.tsx', 'src/**/*.{ts,tsx}'), true)
  assert.equal(matchesGlob('src/a.js', 'src/**/*.{ts,tsx}'), false)
})

test('character classes match one non-separator character', () => {
  assert.equal(matchesGlob('src/a.ts', 'src/[ab].ts'), true)
  assert.equal(matchesGlob('src/c.ts', 'src/[ab].ts'), false)
  assert.equal(matchesGlob('src/deep/a.ts', 'src/[!b].ts'), false, 'a negated class does not cross /')
})

test('both separators spell the same path', () => {
  assert.equal(matchesGlob('C:\\repo\\src\\a.ts', 'C:\\repo\\src\\**\\*.ts'), true)
  assert.equal(matchesGlob('C:\\repo\\src\\deep\\a.ts', 'C:\\repo\\src\\*.ts'), false)
  assert.equal(matchesGlob('C:\\repo\\src\\deep\\a.ts', 'C:\\repo\\src\\**\\*.ts'), true)
})
