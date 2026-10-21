/**
 * The read tracker: which public `fs` calls it sees, and that it puts the module
 * back.
 *
 * A named ESM import is the case worth pinning: it is a live binding to the
 * builtin's exports, so without `syncBuiltinESMExports()` the wrapper would only
 * catch `fs.readFileSync(...)` calls, not `import { readFileSync }` — and a spec
 * that imports the function is the common shape.
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync as esmReadFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { installReadTracking } from '../src/read-tracker.js'

function makeTree(): { root: string; file: string; missing: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cbd-reads-')))
  const file = join(root, 'data.txt')
  writeFileSync(file, 'one\n')
  mkdirSync(join(root, 'sub'))
  return {
    root,
    file,
    missing: join(root, 'absent.txt'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('tracks sync, ESM-named, promise and directory reads', async () => {
  const tree = makeTree()
  try {
    const reads: string[] = []
    const dirs: string[] = []
    const stop = installReadTracking({
      noteRead: (path) => reads.push(path),
      noteReadDir: (path) => dirs.push(path),
    })
    try {
      esmReadFileSync(tree.file, 'utf8')
      await readFile(tree.file, 'utf8')
      await readdir(tree.root)
      assert.equal(existsSync(tree.missing), false)

      assert.ok(reads.includes(tree.file), `sync/ESM/promise read missing: ${reads.join(', ')}`)
      assert.ok(reads.includes(tree.missing), 'an existence check is a dependency too')
      assert.ok(dirs.includes(tree.root), `directory read missing: ${dirs.join(', ')}`)
    } finally {
      stop()
    }

    const before = reads.length
    esmReadFileSync(tree.file, 'utf8')
    assert.equal(reads.length, before, 'uninstall restores the original functions')
  } finally {
    tree.cleanup()
  }
})

test('the newest installed sink is the active one', async () => {
  const tree = makeTree()
  try {
    const first: string[] = []
    const second: string[] = []
    const stopFirst = installReadTracking({
      noteRead: (path) => first.push(path),
      noteReadDir: () => {},
    })
    const stopSecond = installReadTracking({
      noteRead: (path) => second.push(path),
      noteReadDir: () => {},
    })
    try {
      esmReadFileSync(tree.file, 'utf8')
      assert.deepEqual(first, [], 'the older file must not receive the newer file’s reads')
      assert.deepEqual(second, [tree.file])
    } finally {
      stopSecond()
    }
    esmReadFileSync(tree.file, 'utf8')
    assert.deepEqual(first, [tree.file], 'removing the top sink falls back to the previous one')
    stopFirst()
  } finally {
    tree.cleanup()
  }
})
