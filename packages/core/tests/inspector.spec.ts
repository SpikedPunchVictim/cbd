import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { test } from '@japa/runner'
import {
  DEFAULT_INSPECTOR_HOST,
  InspectorTargetError,
  assertInspectorUnheld,
  inspectorLockPath,
  inspectorSource,
  isLoopbackHost,
  parseInspectorTarget,
  resolveInspectorTarget,
} from '../src/source/inspector.js'

/*
|--------------------------------------------------------------------------
| isLoopbackHost — the security rule, in one predicate
|--------------------------------------------------------------------------
*/

test('loopback names are recognised', () => {
  for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
    assert.ok(isLoopbackHost(host), `${host} should be loopback`)
  }
})

// 0.0.0.0 is the bind-all address. Reading it as "local" would wave through
// exactly the exposure the rule exists to stop.
test('a public or bind-all host is not loopback', () => {
  for (const host of [
    '0.0.0.0',
    '10.0.0.5',
    '192.168.1.10',
    'example.com',
    '128.0.0.1',
    '127.0.0.256',
  ]) {
    assert.equal(isLoopbackHost(host), false, `${host} must not be treated as loopback`)
  }
})

test('an unrecognised host fails closed', () => {
  assert.equal(isLoopbackHost(''), false)
  assert.equal(isLoopbackHost('::ffff:127.0.0.1'), false)
})

/*
|--------------------------------------------------------------------------
| resolveInspectorTarget — one target, named one way
|--------------------------------------------------------------------------
*/

test('port form defaults to loopback and builds an origin for /json/list', () => {
  const target = resolveInspectorTarget({ port: 9230 })
  assert.equal(target.host, DEFAULT_INSPECTOR_HOST)
  assert.equal(target.port, 9230)
  assert.equal(target.origin, 'http://127.0.0.1:9230')
  // The WebSocket URL carries a per-process UUID, so it cannot be guessed from
  // the port — only /json/list knows it.
  assert.equal(target.url, undefined)
})

test('url form is kept verbatim and its origin derived from it', () => {
  const ws = 'ws://127.0.0.1:9230/7f3c1e2a-0000-4000-8000-000000000000'
  const target = resolveInspectorTarget({ url: ws })
  assert.equal(target.url, ws)
  assert.equal(target.port, 9230)
  assert.equal(target.origin, 'http://127.0.0.1:9230')
})

test('an IPv6 loopback literal is bracketed back into the origin', () => {
  const target = resolveInspectorTarget({ host: '::1', port: 9230 })
  assert.equal(target.origin, 'http://[::1]:9230')
})

test('naming the target two ways is refused, not resolved', () => {
  assert.throws(
    () => resolveInspectorTarget({ url: 'ws://127.0.0.1:9230/x', port: 9230 }),
    /not both/,
  )
})

test('naming no target is refused', () => {
  assert.throws(() => resolveInspectorTarget({}), /no target/)
})

test('a non-loopback host needs allowRemote, and is refused without it', () => {
  assert.throws(() => resolveInspectorTarget({ host: '10.0.0.5', port: 9229 }), InspectorTargetError)
  assert.throws(() => resolveInspectorTarget({ host: '10.0.0.5', port: 9229 }), /allowRemote/)

  // allowRemote must be the boolean true, not merely truthy — a stringly-typed
  // config file must not be able to open the port by accident.
  assert.throws(() => resolveInspectorTarget({ host: '10.0.0.5', port: 9229, allowRemote: false }))
  const target = resolveInspectorTarget({ host: '10.0.0.5', port: 9229, allowRemote: true })
  assert.equal(target.origin, 'http://10.0.0.5:9229')
})

test('the loopback rule is applied to a url target too', () => {
  assert.throws(() => resolveInspectorTarget({ url: 'ws://10.0.0.5:9229/x' }), /allowRemote/)
})

test('url must be a debugger URL, not the /json/list origin', () => {
  assert.throws(() => resolveInspectorTarget({ url: 'http://127.0.0.1:9230' }), /ws:\/\//)
})

test('a port outside the range is refused', () => {
  for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
    assert.throws(() => resolveInspectorTarget({ port }), /port must be/)
  }
})

/*
|--------------------------------------------------------------------------
| parseInspectorTarget — the value `--target` and CBD_INSPECT carry
|--------------------------------------------------------------------------
*/

test('a debugger URL is taken verbatim', () => {
  const ws = 'ws://127.0.0.1:9230/7f3c1e2a-0000-4000-8000-000000000000'
  assert.deepEqual(parseInspectorTarget(ws), { url: ws })
})

test('host:port and a bare port both name a loopback target', () => {
  assert.deepEqual(parseInspectorTarget('127.0.0.1:9230'), { host: '127.0.0.1', port: 9230 })
  assert.deepEqual(parseInspectorTarget('9230'), { port: 9230 })
  // Bracketed IPv6 keeps its brackets, and the last colon is the separator.
  assert.deepEqual(parseInspectorTarget('[::1]:9230'), { host: '[::1]', port: 9230 })
})

test('the loopback rule is applied before anything connects', () => {
  assert.throws(() => parseInspectorTarget('10.0.0.5:9229'), /allowRemote/)
  assert.deepEqual(parseInspectorTarget('10.0.0.5:9229', true), {
    host: '10.0.0.5',
    port: 9229,
    allowRemote: true,
  })
})

test('a value that is not a target says so', () => {
  assert.throws(() => parseInspectorTarget(''), /empty target/)
  assert.throws(() => parseInspectorTarget('http://127.0.0.1:9229'), /host:port/)
  assert.throws(() => parseInspectorTarget('nonsense'), /not a target/)
  assert.throws(() => parseInspectorTarget('127.0.0.1:http'), /not a target/)
  assert.throws(() => parseInspectorTarget('127.0.0.1:0'), /port must be/)
})

/*
|--------------------------------------------------------------------------
| assertInspectorUnheld — the pre-flight lock check
|--------------------------------------------------------------------------
*/

test('a live collector is refused without connecting', () => {
  const origin = resolveInspectorTarget({ port: 9230 }).origin
  const path = inspectorLockPath(origin)
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid, origin, token: 'live' }))
    assert.throws(() => assertInspectorUnheld({ port: 9230 }), /already being recorded/)
  } finally {
    rmSync(path, { force: true })
  }
})

// A killed collector leaves its lock behind; refusing forever would make a crashed
// run poison its target.
test('a lock whose owner is gone does not refuse', () => {
  const origin = resolveInspectorTarget({ port: 9230 }).origin
  const path = inspectorLockPath(origin)
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, JSON.stringify({ pid: 2_000_000_000, origin, token: 'dead' }))
    const target = assertInspectorUnheld({ port: 9230 })
    assert.equal(target.origin, origin)
  } finally {
    rmSync(path, { force: true })
  }
})

/*
|--------------------------------------------------------------------------
| inspectorSource — the entry point
|--------------------------------------------------------------------------
*/

// The security rule has to hold through the real entry point, not only in its own
// unit test: a remote target is refused before any lock or connection is touched.
test('inspectorSource refuses a remote target before anything connects', async () => {
  await assert.rejects(() => inspectorSource({ host: '10.0.0.5', port: 9229 }), /allowRemote/)
})
