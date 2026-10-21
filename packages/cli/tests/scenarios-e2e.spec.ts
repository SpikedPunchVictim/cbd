/**
 * I1-I4: the integration scenarios, driven through `cbd collect` end to end.
 *
 * Each scenario is a real repository with a real git history, a real japa entry
 * point, and — where the scenario has one — a real service started the way a
 * developer starts one (`NODE_OPTIONS`, ADR-0005). The loop under test is the
 * product loop: `cbd collect` records and builds a map, a file changes, and
 * `cbd select` names the tests that must run.
 *
 * The four scenarios are the ones IMPLEMENTATION_PLAN.md's Phase C table names:
 *
 *   I1  a server in the test process          — the in-process source, no join needed
 *   I2  a service in another process          — request-id correlation
 *   I3  workers the suite starts              — the re-scanning source, multiple targets
 *   I4  a queue with no request boundary      — no correlation is possible; the answer
 *                                               is a bucket, and a change to it escalates
 *
 * **I2 is the one that needed code.** The request is fired by one test and the
 * service finishes it during the next; attribution by time credits the second
 * test, and a change to the handler would then select a test that did not cause
 * it. The assertion is the map's inverse: `handlePrice` reaches exactly the test
 * that sent the request.
 *
 * **I4 asserts the limit rather than papering over it.** Background work with no
 * boundary is `@load` here (the service does it before the suite starts), and §8.3
 * rule 2 escalates any change to a file reached only there. The test checks the
 * *answer* — `mode: all` — not merely that the work was recorded.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { loadMap, testsForFunction } from '@spikedpunch/cbd'

const CLI_BIN = fileURLToPath(new URL('../../bin/cbd.js', import.meta.url))
const INSTRUMENT = fileURLToPath(new URL('../../../core/dist/src/instrument.js', import.meta.url))
const JAPA_RUNNER = import.meta.resolve('@japa/runner')
const JAPA_PLUGIN = new URL('../../../japa/dist/src/index.js', import.meta.url).href
const TMP = fileURLToPath(new URL('../../.scenario-tmp/', import.meta.url))

/** A scenario repository: files, a git history, and the generated entry point. */
interface Scenario {
  root: string
  cleanup: () => void
}

function scenario(
  name: string,
  files: Record<string, string>,
  options: { instrumentChildren?: boolean } = {},
): Scenario {
  mkdirSync(TMP, { recursive: true })
  const root = mkdtempSync(join(TMP, `${name}-`))
  for (const [path, content] of Object.entries(files)) write(root, path, content)
  write(root, 'runner.mjs', runner(options))
  write(root, '.gitignore', '.cbd/\n.sockets/\nnode_modules/\n')
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'cbd@example.invalid')
  git(root, 'config', 'user.name', 'CBD scenario')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'base')
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function write(root: string, path: string, content: string): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' })
}

/**
 * The consumer's entry point, with the plugin imported by absolute path.
 *
 * The scenario repositories live under `packages/cli`, so a bare
 * `@spikedpunch/cbd-japa` would resolve only if this package declared it. An
 * absolute URL keeps the harness's dependency list honest: the CLI drives the run,
 * and the runner names the adapter it is driving.
 */
function runner(options: { instrumentChildren?: boolean }): string {
  return `import { configure, processCLIArgs, run } from ${JSON.stringify(JAPA_RUNNER)}
import { cbd } from ${JSON.stringify(JAPA_PLUGIN)}

// Only the children are instrumented, not this process: its coverage is taken
// in-process. Setting the variable here rather than on the collect process keeps
// the CLI itself out of the socket directory — it is blocked in a synchronous
// spawn, so a source that discovered it would wait out every timeout.
${options.instrumentChildren === true ? `process.env.NODE_OPTIONS = ${JSON.stringify(`--import ${INSTRUMENT}`)}` : ''}

processCLIArgs([])
configure({ cwd: process.cwd(), files: ['tests/*.spec.js'], plugins: [cbd()] })
await run()
`
}

function runCli(root: string, env: NodeJS.ProcessEnv, ...args: string[]): {
  status: number | null
  stdout: string
  stderr: string
} {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The environment that must not leak between scenarios. */
function baseEnv(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.CBD_SOCKET_DIR
  delete env.CBD_CORRELATION
  delete env.CBD_CORRELATION_HEADER
  delete env.CBD_SHARD
  delete env.CBD_COMMIT
  delete env.CBD_SELECTION
  return env
}

interface Service {
  proc: ChildProcess
  port: number
  stop: () => void
}

/** Starts a service the way a developer does: `NODE_OPTIONS`, one socket directory. */
function startService(root: string, file: string, env: NodeJS.ProcessEnv): Promise<Service> {
  const proc = spawn(process.execPath, [join(root, file)], {
    cwd: root,
    env: { ...env, NODE_OPTIONS: `--import ${INSTRUMENT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk: string) => {
    output += chunk
  })
  proc.stderr?.on('data', (chunk: string) => {
    output += chunk
  })

  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the scenario service never announced a port. It wrote:\n${output}`))
    }, 10_000)
    const settle = (): void => {
      const match = /listening (\d+)/.exec(output)
      if (match === null) return
      clearTimeout(timer)
      resolve(Number(match[1]))
    }
    proc.stdout?.on('data', settle)
    proc.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`the scenario service exited with ${String(code)}. It wrote:\n${output}`))
    })
    settle()
  }).then((port) => ({ proc, port, stop: () => proc.kill('SIGKILL') }))
}

function record(root: string, env: NodeJS.ProcessEnv): void {
  const run = runCli(root, env, 'collect', '--', process.execPath, 'runner.mjs')
  assert.equal(
    run.status,
    0,
    `cbd collect failed.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
  )
}

/** The map `cbd collect` built, plus the key a function was recorded under. */
function recordedFunction(root: string, file: string, name: string): string[] {
  const map = loadMap(root, git(root, 'rev-parse', 'HEAD').trim()).map
  const key = Object.keys(map.files[file] ?? {}).find((candidate) => candidate.startsWith(`${name}@`))
  assert.ok(
    key !== undefined,
    `the map has no ${name} in ${file}. It knows: ${Object.keys(map.files[file] ?? {}).join(', ')}`,
  )
  return testsForFunction(map, file, key).map((entry) => entry.title)
}

interface SelectionJson {
  selection: { mode: 'subset' | 'all'; reasons: Array<{ kind: string; why?: string }> }
  selected: Array<{ title: string }>
}

function select(root: string): { status: number | null; result: SelectionJson } {
  const run = runCli(root, baseEnv(root), 'select', '--format', 'json')
  assert.ok(run.stdout.trim() !== '', `cbd select printed nothing.\nstderr:\n${run.stderr}`)
  return { status: run.status, result: JSON.parse(run.stdout) as SelectionJson }
}

// ---------------------------------------------------------------------------
// I1 — a server in the test process
// ---------------------------------------------------------------------------

test('I1: a server in the test process is attributed, and a change selects that test', () => {
  const { root, cleanup } = scenario('i1', {
    'src/inproc.js': `export function price(qty) {
  return qty * 3
}
`,
    'tests/inproc.spec.js': `import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from '@japa/runner'
import { price } from '../src/inproc.js'

test.group('in-process', () => {
  test('serves a price from the same process', async () => {
    const server = createServer((_request, response) => response.end(String(price(2))))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const response = await fetch('http://127.0.0.1:' + port + '/')
    assert.equal(await response.text(), '6')
    await new Promise((resolve) => server.close(resolve))
  })
})
`,
  })
  try {
    record(root, baseEnv(root))
    assert.deepEqual(recordedFunction(root, join(root, 'src/inproc.js'), 'price'), [
      'serves a price from the same process',
    ])

    writeFileSync(join(root, 'src/inproc.js'), 'export function price(qty) {\n  return qty * 4\n}\n')
    const { status, result } = select(root)
    assert.equal(status, 0)
    assert.equal(result.selection.mode, 'subset')
    assert.deepEqual(
      result.selected.map((entry) => entry.title),
      ['serves a price from the same process'],
    )
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// I2 — a service in another process, joined by request id
// ---------------------------------------------------------------------------

test('I2: a request finished during the next test is attributed to the test that sent it', async () => {
  const { root, cleanup } = scenario('i2', {
    'src/handler.js': `export function handlePrice(quantity) {
  return quantity * 7
}
`,
    'service.js': `import { createServer } from 'node:http'
import { handlePrice } from './src/handler.js'

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/slow') {
    // The response is delayed, and the handler work runs *after* the delay, so it
    // happens while the next test's window is open. Time-based attribution gives
    // it to that test; the request id gives it to the one that asked.
    const delay = Number(url.searchParams.get('delayMs') ?? '0')
    setTimeout(() => response.end(String(handlePrice(3))), delay)
    return
  }
  response.statusCode = 404
  response.end('no such route')
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write('listening ' + server.address().port + '\\n')
})
`,
    'tests/remote.spec.js': `import assert from 'node:assert/strict'
import { test } from '@japa/runner'

const base = process.env.CBD_SCENARIO_URL

test.group('remote request', () => {
  test('fires a request without awaiting it', () => {
    globalThis.pending = fetch(base + '/slow?delayMs=150').then((response) => response.text())
  })

  test('waits while the service finishes it', async () => {
    await new Promise((resolve) => setTimeout(resolve, 350))
    assert.equal(await globalThis.pending, '21')
  })
})
`,
  })
  const env = baseEnv(root)
  const socketDir = mkdtempSync(join(tmpdir(), 'cbd-scenario-sockets-'))
  env.CBD_SOCKET_DIR = socketDir
  let service: Service | null = null
  try {
    service = await startService(root, 'service.js', env)
    env.CBD_SCENARIO_URL = `http://127.0.0.1:${String(service.port)}`

    record(root, env)
    assert.deepEqual(recordedFunction(root, join(root, 'src/handler.js'), 'handlePrice'), [
      'fires a request without awaiting it',
    ])

    writeFileSync(
      join(root, 'src/handler.js'),
      'export function handlePrice(quantity) {\n  return quantity * 8\n}\n',
    )
    const { status, result } = select(root)
    assert.equal(status, 0)
    assert.deepEqual(result.selected.map((entry) => entry.title), [
      'fires a request without awaiting it',
    ])
  } finally {
    service?.stop()
    rmSync(socketDir, { recursive: true, force: true })
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// I3 — a worker the suite starts
// ---------------------------------------------------------------------------

test('I3: a worker the suite spawns is discovered and attributed to the test that started it', async () => {
  const { root, cleanup } = scenario('i3', {
    'src/worker-lib.js': `export function crunch(value) {
  return value * value
}
`,
    'lane.js': `import { createServer } from 'node:http'

// The service the run is pointed at. Nothing drives it. It exists because the
// plugin refuses an empty socket directory at install — a run told to record a
// service that is not there must stop rather than record an empty server side —
// and because a directory that gains a process mid-run is the re-scan's job.
const server = createServer((_request, response) => response.end('lane'))
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('listening ' + server.address().port + '\\n')
})
`,
    'worker.js': `import { crunch } from './src/worker-lib.js'

process.on('message', (value) => {
  process.send(crunch(value))
  // Stay alive long enough for the boundary that ends the test to take this
  // process's coverage, then leave on our own. A worker killed from the test's
  // teardown races that take and loses it.
  setTimeout(() => process.exit(0), 400)
})

process.stdout.write('worker ready\\n')
`,
    'tests/workers.spec.js': `import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

let child = null

test.group('a worker the suite starts', (group) => {
  group.teardown(async () => {
    if (child === null) return
    // Wait for the worker's own exit, with a bound, so a failed run cannot leave a
    // process behind holding the runner's stdio open.
    const exited = new Promise((resolve) => child.once('exit', resolve))
    const timer = setTimeout(() => child.kill(), 2_000)
    await exited
    clearTimeout(timer)
    child = null
  })

  test('spawns a worker and waits for its answer', async () => {
    child = fork(fileURLToPath(new URL('../worker.js', import.meta.url)), {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    child.send(3)
    const answer = await new Promise((resolve) => child.once('message', resolve))
    assert.equal(answer, 9)
    // The re-scan interval is 25ms (ADR-0007); hold the window open so the child is
    // held by the boundary this test ends on rather than the next one.
    await new Promise((resolve) => setTimeout(resolve, 120))
  })
})
`,
  }, { instrumentChildren: true })
  const env = baseEnv(root)
  const socketDir = mkdtempSync(join(tmpdir(), 'cbd-scenario-sockets-'))
  env.CBD_SOCKET_DIR = socketDir
  let lane: Service | null = null
  try {
    lane = await startService(root, 'lane.js', env)
    record(root, env)
    assert.deepEqual(recordedFunction(root, join(root, 'src/worker-lib.js'), 'crunch'), [
      'spawns a worker and waits for its answer',
    ])

    writeFileSync(join(root, 'src/worker-lib.js'), 'export function crunch(value) {\n  return value * value + 0\n}\n')
    const { status, result } = select(root)
    assert.equal(status, 0)
    assert.deepEqual(result.selected.map((entry) => entry.title), [
      'spawns a worker and waits for its answer',
    ])
  } finally {
    lane?.stop()
    rmSync(socketDir, { recursive: true, force: true })
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// I4 — a queue with no request boundary
// ---------------------------------------------------------------------------

test('I4: work with no request boundary is a bucket, and a change to it escalates to all', async () => {
  const { root, cleanup } = scenario('i4', {
    'src/queue.js': `export function processJob(job) {
  return 'done:' + job
}
`,
    'service.js': `import { processJob } from './src/queue.js'

// A queue consumer with no request and no boundary. Nothing in the suite sent it:
// it runs on the service's own schedule, before the first test, which is @load.
setTimeout(() => {
  globalThis.last = processJob('boot')
}, 30)

import { createServer } from 'node:http'
const server = createServer((_request, response) => response.end(String(globalThis.last)))
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('listening ' + server.address().port + '\\n')
})
`,
    'tests/idle.spec.js': `import assert from 'node:assert/strict'
import { test } from '@japa/runner'

test.group('idle', () => {
  test('drives nothing', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(true)
  })
})
`,
  })
  const env = baseEnv(root)
  const socketDir = mkdtempSync(join(tmpdir(), 'cbd-scenario-sockets-'))
  env.CBD_SOCKET_DIR = socketDir
  let service: Service | null = null
  try {
    service = await startService(root, 'service.js', env)
    // Let the queue's own work run before the suite begins: the file is reached in
    // the service's first take, which is the @load bucket.
    await new Promise((resolve) => setTimeout(resolve, 150))

    record(root, env)
    const map = loadMap(root, git(root, 'rev-parse', 'HEAD').trim()).map
    const queueFile = join(root, 'src/queue.js')
    assert.ok(
      map.load.some((ref) => ref[0] === queueFile),
      'the queue work should be in @load: it ran before the first test',
    )

    writeFileSync(join(root, 'src/queue.js'), "export function processJob(job) {\n  return 'done:' + job + '!'\n}\n")
    const { status, result } = select(root)
    assert.equal(status, 3, 'an answer of "all" is exit 3, distinct from a failure')
    assert.equal(result.selection.mode, 'all')
    assert.ok(
      result.selection.reasons.some((reason) => reason.kind === 'all' && reason.why === 'load'),
      `expected the load arm to escalate. Reasons: ${JSON.stringify(result.selection.reasons)}`,
    )
  } finally {
    service?.stop()
    rmSync(socketDir, { recursive: true, force: true })
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// I5 — a test that reads a file, and one that lists a directory
// ---------------------------------------------------------------------------

test('I5: reads and directory listings select the test when the file changes', () => {
  const { root, cleanup } = scenario('i5', {
    'src/keep.js': 'export const keep = true\n',
    'data/schema.txt': 'a\n',
    'tests/reads.spec.js': `import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'

const here = dirname(fileURLToPath(import.meta.url))

test('checks the schema text', () => {
  assert.equal(readFileSync(join(here, '..', 'data', 'schema.txt'), 'utf8'), 'a\\n')
})

test('lists the sources', () => {
  assert.ok(readdirSync(join(here, '..', 'src')).includes('keep.js'))
})
`,
  })
  try {
    record(root, baseEnv(root))

    const schema = join(root, 'data/schema.txt')
    writeFileSync(schema, 'b\n')
    const read = select(root)
    assert.equal(read.status, 0)
    assert.deepEqual(read.result.selected.map((entry) => entry.title), ['checks the schema text'])
    assert.ok(
      read.result.selection.reasons.some((reason) => reason.kind === 'read'),
      'the answer should name the read reason',
    )

    git(root, 'checkout', '--', 'data/schema.txt')
    writeFileSync(join(root, 'src/new.js'), 'export const added = true\n')
    const listed = select(root)
    assert.equal(listed.status, 0)
    assert.deepEqual(listed.result.selected.map((entry) => entry.title), ['lists the sources'])
  } finally {
    cleanup()
  }
})
