/**
 * The Jest test environment: one recorder and one shard per test file.
 *
 * Jest creates a **separate environment instance per test file**, and `setup()` is
 * awaited before the test file is evaluated — which is exactly the point a
 * recorder wants to start at, because the file's import phase is `@load`.
 * `teardown()` is the matching end; the footer is written there.
 *
 * A test environment is loaded with `require`, so this file is built as CommonJS
 * (`dist/cjs`) while the rest of the package is ESM. The core is ESM-only: the
 * dynamic import below is deliberately written so TypeScript's CommonJS transform
 * does not rewrite it to `require` (which would fail on an ESM package on Node
 * versions without `require(esm)`).
 *
 * Events used:
 *   test_start  -> a window opens (unless the test is statically skipped)
 *   test_done   -> a window closes with the status from the test object
 *   (teardown)  -> the footer
 */
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { TestEnvironment } from 'jest-environment-node'
import { shardPathFor, statusOf, titleOf, type JestTestLike } from './identity.js'

interface JestContextLike {
  testPath?: string
}

/** `import()` that survives a CommonJS compile. */
const importModule: (specifier: string) => Promise<unknown> = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<unknown>

interface CoreAdapter {
  FileSink: new (path: string) => unknown
  Recorder: new (options: unknown) => {
    runStart(): void
    runEnd(): Promise<void> | void
    testStart(title: string, file: string | null): void
    testEnd(title: string, status: 'passed' | 'failed' | 'skipped'): void
  }
  inProcessSource(): Promise<unknown>
  installReadTracking(sink: {
    noteRead(path: string): void
    noteReadDir(path: string): void
  }): () => void
  packageCodeRoots(moduleUrl: string, packageName: string): string[]
  scanFromEnv(): Record<string, unknown> | undefined
}

class CbdEnvironment extends TestEnvironment {
  #file: string | null
  #recorder: CoreAdapter['Recorder'] extends new (...args: never[]) => infer R ? R : never | null = null
  #source: { close?: () => void } | null = null
  #stopReads: (() => void) | null = null
  #opened = new WeakSet<object>()

  constructor(config: unknown, context: JestContextLike) {
    super(config as never, context as never)
    this.#file = absolute(context?.testPath ?? null)
  }

  override async setup(): Promise<void> {
    await super.setup()
    const base = process.env.CBD_SHARD
    if (base === undefined || base === '') return

    const core = (await importModule('@spikedpunch/cbd/adapter')) as CoreAdapter
    this.#source = (await core.inProcessSource()) as { close?: () => void }
    const scan = core.scanFromEnv() ?? {}
    const roots = core.packageCodeRoots(pathToFileURL(__filename).href, '@spikedpunch/cbd-jest')
    this.#recorder = new core.Recorder({
      source: this.#source,
      sink: new core.FileSink(
        shardPathFor(base, this.#file ?? `pid-${String(process.pid)}-${String(process.ppid)}`),
      ),
      commit: process.env.CBD_COMMIT ?? 'unknown',
      scan: {
        ...scan,
        selfRoots: [...((scan.selfRoots as string[] | undefined) ?? []), ...roots],
      },
    })
    this.#recorder.runStart()
    this.#stopReads = core.installReadTracking(this.#recorder)
  }

  override async teardown(): Promise<void> {
    if (this.#recorder !== null) {
      // Outside every test window: transformed-script coordinates are fetched here.
      await this.#recorder.runEnd()
      this.#recorder = null
    }
    this.#stopReads?.()
    this.#stopReads = null
    this.#source?.close?.()
    this.#source = null
    await super.teardown()
  }

  override async handleTestEvent(event: { name: string; test?: JestTestLike }): Promise<void> {
    const recorder = this.#recorder
    if (recorder === null) return
    const test = event.test
    if (event.name === 'test_start') {
      // A statically skipped or todo test opens no window: there is nothing to
      // record. It may never reach `test_done`.
      if (test === undefined || test.mode === 'skip' || test.mode === 'todo') return
      const title = titleOf(test)
      if (title === null) return
      recorder.testStart(title, this.#file)
      this.#opened.add(test)
      return
    }
    if (event.name === 'test_done') {
      if (test === undefined || !this.#opened.has(test)) return
      this.#opened.delete(test)
      const title = titleOf(test)
      if (title === null) return
      recorder.testEnd(title, statusOf(test))
    }
  }
}

/** The map keys are realpaths; Jest reports the path it was given. */
function absolute(file: string): string
function absolute(file: null): null
function absolute(file: string | null): string | null
function absolute(file: string | null): string | null {
  if (file === null) return null
  try {
    return realpathSync(file)
  } catch {
    return file
  }
}

export = CbdEnvironment
