/**
 * Record the files a test reads, for oracles coverage cannot see.
 *
 * A test that greps `drain.ts`, lists `edge/pipeline/src`, or has `tsc` read a
 * declaration executes none of the file it depends on. V8 coverage therefore has
 * no edge to draw, and a change to the read file looked unrelated. The tracker
 * wraps the public `node:fs` / `node:fs/promises` read, stat and directory APIs
 * **in the test process** and reports each path to the open test window; the
 * build then carries `reads` / `dirReads` into the map, and selection treats a
 * change to one as reaching the test.
 *
 * **What this can and cannot see.** It sees calls through the public `fs` module
 * after `syncBuiltinESMExports()`, so named ESM imports and libraries that call
 * `fs.readFileSync` at call time (including `ts.sys`) are captured. It does not
 * see a module that captured a function reference before the install, native
 * addons, a child process (Node or otherwise), or a separately started service.
 * Those remain the job of `alwaysSelect`; the docs and the README say so rather
 * than implying read tracking is complete.
 *
 * **Only the open window is charged.** A read during test-file import, between
 * tests, or after the last test has no test to attribute it to. The load/between
 * buckets already escalate those dependencies, and guessing would be worse than
 * the gap.
 *
 * Reads are reported at **call time**, not completion: the path is known then, and
 * an async read that finishes after the window still belongs to the test that
 * asked for it. The sink may be one recorder per process (japa) or one per test
 * file (Vitest/Jest); installs form a stack, and the newest is the active one.
 */
import fs from 'node:fs'
import promises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalPath } from './paths.js'

/** What the recorder exposes to the tracker. */
export interface ReadSink {
  noteRead(path: string): void
  noteReadDir(path: string): void
}

/** `source` is a copy origin: a file or, for a recursive `cp`, a directory tree. */
type Kind = 'file' | 'dir' | 'link' | 'source'
type AnyFn = (...args: unknown[]) => unknown
type Target = Record<string, unknown>

interface Installed {
  sink: ReadSink
}

const stack: Installed[] = []
let saved: Array<{ target: Target; name: string; original: AnyFn }> | null = null
let suppressed = 0

/**
 * Run internal work whose file reads are not test dependencies.
 *
 * The recorder projects captured coverage inside a test boundary, and a queued
 * source may do that after the next test has started. Those reads belong to the
 * tool, not the test; without this they made the next test look like it had read
 * every source the previous window touched.
 */
export function withoutReadTracking<T>(fn: () => T): T {
  suppressed += 1
  try {
    return fn()
  } finally {
    suppressed -= 1
  }
}

const FILE_FS = [
  'readFileSync',
  'readFile',
  'createReadStream',
  'existsSync',
  'statSync',
  'stat',
  'lstatSync',
  'lstat',
  'accessSync',
  'access',
] as const
const OPEN_FS = ['openSync', 'open'] as const
const OPEN_PROMISES = ['open'] as const
// The first argument is the file read: the source of a copy.
const SOURCE_FS = ['copyFileSync', 'copyFile', 'cpSync', 'cp', 'openAsBlob'] as const
const SOURCE_PROMISES = ['copyFile', 'cp'] as const
// A link's own path, not what it points at: `canonicalPath` would follow it to the target.
const LINK_FS = ['readlinkSync', 'readlink'] as const
const LINK_PROMISES = ['readlink'] as const
const DIR_FS = ['readdirSync', 'readdir', 'opendirSync', 'opendir'] as const
const FILE_PROMISES = ['readFile', 'stat', 'lstat', 'access'] as const
const DIR_PROMISES = ['readdir', 'opendir'] as const

/**
 * The path argument of an fs call, canonical, or `undefined` for a file
 * descriptor or an unsupported value.
 *
 * A missing path (an `existsSync` check) has its nearest existing ancestor
 * canonicalized, so a later creation of that file still matches the build's root
 * even through a symlinked checkout.
 */
function pathOf(value: unknown): string | undefined {
  const resolved = absolutePathOf(value)
  return resolved === undefined ? undefined : canonicalPath(resolved)
}

function absolutePathOf(value: unknown): string | undefined {
  let path: string
  if (typeof value === 'string') path = value
  else if (Buffer.isBuffer(value)) path = value.toString()
  else if (value instanceof URL) {
    try {
      path = fileURLToPath(value)
    } catch {
      return undefined
    }
  } else return undefined
  return resolve(path)
}

/** A symlink's own path: only its directory is canonicalized, never the link. */
function linkPathOf(value: unknown): string | undefined {
  const resolved = absolutePathOf(value)
  if (resolved === undefined) return undefined
  return join(canonicalPath(dirname(resolved)), basename(resolved))
}

function note(kind: Kind, value: unknown): void {
  if (suppressed > 0) return
  const path = kind === 'link' ? linkPathOf(value) : pathOf(value)
  const sink = stack[stack.length - 1]?.sink
  if (path === undefined || sink === undefined) return
  try {
    if (kind === 'dir' || kind === 'source') sink.noteReadDir(path)
    if (kind !== 'dir') sink.noteRead(path)
  } catch {
    // A tracker never breaks the read it is observing.
  }
}

function wrap(original: AnyFn, kind: Kind): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    note(kind, args[0])
    return original.apply(this, args)
  }
}

/**
 * Whether `open` flags permit reading. Opening for read is the dependency: a
 * later `read` or `FileHandle.readFile` goes through a descriptor with no path, so
 * the open is the one place the path is known. Only a write-only mode (`w`, `a`,
 * `wx`, `as`, `O_WRONLY`) is not a read; anything unrecognised counts as one, so
 * a surprising flag over-selects rather than hides a dependency.
 */
function opensForRead(flags: unknown): boolean {
  if (flags === undefined || flags === null) return true
  // The low two bits are the access mode (O_RDONLY 0, O_WRONLY 1, O_RDWR 2).
  if (typeof flags === 'number') return (flags & 3) !== fs.constants.O_WRONLY
  if (typeof flags === 'string') return flags.includes('+') || !/^[wa]/.test(flags)
  return true
}

/** `open` wrapper: the path is a read only when the flags allow reading. */
function wrapOpen(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    // `open(path, cb)` and `open(path, flags, cb)`: a function is not flags.
    const flags = typeof args[1] === 'function' ? undefined : args[1]
    if (opensForRead(flags)) note('file', args[0])
    return original.apply(this, args)
  }
}

function patch(): Array<{ target: Target; name: string; original: AnyFn }> {
  const originals: Array<{ target: Target; name: string; original: AnyFn }> = []
  const wrapOpens = (target: Target, names: readonly string[]): void => {
    for (const name of names) {
      const original = target[name]
      if (typeof original !== 'function') continue
      originals.push({ target, name, original: original as AnyFn })
      target[name] = wrapOpen(original as AnyFn)
    }
  }
  const fsPromises = (fs as unknown as { promises: Target }).promises
  // `node:fs/promises` can be a distinct object from `fs.promises` on some Node
  // versions; patch the namespace the adapter imported as well, but never the
  // same object twice (a double wrap restores a wrapper and leaks it).
  const targets: Array<[Target, readonly string[], Kind]> = [
    [fs as unknown as Target, FILE_FS, 'file'],
    [fs as unknown as Target, SOURCE_FS, 'source'],
    [fs as unknown as Target, LINK_FS, 'link'],
    [fs as unknown as Target, DIR_FS, 'dir'],
    [promises as unknown as Target, SOURCE_PROMISES, 'source'],
    [promises as unknown as Target, FILE_PROMISES, 'file'],
    [promises as unknown as Target, LINK_PROMISES, 'link'],
    [promises as unknown as Target, DIR_PROMISES, 'dir'],
    ...(fsPromises === (promises as unknown as Target)
      ? []
      : ([
          [fsPromises, FILE_PROMISES, 'file'],
          [fsPromises, SOURCE_PROMISES, 'source'],
          [fsPromises, LINK_PROMISES, 'link'],
          [fsPromises, DIR_PROMISES, 'dir'],
        ] as Array<[Target, readonly string[], Kind]>)),
  ]
  for (const [target, names, kind] of targets) {
    for (const name of names) {
      const original = target[name]
      if (typeof original !== 'function') continue
      originals.push({ target, name, original: original as AnyFn })
      target[name] = wrap(original as AnyFn, kind)
    }
  }
  wrapOpens(fs as unknown as Target, OPEN_FS)
  wrapOpens(promises as unknown as Target, OPEN_PROMISES)
  if (fsPromises !== (promises as unknown as Target)) wrapOpens(fsPromises, OPEN_PROMISES)
  return originals
}

/**
 * Install a sink for this process. Returns an idempotent uninstall.
 *
 * Installs form a stack so a runner that runs several test files in one worker
 * (Vitest, Jest) can open a sink per file; the newest open window receives reads.
 * Patching is process-wide and is restored when the last sink is removed.
 */
export function installReadTracking(sink: ReadSink): () => void {
  const entry: Installed = { sink }
  if (stack.length === 0) {
    saved = patch()
    syncBuiltinESMExports()
  }
  stack.push(entry)
  let removed = false
  return (): void => {
    if (removed) return
    removed = true
    const index = stack.indexOf(entry)
    if (index !== -1) stack.splice(index, 1)
    if (stack.length === 0 && saved !== null) {
      for (const { target, name, original } of saved) target[name] = original
      saved = null
      syncBuiltinESMExports()
    }
  }
}
