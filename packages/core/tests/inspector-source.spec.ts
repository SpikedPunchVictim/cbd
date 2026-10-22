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
import { createServer } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { test } from '@japa/runner'
import { resolveInspectorTarget, inspectorSource, inspectorLockPath } from '../src/source/inspector.js'
import type { Source, V8ScriptCoverage } from '../src/types.js'
import { sourceContract } from './support/source-contract.js'
import { launchInspectorService, type RunningInspectorService } from './support/service.js'

async function attach(service: RunningInspectorService): Promise<Source> {
  await service.ready
  return inspectorSource({ url: await service.url, timeoutMs: 5_000 })
}

/** One service and one source, both torn down. */
async function withInspector(
  body: (source: Source, service: RunningInspectorService) => Promise<void>,
): Promise<void> {
  const service = launchInspectorService()
  let source: Source | null = null
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
