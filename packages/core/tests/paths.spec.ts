/**
 * `canonicalPath`: one spelling for a path that may not exist yet.
 *
 * The build canonicalizes its root, and every recorded path is compared against it;
 * a path under a symlink that is spelled the other way is "outside the root" and its
 * test is silently not selected.
 */
import assert from 'node:assert/strict'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from '@japa/runner'
import { canonicalPath, realpath, realpathFor } from '../src/paths.js'

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
      assert.equal(canonicalPath(join(link, 'a.txt')), realpath(file))
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
        join(realpath(real), 'later', 'created.txt'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('a path outside any existing directory still answers', () => {
    assert.equal(canonicalPath('/definitely/not/here/file.ts'), resolve('/definitely/not/here/file.ts'))
  })
})

// The two implementations answer differently only for a Windows 8.3 short name, so
// which one a platform gets is checked with stand-ins that say which was called.
test.group('realpathFor', () => {
  const stand = (() => {
    const js = (p: string): string => `js:${p}`
    const native = (p: string): string => `native:${p}`
    return { realpathSync: Object.assign(js, { native }) } as unknown as typeof import('node:fs')
  })()

  test('win32 asks the OS, which expands short names', () => {
    assert.equal(realpathFor('win32', stand)('C:\\RUNNER~1'), 'native:C:\\RUNNER~1')
  })

  test('other platforms keep the JS implementation', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      assert.equal(realpathFor(platform, stand)('/tmp'), 'js:/tmp')
    }
  })
})

// A real 8.3 name: only Windows has them, and only when the volume generates them.
test.group('short names', () => {
  const shortNameOf = (dir: string): string =>
    execSync(`for %I in ("${dir}") do @echo %~sI`, { encoding: 'utf8' }).trim()

  test('a short-name spelling canonicalizes to the long one git reports', () => {
    const dir = realpath(mkdtempSync(join(tmpdir(), 'cbd-shortname-check-')))
    try {
      const short = shortNameOf(dir)
      assert.notEqual(short.toLowerCase(), dir.toLowerCase(), 'the volume should generate short names')
      assert.equal(realpath(short), dir)
      assert.equal(canonicalPath(join(short, 'missing', 'x.ts')), join(dir, 'missing', 'x.ts'))

      execFileSync('git', ['init', '-q'], { cwd: short })
      const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: short, encoding: 'utf8' })
        .trim()
        .replace(/\//g, '\\')
      assert.equal(top.toLowerCase(), realpath(short).toLowerCase())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }).skip(process.platform !== 'win32', 'only Windows has 8.3 short names')
})
