/**
 * Group recording through mocha's programmatic entry point, and the guard around the
 * suite-end boundary. In-process: the questions are about what the adapter wires, not
 * about a child's environment.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from '@japa/runner'
import Mocha from 'mocha'
import type { Recorder } from '@spikedpunch/cbd/adapter'
import { attachGroupEnd, installMochaAdapter } from '../src/adapter.js'

function fakeRecorder(onGroupEnd: () => void): Recorder {
  return {
    testStart: () => {},
    testEnd: () => {},
    groupEnd: onGroupEnd,
    runEnd: () => Promise.resolve(),
  } as unknown as Recorder
}

test('installMochaAdapter reports each suite end, so a group recording gets its windows', async () => {
  let groupEnds = 0
  const mocha = new Mocha({ reporter: function () {} as unknown as Mocha.ReporterConstructor })
  installMochaAdapter(
    mocha,
    fakeRecorder(() => {
      groupEnds += 1
    }),
  )
  const suite = Mocha.Suite.create(mocha.suite, 'a group')
  suite.addTest(new Mocha.Test('passes', () => {}))
  await new Promise<void>((resolve) => mocha.run(() => resolve()))
  assert.ok(groupEnds >= 1, 'no suite end reached the recorder')
})

test('a recorder that throws at a suite end does not take the run down', () => {
  const runner = new EventEmitter()
  const written: string[] = []
  const realWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    attachGroupEnd(runner as never, {
      groupEnd: () => {
        throw new Error('ENOSPC')
      },
    })
    assert.doesNotThrow(() => runner.emit('suite end'))
  } finally {
    process.stderr.write = realWrite
  }
  assert.match(written.join(''), /a recorder step failed \(ENOSPC\)/)
})
