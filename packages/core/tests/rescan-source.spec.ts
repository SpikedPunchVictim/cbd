/**
 * `cbd-0gw`: a service the suite starts itself, read from the window that starts it.
 *
 * `socketSource` reads the service a run was pointed at. This reads that one *and* the
 * ones a test starts along the way — which is a different claim, and one no run in this
 * repository had ever made: the fixture suites all start their service before the suite
 * begins, so the source is installed with the target already there.
 *
 * The measurement that made this a task rather than an assumption is in `arch/log.md`
 * (2026-10-17): a probe started a lane-shaped service and then a test-shaped one, and
 * `discoverSockets` returned both, with the child instrumented and answering. Nothing
 * was missing but a second look.
 *
 * What is asserted here, and why each is a different failure:
 *
 *   - Two services in one directory are both read, where `socketSource` refuses to
 *     choose. Their script ids are namespaced by pid, without which the child's entry
 *     script answers for the lane's and the map resolves the wrong file.
 *   - A service that appears *after* the source was opened is read from the window that
 *     started it, and its next window is a delta rather than its life repeated. Get the
 *     first of those wrong and a test that starts a server is recorded as touching none
 *     of it: under-selection, and the one failure this project does not accept.
 *   - A window in which nothing drove the late service holds none of its code, so
 *     "empty" keeps meaning "nothing was recorded" rather than "not looked at yet".
 *   - A socket left behind by a process that was killed does not take the run down, and
 *     does not cost a connect per boundary for the rest of it.
 *
 * Every test kills its services. A service left running holds this process's stdio pipes
 * open, so japa finishes the suite and the process then never exits — a silent hang with
 * the report buffered behind it.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { rescanningSocketSource, socketSource } from '../src/adapter.js'
import type { QueuedSource, V8ScriptCoverage } from '../src/types.js'
import { launchService, waitForSocket, type RunningService } from './support/service.js'

/** The fixture service, as V8 names it in a payload. */
const FIXTURE = '/tests/service/main.js'

/** The script URLs a payload holds execution for. */
function executedUrls(payload: V8ScriptCoverage[]): Set<string> {
  const urls = new Set<string>()
  for (const script of payload) {
    const ran = script.functions.some((fn) => (fn.ranges[0]?.count ?? 0) > 0)
    if (ran) urls.add(script.url)
  }
  return urls
}

/** The named functions that ran, which is how one command is told from another. */
function executedNames(payload: V8ScriptCoverage[]): Set<string> {
  const names = new Set<string>()
  for (const script of payload) {
    for (const fn of script.functions) {
      if (fn.functionName !== '' && (fn.ranges[0]?.count ?? 0) > 0) names.add(fn.functionName)
    }
  }
  return names
}

/** The pids whose scripts the source has been told about. */
function namespacesOf(source: QueuedSource): Set<string> {
  return new Set([...source.scripts().keys()].map((key) => key.slice(0, key.indexOf(':'))))
}

/** Waits for a service to have written `text`, which is how its work is known to be done. */
async function until(service: RunningService, text: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (service.output().includes(text)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`the service never wrote ${JSON.stringify(text)}. It wrote:\n${service.output()}`)
}

async function started(dir: string): Promise<RunningService> {
  const service = launchService({ CBD_SOCKET_DIR: dir })
  await service.ready
  await waitForSocket(service.socketPath)
  return service
}

test.group('rescanningSocketSource', (group) => {
  group.each.timeout(60_000)

  /**
   * Every service in the directory, where `socketSource` reads one or refuses.
   *
   * The two services run the same file, so the functions they run are named identically
   * and the only way to tell "both are read" from "one is read twice" is to drive them
   * differently and look for both answers. `run` reaches `reverseKey` and `store`
   * reaches `persistKey`; neither command is sent to the other process.
   */
  test('reads both of two services, where socketSource refuses to choose', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
    let a: RunningService | null = null
    let b: RunningService | null = null
    let source: QueuedSource | null = null
    try {
      a = await started(dir)
      b = await started(dir)

      await assert.rejects(
        socketSource({ dir, timeoutMs: 5_000 }),
        /2 instrumented services answered/,
        'the one-target source must still refuse to choose by accident',
      )

      source = await rescanningSocketSource({ dir, timeoutMs: 5_000 })

      // The namespace is the pid, and there are two of them: a scriptId is unique
      // inside one isolate, so two processes' tables cannot share a key space.
      await source.take()
      assert.equal(namespacesOf(source).size, 2, 'two processes were merged under one set of ids')

      a.run('run')
      b.run('store')
      await until(a, 'ran key=')
      await until(b, 'stored:')

      const names = executedNames(await source.take())
      assert.ok(names.has('reverseKey'), `the first service's work is missing: ${[...names].join(', ')}`)
      assert.ok(names.has('persistKey'), `the second service's work is missing: ${[...names].join(', ')}`)
    } finally {
      source?.close()
      a?.stop()
      b?.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * A service that starts mid-run, read from the window that started it.
   *
   * This is the whole of `cbd-0gw`. The child is launched *after* the source is
   * installed, so nothing at install could have found it, and the window that follows is
   * the one it was started in — which is the window whose failure its start-up would
   * have caused. Its script table has to arrive in that window and not the next one, and
   * the window after that has to be a delta: a service read as a running total would
   * show its module body again, and would look entirely ordinary to every other
   * assertion here.
   */
  test('attributes a service that appears mid-run to the window that started it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
    let lane: RunningService | null = null
    let child: RunningService | null = null
    let source: QueuedSource | null = null
    try {
      lane = await started(dir)
      source = await rescanningSocketSource({ dir, timeoutMs: 5_000 })
      const laneNamespace = String(source.pid)

      /** The lane's own life, which is the first window of the run. */
      const first = await source.take()
      assert.ok(
        [...executedUrls(first)].some((url) => url.endsWith(FIXTURE)),
        'the service that was there all along was not read',
      )

      child = await started(dir)

      // The window that started it. Its take is the child's whole life, because the
      // instrument module's counters begin when the process does.
      const born = await source.take()
      const arrived = [...namespacesOf(source)].filter((pid) => pid !== laneNamespace)
      assert.equal(arrived.length, 1, `the child was not attached: namespaces ${[...namespacesOf(source)].join(', ')}`)
      assert.ok(
        [...executedUrls(born)].some((url) => url.endsWith(FIXTURE)),
        'the start-up of the service this window started is not in this window',
      )

      // And the next window is a window, not the whole life again: the child's own
      // command, and nothing of its start-up.
      child.run('store')
      await until(child, 'stored:')
      const after = executedNames(await source.take())
      assert.ok(after.has('persistKey'), `the child's work is missing: ${[...after].join(', ')}`)

      // The lane is still read, from the same boundaries, after all of that.
      lane.run('run')
      await until(lane, 'ran key=')
      const laneWindow = executedNames(await source.take())
      assert.ok(laneWindow.has('reverseKey'), 'the first service stopped being read once a second appeared')

      // And a window in which neither was driven holds neither's code. This is what
      // keeps an empty window meaning "nothing was recorded" rather than "not looked at".
      const idle = await source.take()
      assert.deepEqual(
        [...executedUrls(idle)].filter((url) => url.endsWith(FIXTURE)),
        [],
        'a window that drove nothing on either service holds the fixture service',
      )
    } finally {
      source?.close()
      lane?.stop()
      child?.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * A socket left by a process that was killed.
   *
   * `SIGKILL` skips the instrument module's tidy-up, so the file stays and there is
   * nothing behind it. It must not take the window down, and it must not cost a connect
   * at every boundary for the rest of the run — which is why it is written off after the
   * second failure rather than retried forever.
   */
  test('a socket left behind by a killed service does not break the window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
    let live: RunningService | null = null
    let dead: RunningService | null = null
    let source: QueuedSource | null = null
    try {
      dead = await started(dir)
      dead.stop()
      live = await started(dir)

      source = await rescanningSocketSource({ dir, timeoutMs: 5_000 })
      await source.take()

      // One more window, which is where the stale path fails for the second time and is
      // written off. A source that retried it forever would be retrying it from here on.
      await source.take()

      live.run('store')
      await until(live, 'stored:')
      const names = executedNames(await source.take())
      assert.ok(names.has('persistKey'), `the live service stopped being read: ${[...names].join(', ')}`)
    } finally {
      source?.close()
      live?.stop()
      dead?.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// The swallow is deliberate — one dead target must not blank the others — but a
// window that dies with its target is still a lost window. The recorder counts
// rejections, and there is none left to count, so the source must count it.
test('a target that dies mid-run is counted as a lost window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
  let live: RunningService | null = null
  let source: QueuedSource | null = null
  try {
    live = await started(dir)
    source = await rescanningSocketSource({ dir, timeoutMs: 5_000 })
    await source.take()

    live.stop()
    await source.take()

    assert.ok(
      (source.lostTakes?.() ?? 0) >= 1,
      'a window lost with its target must reach the health record',
    )
  } finally {
    source?.close()
    live?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
