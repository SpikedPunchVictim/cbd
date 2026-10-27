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
  closeSync,
  constants as fsConstants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  open,
  openSync,
  readFileSync as esmReadFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { copyFile, cp, open as openHandle, readdir, readFile, readlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { installReadTracking } from '../src/read-tracker.js'

function makeTree(): {
  root: string
  file: string
  missing: string
  cleanup: () => void
} {
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

function trackReads(): { reads: string[]; dirs: string[]; stop: () => void } {
  const reads: string[] = []
  const dirs: string[] = []
  const stop = installReadTracking({
    noteRead: (path) => reads.push(path),
    noteReadDir: (path) => dirs.push(path),
  })
  return { reads, dirs, stop }
}

test('a file opened for reading is a read, however the flags spell it', async () => {
  const tree = makeTree()
  try {
    const { reads, stop } = trackReads()
    try {
      for (const flags of [
        'r',
        'r+',
        'rs+',
        'a+',
        'w+',
        fsConstants.O_RDONLY,
        fsConstants.O_RDWR,
      ]) {
        reads.length = 0
        closeSync(openSync(tree.file, flags))
        assert.ok(reads.includes(tree.file), `openSync(${String(flags)}) not tracked`)
      }
      reads.length = 0
      closeSync(openSync(tree.file, undefined as never))
      assert.ok(reads.includes(tree.file), 'default flags read')

      reads.length = 0
      await new Promise<void>((done, fail) =>
        open(tree.file, 'r', (error, fd) => (error ? fail(error) : (closeSync(fd), done()))),
      )
      assert.ok(reads.includes(tree.file), 'callback open not tracked')

      reads.length = 0
      const handle = await openHandle(tree.file)
      await handle.readFile('utf8')
      await handle.close()
      assert.ok(reads.includes(tree.file), 'FileHandle read not tracked')
    } finally {
      stop()
    }
  } finally {
    tree.cleanup()
  }
})

test('a file opened only for writing is not a read', async () => {
  const tree = makeTree()
  try {
    const { reads, stop } = trackReads()
    try {
      const writeOnly = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC
      for (const flags of ['w', 'wx', 'a', 'ax', writeOnly]) {
        const target = join(tree.root, `out-${String(flags)}.txt`)
        closeSync(openSync(target, flags))
        await (await openHandle(target, typeof flags === 'string' ? 'a' : 'w')).close()
      }
      assert.deepEqual(reads, [])
    } finally {
      stop()
    }
  } finally {
    tree.cleanup()
  }
})

test('copyFile and readlink record the file they read', async () => {
  const tree = makeTree()
  try {
    const link = join(tree.root, 'link')
    symlinkSync('data.txt', link)
    const { reads, dirs, stop } = trackReads()
    try {
      const expectRead = (path: string, what: string): void => {
        assert.ok(reads.includes(path), `${what} not tracked: ${reads.join(', ')}`)
        reads.length = 0
      }
      copyFileSync(tree.file, join(tree.root, 'c1'))
      expectRead(tree.file, 'copyFileSync source')
      await copyFile(tree.file, join(tree.root, 'c2'))
      expectRead(tree.file, 'promises.copyFile source')
      cpSync(tree.file, join(tree.root, 'c3'))
      expectRead(tree.file, 'cpSync source')
      await cp(tree.file, join(tree.root, 'c4'))
      expectRead(tree.file, 'promises.cp source')
      mkdirSync(join(tree.root, 'tree'))
      cpSync(join(tree.root, 'tree'), join(tree.root, 'tree2'), { recursive: true })
      assert.ok(dirs.includes(join(tree.root, 'tree')), 'recursive cp reads the directory tree')
      reads.length = 0
      readlinkSync(link)
      expectRead(link, 'readlinkSync')
      await readlink(link)
      expectRead(link, 'promises.readlink')
    } finally {
      stop()
    }
  } finally {
    tree.cleanup()
  }
})
