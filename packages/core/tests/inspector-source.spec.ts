/**
 * `inspectorSource`: coverage of a process we cannot inject into.
 *
 * The shared contract runs first, against a real `--inspect` target. Everything
 * after it is specific to attaching rather than injecting: the delta property, the
 * script table, generated text, and the one-runner lock.
 *
 * Every test starts its own fixture process. A service left running holds this
 * process's stdio pipes open, so the suite finishes and then never exits — a hang
 * with the report buffered and unreadable.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from '@japa/runner'
import { resolveInspectorTarget, inspectorSource, inspectorLockPath } from '../src/source/inspector.js'
import { Recorder } from '../src/recorder.js'
import { FileSink, parseShard, type ShardTest } from '../src/shard.js'
import type { QueuedSource, Source, V8ScriptCoverage } from '../src/types.js'
import { sourceContract } from './support/source-contract.js'
import { launchInspectorService, type RunningInspectorService } from './support/service.js'

async function attach(service: RunningInspectorService): Promise<QueuedSource> {
  await service.ready
  return inspectorSource({ url: await service.url, timeoutMs: 5_000 })
}

/** One service and one source, both torn down. */
async function withInspector(
  body: (source: QueuedSource, service: RunningInspectorService) => Promise<void>,
): Promise<void> {
  const service = launchInspectorService()
  let source: QueuedSource | null = null
  try {
    source = await attach(service)
    await body(source, service)
  } finally {
    source?.close()
    service.stop()
  }
}

/** The function names a payload says actually ran in the window. */
function namesOf(payload: V8ScriptCoverage[]): Set<string> {
  const names = new Set<string>()
  for (const script of payload) {
    for (const fn of script.functions) {
      const count = fn.ranges[0]?.count ?? 0
      if (fn.functionName !== '' && count > 0) names.add(fn.functionName)
    }
  }
  return names
}

/** Long enough for the fixture's stdin handler to run and V8 to have counted it. */
function settle(ms = 300): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A source whose lifetime includes the target behind it, as the contract suite
 * expects: a fresh source per test, closed in a `finally`.
 */
async function oneShotSource(): Promise<Source> {
  const service = launchInspectorService()
  const source = await attach(service)
  const close = source.close.bind(source)
  return {
    ...source,
    close: () => {
      close()
      service.stop()
    },
  }
}

sourceContract('inspectorSource', oneShotSource, { supportsSync: false })

test.group('inspectorSource', (group) => {
  group.each.timeout(30_000)

  // The property the injected source was measured on: a take returns what ran since
  // the previous take, not a running total.
  test('a take is a delta, and names the functions the service ran', async () => {
    await withInspector(async (source, service) => {
      // Drain start-up, so the window below is about the work after it.
      await source.take()

      service.run('run')
      await settle()

      const names = namesOf(await source.take())
      assert.ok(names.has('reverseKey'), `expected reverseKey in ${[...names].join(', ')}`)
      assert.ok(names.has('validateSignature'), 'expected validateSignature')
      assert.equal(names.has('persistKey'), false, 'store was never run in this window')
      assert.equal(names.has('neverCalled'), false, 'neverCalled must not be in any window')

      const after = namesOf(await source.take())
      assert.deepEqual(after, new Set(), 'an idle window must name nothing')
    })
  })

  // `Debugger.scriptParsed` is the only thing that maps an offset back to a file
  // and its source map; a source that never fills `scripts()` cannot build a map.
  test('carries the script table, including the source map URL', async () => {
    await withInspector(async (source) => {
      await source.take()
      const rows = [...source.scripts().values()]
      const own = rows.find((row) => row.url.endsWith('/tests/service/main.js'))
      assert.ok(own !== undefined, `no row for the fixture in ${String(rows.length)} rows`)
      assert.match(own.sourceMapURL ?? '', /main\.js\.map/)
    })
  })

  // Attaching cannot see what the target did before the attach, but the end-of-run
  // generated fetch must still work for everything it did see.
  test('fetches generated text for a file script', async () => {
    await withInspector(async (source) => {
      await source.take()
      const entry = [...source.scripts()].find(([, info]) =>
        info.url.endsWith('/tests/service/main.js'),
      )
      assert.ok(entry !== undefined)
      await source.prepare?.([entry[0]])
      const generated = source.generated?.(entry[0])
      assert.ok(generated !== undefined, 'the fixture file should have generated text')
      assert.ok((generated?.lineStarts.length ?? 0) > 1)
      assert.deepEqual(source.generatedMissing?.(), [])
    })
  })

  test('takeSync refuses rather than pretending to be synchronous', async () => {
    await withInspector(async (source) => {
      assert.throws(() => source.takeSync(), /sync/i)
    })
  })

  // The shard header names the process the coverage came from, and a debugger port
  // says nothing about which pid is behind it.
  test('reports the pid of the process it attached to', async () => {
    await withInspector(async (source, service) => {
      assert.equal(source.pid, service.proc.pid)
    })
  })

  // Attaching on the debugger line — before the target's bootstrap has installed
  // `process.pid` — is the ordinary case for a service someone has just started.
  // The answer is `undefined` in that window, not an error, so the source has to
  // ask again rather than refuse.
  test('waits for the pid of a target that is still starting', async () => {
    const child = spawn(process.execPath, ['--inspect=0', '-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    try {
      const url = await new Promise<string>((resolve) => {
        let seen = ''
        child.stderr?.setEncoding('utf8')
        child.stderr?.on('data', (chunk: string) => {
          seen += chunk
          const match = /Debugger listening on (ws:\/\/\S+)/.exec(seen)
          if (match?.[1] !== undefined) resolve(match[1].replace(/\/$/, ''))
        })
      })
      const source = await inspectorSource({ url, timeoutMs: 5_000 })
      try {
        assert.equal(source.pid, child.pid)
      } finally {
        source.close()
      }
    } finally {
      child.kill('SIGKILL')
    }
  })

  // Boundaries are sent from hooks that cannot wait, so more than one is in flight
  // at the same time by design. The handles must still resolve in dispatch order.
  test('dispatch sends a boundary now and settles windows in order', async () => {
    await withInspector(async (source) => {
      await source.dispatch().settle()

      const first = source.dispatch()
      const second = source.dispatch()
      assert.equal(second.seq, first.seq + 1)

      const firstPayload = await first.settle()
      const secondPayload = await second.settle()
      assert.ok(Array.isArray(firstPayload))
      assert.ok(Array.isArray(secondPayload))

      const drift = source.drift()
      assert.equal(drift.windows, 3)
      assert.ok(drift.maxDepth >= 2, `expected two boundaries in flight, saw ${String(drift.maxDepth)}`)
    })
  })

  // The reason dispatch exists: `Recorder` refuses a source that has neither a
  // synchronous take nor a boundary it can send. Driving the real recorder is the
  // only check that the attach path can produce a shard and a map at all.
  test('the Recorder can drive it as a service', async () => {
    const service = launchInspectorService()
    const dir = mkdtempSync(join(tmpdir(), 'cbd-inspector-shard-'))
    const shardPath = join(dir, 'service.jsonl')
    const source = await attach(service)
    try {
      const recorder = new Recorder({
        source,
        sink: new FileSink(shardPath),
        commit: 'inspector-test',
        // The header names the process the coverage came from. A recorder defaults
        // to its own pid, which for an attached source is the wrong process.
        pid: source.pid,
        role: 'service',
        scan: {
          prefilter: (url: string) => url.includes('/tests/service/'),
          include: (file: string) => file.replaceAll('\\', '/').endsWith('/tests/service/main.js'),
        },
      })

      recorder.runStart()
      // Drain the attach itself, so the window below is about the request.
      recorder.testStart('drain', 'spec.ts')
      recorder.testEnd('drain', 'passed', 0)
      await recorder.drained()

      recorder.testStart('runs reverse', 'spec.ts')
      service.run('run')
      await settle()
      recorder.testEnd('runs reverse', 'passed', 1)
      await recorder.drained()

      recorder.runEnd()
      await recorder.drained()
      recorder.close()

      const records = parseShard(readFileSync(shardPath, 'utf8'), shardPath)
      const header = records[0]
      assert.ok(header !== undefined && header.type === 'shard')
      assert.equal(header.pid, service.proc.pid, 'the header names the target, not this process')

      const tests = records.filter((record): record is ShardTest => record.type === 'test')
      assert.equal(tests.length, 2)
      const ran = tests.find((record) => record.title === 'runs reverse')
      assert.ok(ran !== undefined)
      assert.ok(
        Object.keys(ran.touches).length > 0,
        'the request must be in its own window, not the drain before it',
      )
    } finally {
      source.close()
      service.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Two collectors on one target split one coverage counter, so neither map is
  // right. The refusal names the holder.
  test('a second collector on the same target is refused', async () => {
    await withInspector(async (_source, service) => {
      const url = await service.url
      await assert.rejects(
        () => inspectorSource({ url, timeoutMs: 5_000 }),
        /already being recorded/,
      )
    })
  })

  test('a lock left by a dead collector is reclaimed', async () => {
    await withInspector(async (_source, service) => {
      // The first source holds the live lock. Replace it with one whose pid cannot
      // exist, which is what a killed collector leaves behind.
      const origin = resolveInspectorTarget({ url: await service.url }).origin
      const path = inspectorLockPath(origin)
      rmSync(path, { force: true })
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ pid: 2_000_000_000, origin, token: 'dead' }))

      const source = await inspectorSource({ url: await service.url, timeoutMs: 5_000 })
      try {
        await source.take()
      } finally {
        source.close()
      }
    })
  })

  // The list is data from the target. Reading a URL out of it without the same
  // loopback check would let a compromised or misconfigured target redirect the
  // collector to a remote debugger.
  test('a /json/list URL that is not loopback is refused', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify([{ webSocketDebuggerUrl: 'ws://10.0.0.5:9229/x' }]))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = address !== null && typeof address === 'object' ? address.port : 0
    try {
      await assert.rejects(() => inspectorSource({ port, timeoutMs: 2_000 }), /allowRemote/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
