import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from '../src/paths.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { activateRecordSink, recordDependency, recordEnv, recordRead } from '../src/record.js'

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
    const env: string[] = []
    const release = activateRecordSink({
      noteRead: (path) => reads.push(path),
      noteReadDir: () => {},
      noteOpaque: () => {},
      noteDependency: (paths) => dependencies.push(...paths),
      noteEnv: (keys) => env.push(...keys),
    })
    try {
      recordRead(join(link, 'x.ts'))
      recordDependency(join(link, 'x.ts'))
      recordEnv('FEATURE_FLAG')
      recordEnv(['A', 'B'])
    } finally {
      release()
    }
    const canonical = realpath(file)
    assert.deepEqual(reads, [canonical])
    assert.deepEqual(dependencies, [canonical])
    // Declarations pass through as names; the value is hashed by the recorder.
    assert.deepEqual(env, ['FEATURE_FLAG', 'A', 'B'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
