/**
 * The test side of request-id correlation: naming a window, and putting that name
 * on the requests a test makes.
 *
 * Real servers on port 0, because the question is what the *service* receives, and
 * a mocked request module would prove only that a function was called.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from '@japa/runner'
import { CORRELATION_HEADER, Correlator } from '../src/correlate.js'

interface Received {
  headers: http.IncomingHttpHeaders
}

/** A server that records the headers of every request it answers. */
async function listening(): Promise<{
  url: string
  received: Received[]
  close: () => Promise<void>
}> {
  const received: Received[] = []
  const server = http.createServer((request, response) => {
    received.push({ headers: request.headers })
    response.end('ok')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    received,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)))
      }),
  }
}

function request(url: string, headers: http.OutgoingHttpHeaders = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const call = http.request(url, { headers }, (response) => {
      response.resume()
      response.on('end', () => resolve())
    })
    call.on('error', reject)
    call.end()
  })
}

test.group('Correlator', () => {
  test('names a window once and remembers its owner', () => {
    const correlator = new Correlator()
    assert.equal(correlator.current(), undefined)

    const id = correlator.begin('adds', '/repo/tests/a.spec.ts')
    assert.match(id, /^\d+-\d+$/)
    assert.equal(correlator.begin('ignored', null), id, 'a second recorder must not consume an id')
    assert.deepEqual(correlator.ownerOf(id), { title: 'adds', file: '/repo/tests/a.spec.ts' })
    assert.equal(correlator.current(), id)

    correlator.end()
    assert.equal(correlator.current(), undefined)
    assert.equal(correlator.size, 1, 'the owner is kept for late request windows')

    const second = correlator.begin('reads', null)
    assert.notEqual(second, id)
    assert.equal(correlator.ownerOf(id)?.title, 'adds')
  })

  test('an unknown id has no owner, which is how @between is chosen', () => {
    const correlator = new Correlator()
    correlator.begin('adds', null)
    assert.equal(correlator.ownerOf('someone-else-1'), undefined)
  })

  test('install puts the id on an http request made inside the window', async () => {
    const server = await listening()
    const correlator = new Correlator()
    correlator.install()
    try {
      const id = correlator.begin('adds', null)
      await request(server.url)
      assert.equal(server.received[0]?.headers[CORRELATION_HEADER], id)

      correlator.end()
      await request(server.url)
      assert.equal(
        server.received[1]?.headers[CORRELATION_HEADER],
        undefined,
        'a request outside every window carries no id',
      )
    } finally {
      correlator.release()
      await server.close()
    }
  })

  test('install does not overwrite an explicit header', async () => {
    const server = await listening()
    const correlator = new Correlator()
    correlator.install()
    try {
      correlator.begin('adds', null)
      await request(server.url, { [CORRELATION_HEADER]: 'the-caller-chose-this' })
      assert.equal(server.received[0]?.headers[CORRELATION_HEADER], 'the-caller-chose-this')
    } finally {
      correlator.release()
      await server.close()
    }
  })

  test('install covers fetch as well as http', async () => {
    const server = await listening()
    const correlator = new Correlator()
    correlator.install()
    try {
      // `Headers` normalizes the name, so read it lower-case from the server.
      const id = correlator.begin('adds', null)
      await (await fetch(`${server.url}/`)).text()
      assert.equal(server.received[0]?.headers[CORRELATION_HEADER], id)
    } finally {
      correlator.release()
      await server.close()
    }
  })

  test('release restores the request function it replaced', async () => {
    const before = http.request
    const correlator = new Correlator()
    correlator.install()
    assert.notEqual(http.request, before)
    correlator.release()
    assert.equal(http.request, before)
    // Idempotent: a second release must not un-patch a third party's wrapper.
    correlator.release()
    assert.equal(http.request, before)
  })
})

test('a Request keeps its headers inside a correlation window', async () => {
  const server = await listening()
  const correlator = new Correlator()
  correlator.install()
  try {
    correlator.begin('t', null)
    const response = await fetch(
      new Request(server.url, { headers: { authorization: 'Bearer x', 'x-custom': 'y' } }),
    )
    await response.text()
    assert.equal(server.received[0]!.headers.authorization, 'Bearer x')
    assert.equal(server.received[0]!.headers['x-custom'], 'y')
    assert.ok(server.received[0]!.headers[CORRELATION_HEADER])
  } finally {
    correlator.release()
    await server.close()
  }
})

test('http.request(url, undefined, callback) keeps its callback', async () => {
  const server = await listening()
  const correlator = new Correlator()
  correlator.install()
  try {
    correlator.begin('t', null)
    const status = await new Promise<number>((resolve, reject) => {
      // Node accepts (url, undefined, callback) at runtime; its typings do not.
      const request = (
        http.request as unknown as (
          url: string,
          options: undefined,
          callback: (response: http.IncomingMessage) => void,
        ) => http.ClientRequest
      )(server.url, undefined, (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
      request.on('error', reject)
      request.end()
    })
    assert.equal(status, 200)
    assert.ok(server.received[0]!.headers[CORRELATION_HEADER])
  } finally {
    correlator.release()
    await server.close()
  }
})

test('begin mirrors the recorder ordinal for repeated titles', () => {
  const correlator = new Correlator()
  const first = correlator.begin('dup', '/f')
  correlator.end()
  const second = correlator.begin('dup', '/f')
  correlator.end()
  assert.equal(correlator.ownerOf(first)!.ordinal, undefined)
  assert.equal(correlator.ownerOf(second)!.ordinal, 1)
})
