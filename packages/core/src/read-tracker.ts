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
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalPath } from './paths.js'

/** What the recorder exposes to the tracker. */
export interface ReadSink {
  noteRead(path: string): void
  noteReadDir(path: string): void
}

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

// Saved before any patch: path normalization must not re-enter a wrapper.
const realpath = fs.realpathSync.bind(fs)

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
  const resolved = resolve(path)
  return canonicalPath(resolved)
}

function note(kind: 'file' | 'dir', value: unknown): void {
  if (suppressed > 0) return
  const path = pathOf(value)
  const sink = stack[stack.length - 1]?.sink
  if (path === undefined || sink === undefined) return
  try {
    if (kind === 'file') sink.noteRead(path)
    else sink.noteReadDir(path)
  } catch {
    // A tracker never breaks the read it is observing.
  }
}

function wrap(original: AnyFn, kind: 'file' | 'dir'): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    note(kind, args[0])
    return original.apply(this, args)
  }
}

function patch(): Array<{ target: Target; name: string; original: AnyFn }> {
  const originals: Array<{ target: Target; name: string; original: AnyFn }> = []
  const fsPromises = (fs as unknown as { promises: Target }).promises
  // `node:fs/promises` can be a distinct object from `fs.promises` on some Node
  // versions; patch the namespace the adapter imported as well, but never the
  // same object twice (a double wrap restores a wrapper and leaks it).
  const targets: Array<[Target, readonly string[], 'file' | 'dir']> = [
    [fs as unknown as Target, FILE_FS, 'file'],
    [fs as unknown as Target, DIR_FS, 'dir'],
    [promises as unknown as Target, FILE_PROMISES, 'file'],
    [promises as unknown as Target, DIR_PROMISES, 'dir'],
    ...(fsPromises === (promises as unknown as Target)
      ? []
      : ([
          [fsPromises, FILE_PROMISES, 'file'],
          [fsPromises, DIR_PROMISES, 'dir'],
        ] as Array<[Target, readonly string[], 'file' | 'dir']>)),
  ]
  for (const [target, names, kind] of targets) {
    for (const name of names) {
      const original = target[name]
      if (typeof original !== 'function') continue
      originals.push({ target, name, original: original as AnyFn })
      target[name] = wrap(original as AnyFn, kind)
    }
  }
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
