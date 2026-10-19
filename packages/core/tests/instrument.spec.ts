/**
 * `cbd-a3v.1` acceptance: a compiled service that imports nothing from CBD starts
 * under one environment variable, and a client reads a delta over its socket that
 * names a function the service ran and carries enough `scriptParsed` data to map
 * it back to TypeScript.
 *
 * Everything here is a real process and a real unix socket. `takeSync` and the
 * in-process source are covered elsewhere; the questions this file asks — does
 * the module stay inert, does it refuse to crash its host, does a take reset —
 * only have answers outside the process.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import {
  LineSplitter,
  encodeMessage,
  type HelloResult,
  type InstrumentOp,
  type InstrumentRequest,
  type InstrumentResponse,
  type TakeResult,
} from '../src/instrument-protocol.js'
import { CORRELATION_HEADER } from '../src/correlate.js'
import {
  INSTRUMENT_SPECIFIER,
  launchService,
  waitForSocket,
  withService,
} from './support/service.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))

interface Client {
  request(op: InstrumentOp): Promise<InstrumentResponse>
  /** Acknowledge a take by the id the reply carried, so its snapshot rows can be dropped. */
  ack(ackId: number): Promise<InstrumentResponse>
  close(): void
}

async function connect(socketPath: string): Promise<Client> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const candidate = net.connect(socketPath)
    candidate.once('connect', () => resolve(candidate))
    candidate.once('error', reject)
  })

  socket.setEncoding('utf8')
  const splitter = new LineSplitter()
  const waiting = new Map<number, (response: InstrumentResponse) => void>()

  socket.on('data', (chunk: string) => {
    for (const line of splitter.push(chunk)) {
      if (line.trim() === '') continue
      const message = JSON.parse(line) as InstrumentResponse
      const resolve = waiting.get(message.id)
      if (resolve !== undefined) {
        waiting.delete(message.id)
        resolve(message)
      }
    }
  })
  socket.on('error', () => {})

  let nextId = 1
  return {
    request(op) {
      const id = nextId++
      return new Promise<InstrumentResponse>((resolve) => {
        waiting.set(id, resolve)
        socket.write(encodeMessage(buildRequest(id, op)))
      })
    },
    ack(ackId) {
      const id = nextId++
      return new Promise<InstrumentResponse>((resolve) => {
        waiting.set(id, resolve)
        socket.write(encodeMessage({ id, op: 'ack', ackId }))
      })
    },
    close: () => socket.destroy(),
  }
}

/**
 * Spelled out per op rather than built as `{ id, op }`, because the request type
 * is a discriminated union and a value of the union's type is not one of its
 * members.
 */
function buildRequest(id: number, op: InstrumentOp): InstrumentRequest {
  switch (op) {
    case 'hello':
      return { id, op: 'hello' }
    case 'take':
      return { id, op: 'take' }
    case 'close':
      return { id, op: 'close' }
    case 'ack':
      return { id, op: 'ack', ackId: 0 }
    case 'correlate':
      return { id, op: 'correlate', header: 'x-cbd-correlation' }
  }
}

function namesIn(coverage: TakeResult['coverage']): Set<string> {
  const names = new Set<string>()
  for (const script of coverage) {
    for (const fn of script.functions) if (fn.functionName !== '') names.add(fn.functionName)
  }
  return names
}

function functionNames(result: TakeResult): Set<string> {
  return namesIn(result.coverage)
}

/** The port a service announced for `serve`, from its own stdout. */
async function portOf(service: { output: () => string }): Promise<number> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const match = /port (\d+)/.exec(service.output())
    if (match !== null) return Number(match[1])
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`the service never announced a port. It wrote:\n${service.output()}`)
}

interface OnDiskSnapshot {
  scripts: Array<{ id: string }>
  windows: Array<{ takeId: number; scripts?: Array<{ id: string }> }>
  /** Exit-only; absent on the bounded per-take and periodic writes (`cbd-n9t.2`). */
  untaken?: unknown[]
  pendingRequests?: unknown[]
  endedAtUs?: number
}

/**
 * The snapshot as written for a given take, read after it is on disk.
 *
 * Polled rather than read once because the write happens after the reply is sent
 * — that ordering is deliberate (the client's wait does not include the write) —
 * so a client that has just been answered has not necessarily been outrun by it.
 */
async function snapshotFor(dir: string, pid: number, takeId: number): Promise<OnDiskSnapshot> {
  const path = join(dir, `pid-${String(pid)}.coverage.json`)
  const deadline = Date.now() + 2_000
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as OnDiskSnapshot
      if (file.windows.some((window) => window.takeId === takeId)) return file
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`the snapshot never carried take ${String(takeId)}: ${String(lastError)}`)
}

test.group('instrument module', () => {
  // The rule that makes it safe to put this in NODE_OPTIONS at all: inherited by
  // every process in the tree, so with nothing collecting it must do nothing.
  test('is inert when CBD_SOCKET_DIR is not set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-inert-'))
    const service = launchService({ CBD_SOCKET_DIR: undefined })
    try {
      await service.ready
      // Give a socket every chance to appear before concluding there is none.
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(existsSync(join(dir, `pid-${String(service.proc.pid)}.sock`)), false)
      assert.equal(service.output().includes('[cbd]'), false, 'the module must not write to stdio')
    } finally {
      service.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('announces its pid, protocol and role over hello', async () => {
    await withService({}, async (service) => {
      await service.ready
      await waitForSocket(service.socketPath)
      const client = await connect(service.socketPath)
      try {
        const response = await client.request('hello')
        assert.equal(response.ok, true)
        const hello = (response as { result: HelloResult }).result
        assert.equal(hello.pid, service.proc.pid)
        assert.equal(hello.role, 'service')
        assert.equal(hello.protocol, 1)
        assert.ok(hello.scriptCount > 0, 'Debugger.enable should have replayed scriptParsed')
      } finally {
        client.close()
      }
    })
  })

  test('a take is a delta, and names the functions the service ran', async () => {
    await withService({}, async (service) => {
      await service.ready
      await waitForSocket(service.socketPath)
      const client = await connect(service.socketPath)
      try {
        // Discard the startup window, so the take below can only contain what the
        // service did after it.
        await client.request('take')

        service.run('run')
        await new Promise((resolve) => setTimeout(resolve, 200))

        const response = await client.request('take')
        assert.equal(response.ok, true)
        const names = functionNames((response as { result: TakeResult }).result)

        assert.ok(names.has('reverseKey'), `expected reverseKey in ${[...names].join(', ')}`)
        assert.ok(names.has('validateSignature'), 'expected validateSignature')
        // The inverse map, at socket scale. If this appears the take is a running
        // total rather than a window.
        assert.equal(names.has('neverCalled'), false, 'neverCalled must not be in any window')
      } finally {
        client.close()
      }
    })
  })

  // The reason the protocol carries a script table at all: V8ScriptCoverage has
  // no sourceMapURL, so without this the coverage of a compiled service cannot be
  // resolved to the file a developer edits.
  test('carries scriptParsed rows that map the service back to its TypeScript', async () => {
    await withService({}, async (service) => {
      await service.ready
      await waitForSocket(service.socketPath)
      const client = await connect(service.socketPath)
      try {
        const response = await client.request('take')
        const { scripts } = (response as { result: TakeResult }).result

        const own = scripts.find((row) => row.url.endsWith('/tests/service/main.js'))
        assert.ok(own !== undefined, `no row for the service's own file in ${String(scripts.length)} rows`)
        // The map is declared by the generated file, so the table does not repeat
        // it (`cbd-llm`): the build reads the same bytes and recovers it. What the
        // row must provide is the URL that leads there.
        assert.equal(own.sourceMapURL, undefined, 'a file-declared map must not travel twice')
        assert.match(
          readFileSync(fileURLToPath(own.url), 'utf8'),
          /sourceMappingURL=main\.js\.map/,
          'the file the row names must declare the map the build needs',
        )

        // Sent once, not once per take — the table is drained.
        const second = await client.request('take')
        assert.equal((second as { result: TakeResult }).result.scripts.length, 0)
      } finally {
        client.close()
      }
    })
  })

  test('close removes the socket and leaves the service running', async () => {
    await withService({}, async (service) => {
      await service.ready
      await waitForSocket(service.socketPath)
      const client = await connect(service.socketPath)
      try {
        const response = await client.request('close')
        assert.equal(response.ok, true)
        assert.equal(existsSync(service.socketPath), false, 'close should unlink the socket')
      } finally {
        client.close()
      }

      // A service is expected to outlive the test run reading it. The spike called
      // process.exit(0) here, which is correct for a spike and fatal for a server.
      assert.equal(service.proc.exitCode, null, 'close must not exit the host process')
      service.run('idle')
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.ok(service.output().includes('idle'), 'the service should still be serving')
    })
  })

  /**
   * A snapshot carries only the rows no reply has delivered (`cbd-3z1`).
   *
   * The file exists to survive a death before a take's reply is read, so it must
   * carry the script rows that reply would have carried. It does **not** have to
   * carry rows an earlier take already delivered and the collector acknowledged:
   * those are in an absorbed reply, and repeating them rewrites the whole table on
   * every boundary — 4770 rows and 12 MB on a lane server, measured as ~1 ms added
   * to every boundary.
   *
   * So the property is stated in both directions: before the first ack the file
   * holds the table (nothing else has delivered it), and after the ack the next
   * take's file holds only what that take delivered.
   */
  test('an acknowledged take is not repeated in the next snapshot', async () => {
    await withService({}, async (service) => {
      await waitForSocket(service.socketPath)
      const client = await connect(service.socketPath)
      try {
        const firstReply = (await client.request('take')) as { result: TakeResult }
        const first = await snapshotFor(service.dir, service.proc.pid as number, 1)
        assert.equal(
          first.scripts.length,
          firstReply.result.scripts.length,
          'before any acknowledgement the snapshot must carry the whole table',
        )
        // The accumulator and the request queue are unbounded between boundaries;
        // the periodic write must not rewrite them (`cbd-n9t.2`). Only the exit
        // write carries them.
        assert.equal(
          first.untaken,
          undefined,
          'a per-take snapshot must not carry the untaken accumulator',
        )
        assert.equal(
          first.pendingRequests,
          undefined,
          'a per-take snapshot must not carry the request queue',
        )

        await client.ack(1)
        const secondReply = (await client.request('take')) as { result: TakeResult }
        const second = await snapshotFor(service.dir, service.proc.pid as number, 3)

        assert.deepEqual(
          second.scripts.map((row) => row.id),
          secondReply.result.scripts.map((row) => row.id),
          'the snapshot should carry exactly what the unacknowledged take delivered',
        )
        const repeated = second.scripts.filter((row) =>
          firstReply.result.scripts.some((delivered) => delivered.id === row.id),
        )
        assert.deepEqual(repeated, [], 'an acknowledged take must not be written again')
      } finally {
        client.close()
      }
    })
  })

  /**
   * A process that exits normally leaves everything it ran, not just the last tick.
   *
   * This is the shape `cbd-0gw` measured: a stand-alone server booted by a test to
   * fail — a wrong password, a taken port — lives for a few hundred milliseconds,
   * which is less than the snapshot interval and gone before its boundary. The
   * exit handler cannot await an inspector round trip, so the take it performs is
   * synchronous, and that is only possible because the session is in this process.
   *
   * The process below deliberately exits inside the first interval, so the work
   * exists nowhere but the final write.
   */
  test('a process that exits before the first interval still leaves its execution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-exit-take-'))
    const script = `
      function afterTheLastTick() { return 42 }
      afterTheLastTick(); afterTheLastTick()
      process.exit(0)
    `
    try {
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          CBD_SOCKET_DIR: dir,
          NODE_OPTIONS: `--import ${INSTRUMENT_SPECIFIER}`,
        },
        encoding: 'utf8',
        timeout: 10_000,
      })
      assert.equal(result.status, 0, result.stderr)

      const file = JSON.parse(
        readFileSync(join(dir, `pid-${String(result.pid)}.coverage.json`), 'utf8'),
      ) as {
        endedAtUs?: number
        untaken: Array<{ functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }>
        windows: Array<{ coverage: Array<{ functions: Array<{ functionName: string; ranges: Array<{ count: number }> }> }> }>
      }
      assert.notEqual(file.endedAtUs, undefined, 'the exit handler did not write a final snapshot')

      const counts = new Map<string, number>()
      for (const script of [...file.untaken, ...file.windows.flatMap((window) => window.coverage)]) {
        for (const fn of script.functions) {
          const count = Math.max(...fn.ranges.map((range) => range.count))
          counts.set(fn.functionName, Math.max(counts.get(fn.functionName) ?? 0, count))
        }
      }
      assert.ok(
        (counts.get('afterTheLastTick') ?? 0) >= 2,
        `the final take did not carry the execution (saw ${String(counts.get('afterTheLastTick'))})`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * I2, at the wire: a request that names itself is its own window.
   *
   * Without correlation this work belongs to whichever take happens to run next,
   * which is the attribution-by-time that goes wrong when the test does not await.
   * The `correlate` op makes the instrument take at the request's boundaries, and
   * the reply carries those windows with the id that owns them.
   */
  test('correlate turns a request into a tagged window', async () => {
    await withService({}, async (service) => {
      await waitForSocket(service.socketPath)
      const client = await connect(service.socketPath)
      try {
        // Discard the startup window, so the request window below is the only
        // thing the handler can appear in.
        await client.request('take')
        const configured = await client.request('correlate')
        assert.equal(configured.ok, true, 'the instrument should accept the correlate op')

        service.run('serve')
        const port = await portOf(service)
        const id = 'test-window-7'
        const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
          headers: { [CORRELATION_HEADER]: id },
        })
        assert.equal(await response.text(), '21')

        // The finish boundary is taken when the response is flushed; give the
        // queued take a turn to reach the inspector before asking for the reply.
        await new Promise((resolve) => setTimeout(resolve, 200))
        const take = (await client.request('take')) as { result: TakeResult }
        const requests = take.result.requests ?? []
        const window = requests.find((candidate) => candidate.ids.includes(id))
        assert.ok(window !== undefined, `no request window for ${id}: ${JSON.stringify(requests)}`)
        assert.ok(
          namesIn(window.coverage).has('priced'),
          `the request window did not carry the handler's work: ${[...namesIn(window.coverage)].join(', ')}`,
        )
      } finally {
        client.close()
      }
    })
  })

  /**
   * The off switch a collector in the same process uses.
   *
   * A suite must carry `NODE_OPTIONS` for the services it starts to be instrumented
   * at all (ADR-0005), which puts this module inside the test runner too. Two
   * coverage clients on one isolate split one stream of execution between them —
   * each take resets the counters the other was about to read — so the in-process
   * source stands this module down. What must be true of that is that the module
   * leaves nothing behind: no socket for another collector to attach to, and no
   * snapshot for a harvester to attribute to a window nobody took.
   */
  test('stands down on request, taking its socket and snapshot with it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cbd-standdown-'))
    // `-e` rather than a fixture file: the question is what the *entry point* can
    // see after `--import` has finished evaluating, and a module with a top-level
    // await guarantees the handle exists before the first line here runs.
    const script = `
      (async () => {
        const fs = require('node:fs')
        const socket = process.env.CBD_SOCKET_DIR + '/pid-' + process.pid + '.sock'
        for (let i = 0; i < 400 && !fs.existsSync(socket); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        const before = fs.existsSync(socket)
        const handle = typeof globalThis.__cbdInstrument?.stop
        const carried = await globalThis.__cbdInstrument?.stop()
        console.log(JSON.stringify({ before, handle, after: fs.existsSync(socket), carried: Array.isArray(carried) ? carried.length : -1 }))
      })()
    `
    try {
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          CBD_SOCKET_DIR: dir,
          NODE_OPTIONS: `--import ${INSTRUMENT_SPECIFIER}`,
        },
        encoding: 'utf8',
        timeout: 10_000,
      })
      assert.equal(result.status, 0, result.stderr)
      const reported = JSON.parse(result.stdout.trim()) as {
        before: boolean
        handle: string
        after: boolean
        carried: number
      }
      // `carried` is what the collector in this process would otherwise lose: the
      // final take hands over everything the self-snapshots had consumed since
      // birth. This entry point has definitely run a function by now.
      assert.deepEqual(
        { ...reported, carried: reported.carried > 0 ? 'some' : 'none' },
        { before: true, handle: 'function', after: false, carried: 'some' },
      )
      assert.equal(
        existsSync(join(dir, `pid-${String(result.pid)}.coverage.json`)),
        false,
        'a stopped module must not leave a snapshot behind',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
