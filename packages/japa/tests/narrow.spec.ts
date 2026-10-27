/**
 * Unit tests for narrowing the spec files japa imports.
 *
 * The rule under test is a safety rule: a file is left out of the run only when
 * the selection provably names every test that could matter in the files that
 * remain. Each fallback below is a way that proof can fail, and each must end in
 * "load everything" — extra files cost time, a missing file costs a missed test.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from '@spikedpunch/cbd/adapter'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import type { SelectionTest } from '@spikedpunch/cbd'
import { guardNarrowed, narrowFiles, type NarrowableConfig } from '../src/narrow.js'

function scratch(): { dir: string; spec: (name: string) => string; done: () => void } {
  const dir = realpath(mkdtempSync(join(tmpdir(), 'cbd-japa-narrow-')))
  return {
    dir,
    spec: (name) => {
      const path = join(dir, name)
      writeFileSync(path, '')
      return path
    },
    done: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const entry = (file: string | null, title = 't'): SelectionTest => ({
  id: `${file ?? ''}::${title}`,
  file,
  title,
})

const configOf = (extra: Partial<NarrowableConfig> = {}): NarrowableConfig => ({
  filters: {},
  ...extra,
})

test.group('narrowFiles', () => {
  test('restricts the planner to the files that hold selected tests', () => {
    const s = scratch()
    try {
      const a = s.spec('a.spec.js')
      s.spec('b.spec.js')
      const config = configOf()
      assert.equal(narrowFiles(config, [entry(a, 'one'), entry(a, 'two')]), true)
      assert.deepEqual(config.filters.files, [pathToFileURL(a).pathname])
    } finally {
      s.done()
    }
  })

  test('names every file once per selected file, however many tests it holds', () => {
    const s = scratch()
    try {
      const a = s.spec('a.spec.js')
      const b = s.spec('b.spec.js')
      const config = configOf()
      narrowFiles(config, [entry(a), entry(b), entry(a, 'other')])
      assert.deepEqual(config.filters.files, [pathToFileURL(a).pathname, pathToFileURL(b).pathname])
    } finally {
      s.done()
    }
  })

  test('encodes the path the way the planner sees it', () => {
    const s = scratch()
    try {
      const dir = join(s.dir, 'with space')
      mkdirSync(dir)
      const file = join(dir, 'a.spec.js')
      writeFileSync(file, '')
      const config = configOf()
      narrowFiles(config, [entry(file)])
      assert.deepEqual(config.filters.files, [pathToFileURL(file).pathname])
      assert.match(config.filters.files![0]!, /with%20space/)
    } finally {
      s.done()
    }
  })

  test('names the symlinked spelling of a file as well as its real one', () => {
    const s = scratch()
    try {
      const real = join(s.dir, 'real')
      mkdirSync(real)
      const file = join(real, 'a.spec.js')
      writeFileSync(file, '')
      const link = join(s.dir, 'link')
      symlinkSync(real, link)
      const config = configOf({ cwd: link })
      narrowFiles(config, [entry(file)])
      assert.deepEqual(
        [...config.filters.files!].sort(),
        [pathToFileURL(file).pathname, pathToFileURL(join(link, 'a.spec.js')).pathname].sort(),
      )
    } finally {
      s.done()
    }
  })

  test('loads everything when the selection carries no file information', () => {
    const config = configOf()
    assert.equal(narrowFiles(config, undefined), false)
    assert.equal(config.filters.files, undefined)
  })

  test('loads everything when any selected test has no file', () => {
    const s = scratch()
    try {
      const config = configOf()
      assert.equal(narrowFiles(config, [entry(s.spec('a.spec.js')), entry(null)]), false)
      assert.equal(config.filters.files, undefined)
    } finally {
      s.done()
    }
  })

  test('loads everything when a selected file is not absolute', () => {
    const config = configOf()
    assert.equal(narrowFiles(config, [entry('tests/a.spec.js')]), false)
    assert.equal(config.filters.files, undefined)
  })

  test('loads everything when a selected file does not exist here', () => {
    const s = scratch()
    try {
      const config = configOf()
      assert.equal(narrowFiles(config, [entry(join(s.dir, 'gone.spec.js'))]), false)
      assert.equal(config.filters.files, undefined)
    } finally {
      s.done()
    }
  })

  test('leaves a files filter the caller already set alone', () => {
    const s = scratch()
    try {
      const config = configOf({ filters: { files: ['mine.spec.js'] } })
      assert.equal(narrowFiles(config, [entry(s.spec('a.spec.js'))]), false)
      assert.deepEqual(config.filters.files, ['mine.spec.js'])
    } finally {
      s.done()
    }
  })

  test('loads everything for an empty selection', () => {
    const config = configOf()
    assert.equal(narrowFiles(config, []), false)
    assert.equal(config.filters.files, undefined)
  })
})

/** A stand-in for japa's emitter that lets a test fire events by name. */
function fakeEmitter(): {
  on: (name: string, listener: () => void) => void
  fire: (name: string) => void
} {
  const listeners = new Map<string, Array<() => void>>()
  return {
    on: (name, listener) => void listeners.set(name, [...(listeners.get(name) ?? []), listener]),
    fire: (name) => listeners.get(name)?.forEach((listener) => listener()),
  }
}

test.group('guardNarrowed', () => {
  test('fails the run, naming the files, when nothing started', () => {
    const emitter = fakeEmitter()
    const lines: string[] = []
    const codes: number[] = []
    guardNarrowed(emitter, ['/x/a.spec.js'], { write: (t) => lines.push(t), fail: () => codes.push(1) })
    emitter.fire('runner:end')
    assert.deepEqual(codes, [1])
    assert.match(lines.join(''), /\/x\/a\.spec\.js/)
  })

  test('stays quiet when a test started', () => {
    const emitter = fakeEmitter()
    const lines: string[] = []
    const codes: number[] = []
    guardNarrowed(emitter, ['/x/a.spec.js'], { write: (t) => lines.push(t), fail: () => codes.push(1) })
    emitter.fire('test:start')
    emitter.fire('runner:end')
    assert.deepEqual(codes, [])
    assert.deepEqual(lines, [])
  })
})
