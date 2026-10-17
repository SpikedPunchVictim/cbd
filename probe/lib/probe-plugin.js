/**
 * Stage A0 probe — the japa plugin CBD's adapter would be built on.
 *
 * Verified so far by reading @japa/core's shipped JS (build/index.js:472, 486,
 * 542, 563): japa calls `emitter.emit('test:end', …)` WITHOUT awaiting it. The
 * call returns a Promise because Emittery is async, but nothing waits on it.
 * Therefore an *async* handler on test:end runs detached, while the next test
 * has already begun — the coverage window would be misaligned.
 *
 * That makes the synchronous `post` from spike S1b load-bearing rather than
 * merely convenient. This probe re-runs the windows with a `takeSync()` and
 * checks the deltas come out aligned.
 */
import inspector from 'node:inspector'
import { getActiveTest } from '@japa/runner'

/** A late async listener, kept deliberately: it demonstrates the detachment. */
const ASYNC_DELAY_MS = 30

const state = {
  log: [],
  seq: 0,
  perTest: new Map(),
  betweenHits: new Set(),
  takeSyncWorked: null,
  lateArrivals: 0,
  runnerEndAwaited: null,
}

function record(label, detail = '') {
  state.log.push({ seq: state.seq++, label, detail })
}

export function cbdProbe() {
  return async function probe({ runner, emitter }) {
    const session = new inspector.Session()
    session.connect()
    const scripts = new Map()
    session.on('Debugger.scriptParsed', (e) => {
      scripts.set(e.params.scriptId, e.params.url)
    })

    const post = (method, params = {}) =>
      new Promise((resolve, reject) =>
        session.post(method, params, (err, res) => (err ? reject(err) : resolve(res))))

    await post('Profiler.enable')
    await post('Debugger.enable')
    await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })

    /**
     * The whole point. S1b claims the in-process inspector's callback fires
     * before `post()` returns. If that holds, a fully synchronous take is
     * possible and japa's non-awaited emit stops mattering.
     */
    const takeSync = () => {
      let done = false
      let payload = null
      let failure = null
      session.post('Profiler.takePreciseCoverage', {}, (err, res) => {
        done = true
        if (err) failure = err
        else payload = res.result
      })
      if (!done) throw new Error('takeSync: post did not resolve synchronously')
      if (failure) throw failure
      return payload
    }

    const hitsFrom = (payload) => {
      const hit = new Set()
      for (const script of payload) {
        const url = scripts.get(script.scriptId) ?? ''
        if (!url.includes('under-test')) continue
        for (const fn of script.functions) {
          if (fn.ranges.some((r) => r.count > 0)) hit.add(fn.functionName || '<anon>')
        }
      }
      return hit
    }

    // ---- the synchronous handlers ----------------------------------------
    // take() RESETS (spike S1a): the start take discards the pre-test window
    // (that becomes @between); the end take is exactly the test's window.
    emitter.on('test:start', (node) => {
      const title = node.title.expanded
      record('test:start', title)
      try {
        state.betweenHits = hitsFrom(takeSync())
        if (state.takeSyncWorked === null) state.takeSyncWorked = true
      } catch {
        state.takeSyncWorked = false
      }
      // Q5: can a hook identify the running test without the event payload?
      state.perTest.set(title, {
        activeVisibleInHook: getActiveTest()?.title?.original ?? null,
      })
    })

    emitter.on('test:end', (node) => {
      const title = node.title.expanded
      record('test:end:enter', title)
      const entry = state.perTest.get(title) ?? {}
      try {
        entry.hits = [...hitsFrom(takeSync())].sort()
        if (state.takeSyncWorked === null) state.takeSyncWorked = true
      } catch {
        state.takeSyncWorked = false
        entry.hits = null
      }
      entry.hasError = node.hasError
      state.perTest.set(title, entry)
      record('test:end:exit', `${title} [${(entry.hits ?? []).join(',')}]`)
    })

    // ---- the experiment: a listener that yields ---------------------------
    // Lands *after* the next test:start, proving emit is not awaited.
    emitter.on('test:end', async (node) => {
      const title = node.title.expanded
      await new Promise((r) => setTimeout(r, ASYNC_DELAY_MS))
      const lastStart = [...state.log].reverse().find((e) => e.label === 'test:start')
      state.lateArrivals++
      record('test:end:ASYNC-late', `${title} (last test:start was "${lastStart?.detail ?? '-'}")`)
    })

    for (const [name, pick] of [
      ['runner:start', () => ''],
      ['suite:start', (n) => n.name],
      ['group:start', (n) => n.title],
      ['group:end', (n) => n.title],
      ['suite:end', (n) => n.name],
    ]) {
      emitter.on(name, (node) => record(name, pick(node ?? {})))
    }

    // ---- the experiment a deferred window depends on ----------------------
    //
    // An out-of-process window cannot be written when its boundary is crossed,
    // because the reply has not come back yet: it has to be drained somewhere
    // japa actually waits. `runner:end` is the candidate — but "japa awaits
    // runner.end()" and "japa awaits a promise *returned by* a runner:end
    // listener" are different claims, and the first does not imply the second.
    // Emittery does await listener return values, so this should hold; that is
    // exactly why it is worth a measurement rather than a reading.
    //
    // Read in bin/test.js the instant `run()` resolves. Reading it later would
    // not distinguish "japa waited" from "it landed on its own while something
    // else slept", which is the whole question.
    emitter.on('runner:end', async () => {
      await new Promise((r) => setTimeout(r, ASYNC_DELAY_MS))
      state.runnerEndAwaited = true
      record('runner:end:ASYNC', 'settled')
    })

    runner.onSuite((suite) => {
      record('runner.onSuite', suite.name)
      suite.onTest((t) => record('suite.onTest', t.title))
      suite.onGroup((g) => {
        record('suite.onGroup', g.title)
        g.tap((t) => record('group.tap', t.title))
      })
    })

    // exposed for the report, which runs after `await run()` returns
    state.session = session
  }
}

/**
 * Whether the async `runner:end` listener had already settled when `run()`
 * resolved. Must be called immediately after `await run()`, before anything
 * yields — see the comment on the listener.
 */
export function runnerEndSettledBeforeReport() {
  return state.runnerEndAwaited === true
}

export async function probeReport(runnerEndAwaitedAtRunEnd) {  // Let the deliberately-async listeners land, so the log shows where they
  // actually fell rather than reporting a count of zero because we raced them.
  await new Promise((r) => setTimeout(r, ASYNC_DELAY_MS * 4))

  const { log, perTest, betweenHits } = state

  console.log('\n========== hook order ==========')
  for (const e of log) {
    console.log(`  ${String(e.seq).padStart(3, '0')}  ${e.label.padEnd(20)} ${e.detail}`)
  }

  const idx = (label, detail) => log.findIndex((e) => e.label === label && (!detail || e.detail === detail))
  let interleaved = false
  for (const e of log) {
    if (e.label === 'test:start') {
      const prevEnd = [...log].slice(0, e.seq).reverse().find((x) => x.label.startsWith('test:end'))
      if (prevEnd && prevEnd.label !== 'test:end:exit') interleaved = true
    }
  }

  console.log('\n========== verdicts ==========')
  console.log(`  sync take from a hook ............ ${state.takeSyncWorked ? 'YES — takeSync() returned inline' : 'NO — post() deferred'}`)
  console.log(`  sync handlers stay in order ...... ${interleaved ? 'NO — a window boundary was crossed' : 'YES — each test:end:exit precedes the next test:start'}`)
  const lateSeqs = log.filter((e) => e.label === 'test:end:ASYNC-late').map((e) => e.seq)
  const lastSyncSeq = Math.max(...log.filter((e) => e.label !== 'test:end:ASYNC-late').map((e) => e.seq))
  console.log(`  async handlers landed late ....... ${state.lateArrivals} of ${perTest.size}, at seq [${lateSeqs.join(',')}] — after seq ${lastSyncSeq}`)
  console.log(`  getActiveTest() usable in a hook . ${[...perTest.values()].some((v) => v.activeVisibleInHook) ? 'YES' : 'NO — undefined'}`)
  console.log(
    `  runner:end awaits an async listener . ${
      runnerEndAwaitedAtRunEnd === true
        ? 'YES — already settled when run() resolved'
        : 'NO — run() resolved first; a deferred drain cannot live there'
    }`,
  )

  console.log('\n========== per-test deltas (sync windows) ==========')
  for (const [title, v] of perTest) {
    console.log(`  ${title.padEnd(24)} hits=[${(v.hits ?? []).join(',')}]${v.hasError ? '  HAS ERROR' : ''}`)
  }
  console.log(`  @between (pre-test window) ....... [${[...betweenHits].sort().join(',')}]`)

  const reached = new Set([...perTest.values()].flatMap((v) => v.hits ?? []))
  console.log(`  inverse map: 'unused' ............ ${reached.has('unused') ? 'REACHED — deltas are wrong' : 'never reached — correct'}`)
  state.session?.disconnect()
}
