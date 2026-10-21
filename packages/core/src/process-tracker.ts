/**
 * Record a spawned process as an invisible dependency.
 *
 * A test that runs a tool or starts a service has a dependency coverage cannot
 * see: the work happens in another process. V8 sees the `child_process` call and
 * nothing it does. `recordOpaque` is the honest answer — the test is selected by
 * any in-scope change — but expecting every test to remember it leaves the
 * dependency unrecorded the first time someone forgets.
 *
 * This wraps the public `node:child_process` entry points **in the test process**
 * and notes an opaque dependency when a test window is open. Only the call is
 * seen; what the child does is not, and a child that outlives the window is not
 * tracked. A native addon or an already-started service is not a spawn here.
 *
 * A test that spawns something harmless can opt out with
 * `CBD_TRACK_PROCESSES=0`. Treating every spawn as opaque is conservative: it can
 * widen a selection to everything on any change, but it never drops a dependency.
 */
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'

/** What the recorder exposes to the process tracker. */
export interface ProcessSink {
  noteOpaque(reason: string): void
}

const METHODS = [
  'spawn',
  'exec',
  'execFile',
  'fork',
  'spawnSync',
  'execSync',
  'execFileSync',
] as const

type AnyFn = (...args: unknown[]) => unknown

interface Installed {
  sink: ProcessSink
}

const stack: Installed[] = []
let saved: Array<{ name: string; original: AnyFn }> | null = null

function note(): void {
  const sink = stack[stack.length - 1]?.sink
  if (sink === undefined) return
  try {
    sink.noteOpaque('spawned a process')
  } catch {
    // A tracker never breaks the call it is observing.
  }
}

function patch(): Array<{ name: string; original: AnyFn }> {
  const target = childProcess as unknown as Record<string, unknown>
  const originals: Array<{ name: string; original: AnyFn }> = []
  for (const name of METHODS) {
    const original = target[name]
    if (typeof original !== 'function') continue
    originals.push({ name, original: original as AnyFn })
    target[name] = function (this: unknown, ...args: unknown[]) {
      note()
      return (original as AnyFn).apply(this, args)
    }
  }
  return originals
}

/**
 * Install process tracking for this process. Returns an idempotent uninstall.
 *
 * Installs form a stack, like read tracking, so a runner that runs several test
 * files in one worker can attach a sink per file; the newest sink receives the
 * spawn. Patching is process-wide and restored when the last sink is removed.
 */
export function installProcessTracking(sink: ProcessSink): () => void {
  if (process.env.CBD_TRACK_PROCESSES === '0') return (): void => {}
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
      const target = childProcess as unknown as Record<string, unknown>
      for (const { name, original } of saved) target[name] = original
      saved = null
      syncBuiltinESMExports()
    }
  }
}
