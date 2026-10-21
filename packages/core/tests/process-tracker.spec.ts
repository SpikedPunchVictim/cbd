/**
 * Spawns are invisible dependencies: V8 sees the call and nothing the child does.
 * The tracker notes an opaque dependency so the test is selected by any in-scope
 * change, unless the consumer turns it off.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { test } from '@japa/runner'
import { installProcessTracking } from '../src/process-tracker.js'

test('a spawned child is recorded as an opaque dependency', () => {
  const reasons: string[] = []
  const stop = installProcessTracking({ noteOpaque: (reason) => reasons.push(reason) })
  try {
    execFileSync(process.execPath, ['-e', ''])
    spawnSync(process.execPath, ['-e', ''])
  } finally {
    stop()
  }
  assert.deepEqual(reasons, ['spawned a process', 'spawned a process'])
})

test('CBD_TRACK_PROCESSES=0 turns the tracker off', () => {
  const reasons: string[] = []
  const saved = process.env.CBD_TRACK_PROCESSES
  process.env.CBD_TRACK_PROCESSES = '0'
  try {
    const stop = installProcessTracking({ noteOpaque: (reason) => reasons.push(reason) })
    try {
      execFileSync(process.execPath, ['-e', ''])
    } finally {
      stop()
    }
  } finally {
    if (saved === undefined) delete process.env.CBD_TRACK_PROCESSES
    else process.env.CBD_TRACK_PROCESSES = saved
  }
  assert.deepEqual(reasons, [])
})
