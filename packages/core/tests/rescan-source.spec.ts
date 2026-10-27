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
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { Recorder } from '../src/recorder.js'
import { FileSink, parseShard } from '../src/shard.js'
import { rescanningSocketSource, socketSource } from '../src/adapter.js'
import { INSTRUMENT_PROTOCOL } from '../src/instrument-protocol.js'
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

// Windows reuses pids, so a socket path written off for a dead process can be bound
// again by a new one. The write-off belongs to the file it judged, not to the name.
test('a written-off socket path is attached again once a live service binds it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
  let lane: RunningService | null = null
  let late: RunningService | null = null
  let source: QueuedSource | null = null
  try {
    lane = await started(dir)
    const stale = join(dir, 'pid-777779.sock')
    writeFileSync(stale, '')
    source = await rescanningSocketSource({ dir, timeoutMs: 5_000, discoveryIntervalMs: 60_000 })
    await source.take()
    await source.take()

    // The path is now written off. A live service takes the name over.
    late = await started(dir)
    await sleep(30)
    unlinkSync(stale)
    renameSync(late.socketPath, stale)
    await source.take()

    late.run('store')
    await until(late, 'stored:')
    const names = executedNames(await source.take())
    assert.ok(names.has('persistKey'), `the service that took the path over was never read: ${[...names].join(', ')}`)
  } finally {
    source?.close()
    lane?.stop()
    late?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// A boundary that finds a dead process through its stale socket gets the lifetime
// from the connect failure's fallback read, which finishes after the boundary's
// parts were gathered. The window that found it must still carry it.
test('a lifetime recovered through a stale socket lands in the window that found it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
  let lane: RunningService | null = null
  let source: QueuedSource | null = null
  try {
    lane = await started(dir)
    source = await rescanningSocketSource({ dir, timeoutMs: 5_000, discoveryIntervalMs: 60_000 })
    writeFileSync(join(dir, 'pid-777781.sock'), '')
    const path = join(dir, 'pid-777781.coverage.json')
    const snapshot = (extra: object): string =>
      JSON.stringify({
        protocol: INSTRUMENT_PROTOCOL,
        pid: 777781,
        startedAtUs: 1e15,
        atUs: 1e15,
        scripts: [],
        windows: [],
        ...extra,
      })
    // Another collector's file is a final verdict for the snapshot scan, which then
    // skips the file for as long as its mtime stays the same.
    // One whole-second mtime for both writes (see the unparseable-snapshot test).
    const pinned = Math.floor(Date.now() / 1000) + 1
    writeFileSync(path, snapshot({ session: 'old' }))
    utimesSync(path, pinned, pinned)
    await source.take()
    writeFileSync(
      path,
      snapshot({
        endedAtUs: 1e15,
        untaken: [{ scriptId: '1', url: 'file:///x.js', functions: [] }],
      }),
    )
    utimesSync(path, pinned, pinned)

    const payload = await source.take()
    assert.ok(
      payload.some((script) => script.scriptId === '777781:1'),
      'the lifetime found through the socket was dropped from the window that found it',
    )
  } finally {
    source?.close()
    lane?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
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

// A child spawned and finished inside one test can be gone before any socket connect
// succeeds — the shape a suite that shells out to a CLI has. The socket file outlives
// the process, and so does the exit snapshot: the accumulator no take drained, and
// the rows no reply delivered.
test('a process that died before its socket answered is read from its exit snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
  let lane: RunningService | null = null
  let child: RunningService | null = null
  let source: QueuedSource | null = null
  try {
    lane = await started(dir)
    // A long discovery interval keeps the background look from attaching the child
    // while it is alive, so the boundary is the first thing to try its socket — and
    // by then the process is gone and only its exit write is left.
    source = await rescanningSocketSource({ dir, timeoutMs: 5_000, discoveryIntervalMs: 60_000 })

    child = launchService({ CBD_SOCKET_DIR: dir })
    await child.ready
    await waitForSocket(child.socketPath)
    child.run('store')
    await until(child, 'stored:')

    const proc = child.proc
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    child.run('quit')
    await exited

    const payload = await source.take()
    const names = executedNames(payload)
    // The child's own script ids, in the shard's pid namespace: proof the window came
    // from its snapshot rather than from the lane that runs the same file.
    const fromChild = payload.some((script) =>
      script.scriptId.startsWith(`${String(child?.proc.pid)}:`),
    )
    assert.ok(fromChild, 'the window must carry the dead child\'s coverage')
    assert.ok(
      names.has('persistKey'),
      `the dead child's work must be recorded: ${[...names].join(', ') || '(nothing)'}`,
    )
  } finally {
    source?.close()
    lane?.stop()
    child?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// A snapshot that parses as JSON but is not a snapshot (`null`) used to throw out of
// the harvest, and on the background path that was an unhandled rejection.
test('a snapshot file of the wrong shape is skipped, not thrown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
  let lane: RunningService | null = null
  let source: QueuedSource | null = null
  const rejections: unknown[] = []
  const onRejection = (error: unknown): void => {
    rejections.push(error)
  }
  process.on('unhandledRejection', onRejection)
  try {
    lane = await started(dir)
    source = await rescanningSocketSource({ dir, timeoutMs: 5_000, discoveryIntervalMs: 20 })
    writeFileSync(join(dir, 'pid-999999.coverage.json'), 'null')
    await sleep(150)
    await source.take()
    await sleep(50)
    assert.deepEqual(rejections.map(String), [])
  } finally {
    process.off('unhandledRejection', onRejection)
    source?.close()
    lane?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// A process whose first look finds no exit write yet is alive. It must be looked at
// again once it has exited, or its whole lifetime is lost.
test('a live process whose snapshot has no exit yet is harvested after it exits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
  let lane: RunningService | null = null
  let child: RunningService | null = null
  let source: QueuedSource | null = null
  try {
    lane = await started(dir)
    source = await rescanningSocketSource({ dir, timeoutMs: 300, discoveryIntervalMs: 60_000 })
    child = launchService({ CBD_SOCKET_DIR: dir })
    await child.ready
    await waitForSocket(child.socketPath)
    child.run('store')
    await until(child, 'stored:')
    await sleep(900) // the periodic snapshot (no exit write) now exists
    const pid = child.proc.pid as number
    process.kill(pid, 'SIGSTOP') // alive but unresponsive, so it cannot be attached
    await source.take()
    process.kill(pid, 'SIGCONT')
    const proc = child.proc
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    child.run('quit')
    await exited

    let seen = false
    for (let i = 0; i < 3; i += 1) {
      const payload = await source.take()
      if (
        payload.some(
          (script) =>
            script.scriptId.startsWith(`${String(pid)}:`) &&
            script.functions.some(
              (fn) => fn.functionName === 'persistKey' && (fn.ranges[0]?.count ?? 0) > 0,
            ),
        )
      ) {
        seen = true
      }
    }
    assert.ok(seen, 'the child exited after the first look and its lifetime was never read')
  } finally {
    source?.close()
    lane?.stop()
    child?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// The socket path and the snapshot path both lead to the same exit write. Delivering
// it through both credits one lifetime twice.
test('an exit snapshot reached by both paths is delivered once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
  let lane: RunningService | null = null
  let child: RunningService | null = null
  let source: QueuedSource | null = null
  try {
    lane = await started(dir)
    source = await rescanningSocketSource({ dir, timeoutMs: 5_000, discoveryIntervalMs: 60_000 })
    child = launchService({ CBD_SOCKET_DIR: dir })
    await child.ready
    await waitForSocket(child.socketPath)
    child.run('store')
    await until(child, 'stored:')
    const pid = child.proc.pid as number
    const proc = child.proc
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    child.run('quit')
    await exited
    // A stale socket file: the socket path's connect fails and falls back to the harvest.
    writeFileSync(join(dir, `pid-${String(pid)}.sock`), '')

    const payload = await source.take()
    const ids = payload
      .map((script) => script.scriptId)
      .filter((id) => id.startsWith(`${String(pid)}:`))
    assert.ok(ids.length > 0, 'the child was not harvested at all')
    assert.equal(new Set(ids).size, ids.length, 'one lifetime was delivered twice')
  } finally {
    source?.close()
    lane?.stop()
    child?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a harvested child\'s script rows stay visible in scripts() after delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
  let lane: RunningService | null = null
  let child: RunningService | null = null
  let source: QueuedSource | null = null
  try {
    lane = await started(dir)
    source = await rescanningSocketSource({ dir, timeoutMs: 5_000, discoveryIntervalMs: 60_000 })
    child = launchService({ CBD_SOCKET_DIR: dir })
    await child.ready
    await waitForSocket(child.socketPath)
    child.run('store')
    await until(child, 'stored:')
    const pid = String(child.proc.pid)
    const proc = child.proc
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    child.run('quit')
    await exited

    const payload = await source.take()
    assert.ok(payload.some((script) => script.scriptId.startsWith(`${pid}:`)))
    assert.ok(
      [...source.scripts().keys()].some((key) => key.startsWith(`${pid}:`)),
      'the harvested rows were dropped at delivery, so the build cannot resolve its scripts',
    )
  } finally {
    source?.close()
    lane?.stop()
    child?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// Windows reuses pids. A file judged unharvestable for one process must not shadow
// the next process that gets the same pid.
test('a reused pid with a new snapshot is a new process to harvest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
  let lane: RunningService | null = null
  let source: QueuedSource | null = null
  try {
    lane = await started(dir)
    source = await rescanningSocketSource({ dir, timeoutMs: 5_000, discoveryIntervalMs: 60_000 })
    const path = join(dir, 'pid-777777.coverage.json')
    const snapshot = (extra: object): string =>
      JSON.stringify({
        protocol: INSTRUMENT_PROTOCOL,
        pid: 777777,
        startedAtUs: 1e15,
        atUs: 1e15,
        scripts: [],
        windows: [],
        ...extra,
      })
    // Another collector's file: has a session, so never this run's evidence.
    writeFileSync(path, snapshot({ session: 'old' }))
    await source.take()
    await sleep(30)
    writeFileSync(
      path,
      snapshot({
        startedAtUs: 2e15,
        endedAtUs: 2e15,
        untaken: [{ scriptId: '1', url: 'file:///x.js', functions: [] }],
      }),
    )
    const payload = await source.take()
    assert.ok(
      payload.some((script) => script.scriptId === '777777:1'),
      'the reused pid\'s lifetime was shadowed by the earlier verdict',
    )
  } finally {
    source?.close()
    lane?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file a harvested child read is delivered with its lifetime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
  let lane: RunningService | null = null
  let child: RunningService | null = null
  let source: QueuedSource | null = null
  try {
    const route = join(dir, 'routing.json')
    writeFileSync(route, '{}\n')
    lane = await started(dir)
    source = await rescanningSocketSource({ dir, timeoutMs: 5_000, discoveryIntervalMs: 60_000 })
    child = launchService({ CBD_SOCKET_DIR: dir })
    await child.ready
    await waitForSocket(child.socketPath)
    child.run('store')
    await until(child, 'stored:')
    child.run(`read ${route}`)
    await until(child, 'read ')
    const proc = child.proc
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    child.run('quit')
    await exited

    const pending = source.dispatch()
    await pending.settle()
    const capture = await pending.settleTagged?.()
    assert.ok(
      capture?.reads?.includes(realpathSync(route)),
      `the harvested child's read was lost: ${JSON.stringify(capture?.reads)}`,
    )
  } finally {
    source?.close()
    lane?.stop()
    child?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// A service reads data the map cannot name — a routing table, a config keyed by
// line. Its change has to select the test that drove the service, which means the
// read has to reach the shard from the far side of the socket.
test('a file the service reads is recorded against the test that drove it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-reads-'))
  let service: RunningService | null = null
  let source: QueuedSource | null = null
  try {
    const route = join(dir, 'routing.json')
    writeFileSync(route, '{"path":"/health"}\n')
    service = await started(dir)

    const shard = join(dir, 'service.ndjson')
    source = await rescanningSocketSource({ dir, timeoutMs: 5_000 })
    const recorder = new Recorder({
      source,
      sink: new FileSink(shard),
      commit: 'reads-e2e',
      pid: source.pid,
      role: 'service',
      scan: { prefilter: (url: string) => url.includes('/tests/service/') },
    })
    recorder.runStart()
    recorder.testStart('reads a route', 'spec.ts')
    service.run(`read ${route}`)
    await until(service, 'read ')
    recorder.testEnd('reads a route', 'passed', 0)
    recorder.runEnd()
    await recorder.drained()
    recorder.close()
    source = null

    const record = parseShard(readFileSync(shard, 'utf8'), shard).find(
      (value) => value.type === 'test' && value.title === 'reads a route',
    )
    assert.ok(record?.type === 'test')
    assert.deepEqual(record.reads, [realpathSync(route)])
  } finally {
    source?.close()
    service?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

const exitSnapshot = (pid: number): string =>
  JSON.stringify({
    protocol: INSTRUMENT_PROTOCOL,
    pid,
    startedAtUs: 1e15,
    atUs: 1e15,
    endedAtUs: 1e15,
    scripts: [],
    windows: [],
    untaken: [{ scriptId: '1', url: 'file:///x.js', functions: [] }],
  })

// A write is atomic (temporary file, then rename), so a file that does not parse is
// not half written: waiting on the same bytes will not change the verdict.
test('an unparseable snapshot is not read again until its mtime changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
  let lane: RunningService | null = null
  let source: QueuedSource | null = null
  try {
    lane = await started(dir)
    source = await rescanningSocketSource({ dir, timeoutMs: 5_000, discoveryIntervalMs: 20 })
    const path = join(dir, 'pid-777782.coverage.json')
    // Both writes carry one whole-second mtime: copying a stat's fractional mtime
    // back through utimes is not exact on every Node, and a drift reads as a change.
    const pinned = Math.floor(Date.now() / 1000) + 1
    writeFileSync(path, '{not json')
    utimesSync(path, pinned, pinned)
    await sleep(200)
    writeFileSync(path, exitSnapshot(777782))
    utimesSync(path, pinned, pinned)
    await sleep(200)

    const payload = await source.take()
    assert.ok(
      !payload.some((script) => script.scriptId === '777782:1'),
      'a file judged unparseable was read again at the same mtime',
    )
  } finally {
    source?.close()
    lane?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// `startedAtUs` is a monotonic clock whose origin resets at boot, so a file from
// before a reboot can carry a larger value than a process born now. The file's own
// mtime is on the wall clock and says it was written before this run began.
test('a snapshot last written before the recording began is not credited to it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-rescan-'))
  let lane: RunningService | null = null
  let source: QueuedSource | null = null
  try {
    lane = await started(dir)
    source = await rescanningSocketSource({ dir, timeoutMs: 5_000, discoveryIntervalMs: 20 })
    const path = join(dir, 'pid-777783.coverage.json')
    writeFileSync(path, exitSnapshot(777783))
    const longAgo = new Date('2020-01-01T00:00:00Z')
    utimesSync(path, longAgo, longAgo)
    await sleep(200)

    const payload = await source.take()
    assert.ok(
      !payload.some((script) => script.scriptId === '777783:1'),
      'a snapshot from before the recording was credited to it',
    )
  } finally {
    source?.close()
    lane?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
