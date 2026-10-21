import { isAbsolute, resolve } from 'node:path'

/**
 * The record API — what a test, or a helper it calls, can tell CBD.
 * **Plain functions, no runner context argument.** The roadmap's constraint is
 * that consumer code gets the API through the adapter contract and nothing else;
 * a helper like `sourceText(path)` should be able to say "this test read this
 * file" without knowing which runner is underneath. The functions here are
 * therefore free of runner types and free of an explicit test id: the recorder
 * that is open when they are called is the one that receives them.
 *
 * **Why not `AsyncLocalStorage`.** The roadmap proposes owning a context per test,
 * which is the right shape for concurrent execution. But none of the supported
 * runners lets a *plugin* wrap the test body: japa emits events around a function
 * it calls itself, and mocha/Vitest/Jest/`node:test` are the same from a reporter's
 * seat. A context established in a `beforeEach` does not necessarily survive into
 * the runner's invocation of the test. So the boundary the adapters already report
 * — start, end — stays the source of truth, and calls are attributed to the open
 * window. Vitest runs files in separate workers and only overlaps tests with its
 * opt-in `concurrent` API; a runner that overlaps by default would need an
 * adapter-side guarantee, which is recorded in the contract ADR.
 *
 * **Outside a window, a call is ignored, not guessed.** A read during spec import
 * has no test to charge and no spec identity the core can see; attributing it to
 * every test in the file would require the adapter to open a context around the
 * import, which is exactly what it cannot do. Ignoring it leaves the change
 * unknown to the map, which escalates to `all` — the safe direction, and the
 * documented reason `alwaysSelect` still exists.
 */

/** What the open recorder offers. Implemented by `Recorder`; no other implementation is expected. */
export interface RecordSink {
  /** A file the test read. */
  noteRead(path: string): void
  /** A directory the test listed. */
  noteReadDir(dir: string): void
  /** Something the test depends on that coverage cannot express. */
  noteOpaque(reason: string): void
  /**
   * A declared dependency: paths the test needs, as files.
   *
   * Separate from `noteRead` so a recorder can keep the two kinds apart in the
   * map if a rule ever needs to; today both select the reader on a change.
   */
  noteDependency(paths: readonly string[]): void
}

let active: RecordSink | null = null

/**
 * Makes `sink` the receiver of record calls until the returned function runs.
 *
 * The recorder calls this at test start and releases at test end. It returns a
 * restore function rather than clearing a global so that a nested recorder (a
 * service's, or a second source in one process) cannot leave the previous one
 * switched off.
 */
export function activateRecordSink(sink: RecordSink): () => void {
  const previous = active
  active = sink
  return () => {
    active = previous
  }
}

/** The sink currently receiving calls, if a test window is open. */
export function recordSink(): RecordSink | null {
  return active
}

function absolute(path: string): string {
  // The recorder's read tracker already sees resolved paths; a helper may pass a
  // path relative to its own working directory, which is the natural thing to
  // write. `resolve` gives both the only shape the map accepts.
  return isAbsolute(path) ? path : resolve(path)
}

/**
 * Declares that the running test read `path`.
 *
 * Call it inside the test (or a helper it calls), not while the spec file is
 * being imported.
 */
export function recordRead(path: string): void {
  active?.noteRead(absolute(path))
}

/** Declares that the running test listed `dir`; a change to any file under it selects the test. */
export function recordDirRead(dir: string): void {
  active?.noteReadDir(absolute(dir))
}

/**
 * Declares files the running test depends on without reading them through `fs`.
 *
 * This is for a test that compiles against a package, compares a generated file,
 * or otherwise depends on something coverage cannot see. Each path is treated as
 * a read for selection.
 */
export function recordDependency(paths: string | readonly string[]): void {
  const list = typeof paths === 'string' ? [paths] : paths
  active?.noteDependency(list.map(absolute))
}

/**
 * Marks the running test as depending on something entirely invisible.
 *
 * A test that spawns a tool, starts a service, or reaches another process has no
 * file to name. Such a test is selected by **any** in-scope change: the marker
 * says only that the map cannot answer for it. Prefer `recordDependency` or
 * `recordRead` when a path can be named — the marker is the honest fallback, not
 * a convenience.
 */
export function recordOpaque(reason: string): void {
  active?.noteOpaque(reason)
}
