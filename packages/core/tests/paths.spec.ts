/**
 * `canonicalPath`: one spelling for a path that may not exist yet.
 *
 * The build canonicalizes its root, and every recorded path is compared against it;
 * a path under a symlink that is spelled the other way is "outside the root" and its
 * test is silently not selected.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from '@japa/runner'
import { canonicalPath } from '../src/paths.js'

test.group('canonicalPath', () => {
  test('an existing path is its realpath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-paths-'))
    try {
      const real = join(dir, 'real')
      mkdirSync(real)
      const link = join(dir, 'link')
      symlinkSync(real, link)
      const file = join(real, 'a.txt')
      writeFileSync(file, 'x')
      assert.equal(canonicalPath(join(link, 'a.txt')), realpathSync(file))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A test that asserts a file's absence reads a path that does not exist; the file
  // may be created later, and that creation must select the test.
  test('a missing tail under a symlink keeps the canonical prefix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-paths-'))
    try {
      const real = join(dir, 'real')
      mkdirSync(real)
      const link = join(dir, 'link')
      symlinkSync(real, link)
      assert.equal(canonicalPath(join(link, 'later', 'created.txt')),
        join(realpathSync(real), 'later', 'created.txt'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a path outside any existing directory still answers', () => {
    assert.equal(canonicalPath('/definitely/not/here/file.ts'), resolve('/definitely/not/here/file.ts'))
  })
})
