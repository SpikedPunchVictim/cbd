/**
 * Spawns are invisible dependencies: V8 sees the call and nothing the child does.
 * The tracker notes an opaque dependency so the test is selected by any in-scope
 * change, unless the consumer turns it off.
 */
import assert from 'node:assert/strict'
import childProcess, { execFileSync, spawnSync } from 'node:child_process'
import cluster from 'node:cluster'
import { once } from 'node:events'
import { promisify } from 'node:util'
import workerThreads from 'node:worker_threads'
import { test } from '@japa/runner'
import { installProcessTracking } from '../src/process-tracker.js'

const RealWorker = workerThreads.Worker

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

test('a tracked execFile and exec keep their promisified { stdout, stderr } result', async () => {
  const reasons: string[] = []
  const stop = installProcessTracking({ noteOpaque: (reason) => reasons.push(reason) })
  try {
    // Read at call time: the named export is re-pointed at the wrapper.
    const run = promisify(childProcess.execFile)
    const { stdout } = await run(process.execPath, ['-e', 'process.stdout.write("hi")'])
    assert.equal(stdout, 'hi')
    const shell = await promisify(childProcess.exec)('printf hi')
    assert.equal(shell.stdout, 'hi')
    assert.ok(reasons.length >= 2, 'promisified spawns are still recorded')
  } finally {
    stop()
  }
})

test('the wrapper restores the original execFile, promisify hook included', () => {
  const original = childProcess.execFile
  const stop = installProcessTracking({ noteOpaque: () => {} })
  stop()
  assert.equal(childProcess.execFile, original)
})

test('a worker thread is recorded as an opaque dependency and stays a working class', async () => {
  const reasons: string[] = []
  const stop = installProcessTracking({ noteOpaque: (reason) => reasons.push(reason) })
  try {
    // Read at call time: the named export is re-pointed at the wrapper.
    const { Worker } = workerThreads
    const worker = new Worker('process.exit(0)', { eval: true })
    assert.ok(worker instanceof Worker)
    assert.ok(worker instanceof RealWorker)
    class Sub extends Worker {}
    const sub = new Sub('process.exit(0)', { eval: true })
    assert.ok(sub instanceof Sub)
    assert.equal(typeof Worker.name, 'string')
    await Promise.all([once(worker, 'exit'), once(sub, 'exit')])
    assert.deepEqual(reasons, ['spawned a process', 'spawned a process'])
  } finally {
    stop()
  }
  assert.equal(workerThreads.Worker, RealWorker)
})

test('a cluster fork is recorded as an opaque dependency and restored on uninstall', () => {
  const reasons: string[] = []
  const real = cluster.fork
  // A stand-in: the real fork would start another copy of this process.
  let forked = 0
  const stub = ((): never => {
    forked++
    return undefined as never
  }) as unknown as typeof cluster.fork
  cluster.fork = stub
  try {
    const stop = installProcessTracking({ noteOpaque: (reason) => reasons.push(reason) })
    try {
      assert.notEqual(cluster.fork, stub)
      cluster.fork()
    } finally {
      stop()
    }
    assert.equal(cluster.fork, stub)
  } finally {
    cluster.fork = real
  }
  assert.equal(forked, 1)
  assert.deepEqual(reasons, ['spawned a process'])
})
