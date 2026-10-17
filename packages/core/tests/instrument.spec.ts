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
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { launchService, waitForSocket, withService } from './support/service.js'

interface Client {
  request(op: InstrumentOp): Promise<InstrumentResponse>
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
  }
}

function functionNames(result: TakeResult): Set<string> {
  const names = new Set<string>()
  for (const script of result.coverage) {
    for (const fn of script.functions) if (fn.functionName !== '') names.add(fn.functionName)
  }
  return names
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
        assert.equal(own.sourceMapURL, 'main.js.map')

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
})
