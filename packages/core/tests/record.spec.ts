import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { activateRecordSink, recordDependency, recordRead } from '../src/record.js'

test('declared reads and dependencies are canonicalized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-record-'))
  try {
    const real = join(dir, 'real')
    mkdirSync(real)
    const file = join(real, 'x.ts')
    writeFileSync(file, 'x\n')
    const link = join(dir, 'link')
    symlinkSync(real, link)

    const reads: string[] = []
    const dependencies: string[] = []
    const release = activateRecordSink({
      noteRead: (path) => reads.push(path),
      noteReadDir: () => {},
      noteOpaque: () => {},
      noteDependency: (paths) => dependencies.push(...paths),
    })
    try {
      recordRead(join(link, 'x.ts'))
      recordDependency(join(link, 'x.ts'))
    } finally {
      release()
    }
    const canonical = realpathSync(file)
    assert.deepEqual(reads, [canonical])
    assert.deepEqual(dependencies, [canonical])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
