/**
 * `cbd-a3v.2`: `socketSource`, the `Source` that reads another process.
 *
 * The contract suite runs first and unchanged. That is the point of `cbd-3td`:
 * `source-contract.ts` was written when the only implementation was in-process,
 * with the claim that an out-of-process one must satisfy the same suite or the
 * seam was not a seam. This is where that claim is either true or not.
 *
 * The rest tests what the contract deliberately leaves out, because it is
 * source-specific: discovery, the window rule, and the fact that closing the
 * client must not close the service.
 *
 * Every test tears its service down. A service left running holds this process's
 * stdio pipes open, so japa finishes the suite and the process then never exits —
 * which presents as a silent hang, with the report buffered and unreadable.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { SocketSourceError, discoverSockets, socketSource } from '../src/index.js'
import type { QueuedSource, V8ScriptCoverage } from '../src/types.js'
import { sourceContract } from './support/source-contract.js'
import {
  launchService,
  waitForSocket,
  withService,
  withSource,
  type RunningService,
} from './support/service.js'

/**
 * A source whose lifetime includes the service behind it.
 *
 * The contract suite builds a fresh source per test and closes it in a `finally`,
 * so the service has to go down with the source or the suite leaks a process per
 * test. `Source` is an object of closures — none of them uses `this` — so wrapping
 * `close` is a spread rather than a subclass.
 */
async function oneShotSource(): Promise<QueuedSource> {
  const running = launchService()
  await running.ready
  await waitForSocket(running.socketPath)
  const source = await socketSource({ dir: running.dir, timeoutMs: 5_000 })
  const close = source.close.bind(source)
  return {
    ...source,
    close: () => {
      close()
      running.stop()
      rmSync(running.dir, { recursive: true, force: true })
    },
  }
}

sourceContract('socketSource', oneShotSource, { supportsSync: false })

/** The function names a take named, for asserting on what a process actually ran. */
async function namesFrom(taking: Promise<V8ScriptCoverage[]>): Promise<Set<string>> {
  const names = new Set<string>()
  for (const script of await taking) {
    for (const fn of script.functions) if (fn.functionName !== '') names.add(fn.functionName)
  }
  return names
}

/** The same, for a payload already in hand. */
function namesOf(payload: V8ScriptCoverage[]): Set<string> {
  const names = new Set<string>()
  for (const script of payload) {
    for (const fn of script.functions) if (fn.functionName !== '') names.add(fn.functionName)
  }
  return names
}

/** Long enough for the service's stdin handler to have run and V8 to have counted it. */
function settle(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test.group('socketSource multi-process', (group) => {
  group.each.timeout(30_000)

  /**
   * The half of the acceptance that is this task's: each process's execution is
   * attributed to the process it happened in.
   *
   * Note what makes this a real test. Both services run the same file, so their
   * function names are identical and a name appearing proves nothing on its own.
   * The test drives only the FIRST one, so `reverseKey` appearing in the second
   * process's window would mean the two sockets are talking to one isolate — which
   * is exactly the failure that would silently merge two processes into one heap
   * and make every window wrong.
   */
  test('a take reports its own process and not the other', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-attrib-'))
    const first = launchService({ CBD_SOCKET_DIR: dir })
    const second = launchService({ CBD_SOCKET_DIR: dir })
    try {
      await first.ready
      await second.ready
      await waitForSocket(first.socketPath)
      await waitForSocket(second.socketPath)

      const a = await socketSource({ dir, pid: first.proc.pid, timeoutMs: 5_000 })
      const b = await socketSource({ dir, pid: second.proc.pid, timeoutMs: 5_000 })
      try {
        // Discard both startup windows before driving anything.
        await a.take()
        await b.take()

        first.run('run')
        await new Promise((resolve) => setTimeout(resolve, 250))

        const ranA = await namesFrom(a.take())
        const ranB = await namesFrom(b.take())

        assert.ok(ranA.has('reverseKey'), `expected reverseKey in the driving process: ${[...ranA].join(', ')}`)
        assert.equal(
          ranB.has('reverseKey'),
          false,
          'the process that was not driven must not report the other one\'s work',
        )
        assert.equal(ranA.has('neverCalled'), false)
        assert.equal(ranB.has('neverCalled'), false)
      } finally {
        a.close()
        b.close()
      }
    } finally {
      first.stop()
      second.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test.group('socketSource discovery', (group) => {
  // Starting a service is a process spawn plus an inspector handshake, which does
  // not fit japa's default budget. The two-service test needs two of them.
  group.each.timeout(30_000)

  test('refuses a directory with no instrumented service, and says what to check', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'cbd-empty-'))
    try {
      await assert.rejects(socketSource({ dir: empty }), /no instrumented service answered/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  // The failure this guards: driving the first target and ignoring the rest would
  // produce a map that attributed one process's execution and dropped the other's,
  // arriving as a confident answer rather than an error.
  test('refuses a directory holding more than one service, and names them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-many-'))
    const first = launchService({ CBD_SOCKET_DIR: dir })
    const second = launchService({ CBD_SOCKET_DIR: dir })
    try {
      await first.ready
      await second.ready
      await waitForSocket(first.socketPath)
      await waitForSocket(second.socketPath)

      await assert.rejects(socketSource({ dir }), /2 instrumented services answered/)
    } finally {
      first.stop()
      second.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * A role is inherited, so it cannot be a filter.
   *
   * `CBD_ROLE` reaches a service exactly the way `NODE_OPTIONS` does, so the test
   * process's own role arrives on the environment of every service it starts. A
   * filter on it therefore does not separate a service from its client — it hides
   * the service, and silently, because discovery goes on succeeding. The pid is
   * what keeps the collector's own socket out, and it is the only rule (ADR-0007).
   */
  test('reads a service that inherited a role other than "service"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-role-'))
    const service = launchService({ CBD_SOCKET_DIR: dir, CBD_ROLE: 'runner' })
    try {
      await service.ready
      await waitForSocket(service.socketPath)

      const targets = await discoverSockets(dir, 5_000)
      assert.equal(targets.length, 1, 'the role was treated as a permission again')
      assert.equal(targets[0]?.role, 'runner', 'the role is carried through as what it is')

      // The whole path rather than the scan alone: a target the collector finds and
      // then refuses to open would be the same defect one layer down.
      const source = await socketSource({ dir, timeoutMs: 5_000 })
      assert.equal(source.pid, service.proc.pid)
      await source.close()
    } finally {
      service.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('naming the target two ways at once is refused', async () => {
    await assert.rejects(
      socketSource({ socket: '/tmp/nope.sock', dir: '/tmp' } as never),
      /names the target two ways/,
    )
  })

  test('refuses with no directory anywhere, rather than guessing one', async () => {
    const previous = process.env.CBD_SOCKET_DIR
    delete process.env.CBD_SOCKET_DIR
    try {
      await assert.rejects(socketSource(), /no socket directory/)
    } finally {
      if (previous !== undefined) process.env.CBD_SOCKET_DIR = previous
    }
  })
})

test.group('socketSource windows', () => {
  test('takeSync refuses, and says why', async () => {
    await withSource({}, async (source) => {
      assert.throws(() => source.takeSync(), /sync/i)
      assert.throws(() => source.takeSync(), SocketSourceError)
    })
  })

  // Dispatch time is the boundary, so a second take issued before the first has
  // settled means the caller has lost track of its windows. Attributing the late
  // reply to whichever window is open when it lands is silent misattribution.
  test('a second take while one is in flight is refused, not queued', async () => {
    await withSource({}, async (source) => {
      const first = source.take()
      const second = source.take()
      await assert.rejects(second, /already outstanding/)
      await first
      // And the source still works once the window has closed.
      assert.ok(Array.isArray(await source.take()))
    })
  })

  test('a take is a delta, and never names code that did not run', async () => {
    await withSource({}, async (source, running) => {
      // Discard whatever the service did before now.
      await source.take()

      running.run('run')
      await new Promise((resolve) => setTimeout(resolve, 250))

      const names = new Set<string>()
      for (const script of await source.take()) {
        for (const fn of script.functions) if (fn.functionName !== '') names.add(fn.functionName)
      }

      assert.ok(names.has('reverseKey'), `expected reverseKey in ${[...names].join(', ')}`)
      assert.ok(names.has('validateSignature'), 'expected validateSignature')
      // `neverCalled` is called by nothing. If it appears, the take is a running
      // total rather than a window.
      assert.equal(names.has('neverCalled'), false, 'neverCalled must not be in any window')
    })
  })
})

test.group('socketSource scripts', () => {
  test('carries sourceMapURL, which is what makes a compiled service resolvable', async () => {
    await withSource({}, async (source) => {
      await source.take()
      const rows = [...source.scripts().values()]
      const own = rows.find((row) => row.url.endsWith('/tests/service/main.js'))
      assert.ok(own !== undefined, "the service's own file should be in the script table")
      assert.equal(own.sourceMapURL, 'main.js.map')
    })
  })

  test('accumulates across takes, because each row is sent only once', async () => {
    await withSource({}, async (source) => {
      await source.take()
      const afterFirst = source.scripts().size
      await source.take()
      assert.ok(source.scripts().size >= afterFirst, 'the table must not shrink between takes')
    })
  })
})

test.group('socketSource close', (group) => {
  group.each.timeout(30_000)

  // The service outlives the run that reads it — dev-cli starts the server and the
  // suite comes and goes. Telling it to stop coverage here would leave the next run
  // with a dead target and nothing to say why.
  test('closing the source leaves the service serving', async () => {
    const running: RunningService = launchService()
    try {
      await running.ready
      await waitForSocket(running.socketPath)
      const source = await socketSource({ dir: running.dir, timeoutMs: 5_000 })
      source.close()
      source.close()

      const before = running.output()
      running.run('idle')
      await new Promise((resolve) => setTimeout(resolve, 250))
      assert.notEqual(running.output(), before, 'the service should still be handling stdin')
      assert.equal(running.proc.exitCode, null, 'the service must not have exited')
    } finally {
      running.stop()
      rmSync(running.dir, { recursive: true, force: true })
    }
  })

  test('a take after close fails rather than hanging', async () => {
    await withService({}, async (running) => {
      await waitForSocket(running.socketPath)
      const source = await socketSource({ dir: running.dir, timeoutMs: 5_000 })
      source.close()
      await assert.rejects(source.take(), /closed/)
    })
  })
})

test.group('socketSource dispatch', (group) => {
  group.each.timeout(30_000)

  /**
   * The property the whole deferred design rests on, asserted rather than argued.
   *
   * Three boundaries are sent with no wait between them, so at the moment the last
   * one is written there are two replies still owed. If the peer replayed counts
   * instead of resetting on read, or if one window swallowed its neighbour, the
   * phases below would smear into each other — and the failure would look like a
   * test being blamed for a function it never reached, which is over-attribution
   * and invisible in a green run.
   *
   * The two phases call *different* functions on purpose. `run` reaches
   * `reverseKey` and `store` reaches `persistKey`, so "this window contains the
   * work of this phase" is decidable. Both also reach `normalizeKey`, so asserting
   * on any name at all would prove nothing.
   */
  test('boundaries sent without waiting partition the execution between them', async () => {
    await withSource({}, async (source, running) => {
      // Discard startup, so the first boundary below delimits something.
      await source.take()

      running.run('run')
      await settle()
      const first = source.dispatch()

      running.run('store')
      await settle()
      const second = source.dispatch()

      running.run('idle')
      await settle()
      const third = source.dispatch()

      const a = namesOf(await first.settle())
      const b = namesOf(await second.settle())
      const c = namesOf(await third.settle())

      assert.ok(a.has('reverseKey'), `the first window should hold the first phase: ${[...a].join(', ')}`)
      assert.equal(a.has('persistKey'), false, 'the first window must not hold the second phase')
      assert.ok(b.has('persistKey'), `the second window should hold the second phase: ${[...b].join(', ')}`)
      assert.equal(b.has('reverseKey'), false, 'the second window must not hold the first phase')
      // `idle` calls nothing of ours, so the third window has neither phase in it.
      // It is not empty — writing to stdout runs V8's own machinery — which is why
      // this asks about the fixture's functions rather than about emptiness.
      assert.equal(c.has('persistKey'), false, 'the third window must not hold the second phase')
      assert.equal(c.has('reverseKey'), false, 'the third window must not hold the first phase')

      // And the handles carry the order they were sent in, which is what a caller
      // needs to line windows up with boundaries it did not wait for. Asserted as
      // consecutive rather than as 0, 1, 2: the startup take above consumed a
      // number, and pinning the base would make this test about how many windows
      // it happens to open rather than about their order.
      assert.deepEqual(
        [second.seq - first.seq, third.seq - second.seq],
        [1, 1],
        'handles must be numbered consecutively in dispatch order',
      )
    })
  })

  /**
   * The cross-API hazard, and the reason `take()`'s guard counts dispatches too.
   *
   * `take()` cannot say which window a reply belongs to, so if it were allowed to
   * open a second window alongside a dispatched one, the dispatched window's delta
   * would cover work the `take()` caller believes is its own. Refusing is the only
   * answer that does not invent an attribution.
   */
  test('take is refused while a dispatched window is outstanding', async () => {
    await withSource({}, async (source) => {
      const pending = source.dispatch()
      await assert.rejects(source.take(), /already outstanding/)
      await pending.settle()
      assert.ok(Array.isArray(await source.take()))
    })
  })

  /**
   * The measurement has to be believable before it can be reported, so this checks
   * the clocks rather than the size.
   *
   * `nowUs()` is `CLOCK_MONOTONIC` on both sides, which the kernel reads once per
   * machine — so two processes on one host subtract meaningfully. If that were not
   * true, the difference would be the host's uptime in microseconds, on the order
   * of 10^12, rather than a socket hop. The bound is therefore loose on purpose:
   * it is separating seven orders of magnitude, not measuring a hop precisely.
   */
  test('reports the boundary drift, and the two clocks share an origin', async () => {
    await withSource({}, async (source) => {
      await source.take()
      await source.dispatch().settle()

      const drift = source.drift()
      assert.equal(drift.windows, 2)
      assert.equal(drift.maxDepth, 1, 'each boundary was answered before the next was written')
      assert.ok(drift.meanUs >= 0, `drift cannot be negative, saw ${String(drift.meanUs)}`)
      assert.ok(
        drift.maxUs < 50_000,
        `a drift of ${String(drift.maxUs)}µs is not a socket hop — the two processes are not ` +
          'reading comparable clocks, so the measurement means nothing',
      )
    })
  })

  /**
   * The drift is not a constant of the socket. It is a function of how many
   * boundaries are queued ahead of this one, and this pins that, because the whole
   * deferred-recording design depends on knowing it.
   *
   * The peer serves takes one at a time and a window begins when its boundary is
   * *received*, so a boundary written while an earlier one is still being served
   * waits behind it and slides. The two halves below differ in exactly one thing —
   * whether the client waited — and the gap between them is the finding: on this
   * host a drained queue lands in tens of microseconds, and a hundred-deep queue in
   * milliseconds.
   *
   * This is a characterisation test, not a target. It records where the design
   * stops working: a suite whose tests are faster than a take round trip would put
   * every boundary in the second regime, and the run has to say so rather than emit
   * an ordinary-looking map.
   */
  test('drift comes from queue depth, and the depth is reported', async () => {
    await withSource({}, async (source) => {
      // Spaced: every boundary is answered before the next is written.
      for (let i = 0; i < 5; i++) await source.dispatch().settle()
      const spaced = source.drift()
      assert.equal(spaced.maxDepth, 1)

      // Tight: written with nothing awaited between them, so no reply can be
      // processed until the loop finishes and the peer is a hundred deep.
      const pending = []
      for (let i = 0; i < 100; i++) pending.push(source.dispatch())
      assert.equal(source.drift().maxDepth, 100, 'the depth must be counted as it is reached')
      await Promise.all(pending.map((handle) => handle.settle()))

      const tight = source.drift()
      // And the denominator, from the same dispatch. A drift means nothing on its
      // own: 300µs is exact or worthless depending on whether the boundaries around
      // it were milliseconds or microseconds apart, and only the run knows which.
      assert.ok(
        tight.minGapUs < spaced.minGapUs,
        `back-to-back boundaries must sit closer together than awaited ones: tight ` +
          `${String(tight.minGapUs)}µs, spaced ${String(spaced.minGapUs)}µs`,
      )
      assert.ok(
        tight.meanUs - spaced.meanUs > 1_000,
        'a hundred-deep queue must drift far more than a drained one, or the depth is not the ' +
          `mechanism: spaced mean ${spaced.meanUs.toFixed(1)}µs, tight mean ${tight.meanUs.toFixed(1)}µs`,
      )
    })
  })

  test('dispatch after close throws rather than queueing into nothing', async () => {
    await withSource({}, async (source) => {
      source.close()
      assert.throws(() => source.dispatch(), /closed/)
    })
  })
})
