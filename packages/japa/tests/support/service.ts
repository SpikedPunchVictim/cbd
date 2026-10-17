/**
 * Starting a service the way a developer starts one, and running a suite against it.
 *
 * Shared by the two end-to-end fixtures — the key server (`cbd-a3v.3.4`) and the service
 * that keeps working after it answers (`cbd-a3v.3.5`) — because both need the same two
 * things and neither should own a private copy of them. Not a `*.spec.ts`, so the test
 * glob does not run it.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseShard, type ShardInput, type ShardRecord } from '@spikedpunch/cbd'
import { serviceShardPath } from '../../src/plugin.js'

// Three levels up, not two: this file is compiled to `dist/tests/support/service.js`,
// so `../..` from here is `dist/`, not the package root. The fixture paths in the specs
// themselves stay two deep, because those files compile to `dist/tests/`.
/** The package root, which is where a fixture's service is started from. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The recorded entry point, which takes the mode as its first argument. */
export const BIN = fileURLToPath(new URL('../../../bin/e2e.js', import.meta.url))

/** The published subpath `NODE_OPTIONS` names. */
export const INSTRUMENT_SPECIFIER = '@spikedpunch/cbd/instrument'

export interface RunningService {
  proc: ChildProcess
  /** The port it chose, read from its own announcement. */
  port: number
  /** Everything it wrote to stdout and stderr. */
  output(): string
  stop(): void
}

/**
 * Starts a service the way a developer starts one.
 *
 * `NODE_OPTIONS` rather than an `--import` entry in `argv`, because that is the promise
 * being tested: ADR-0005 chose injection over debugger attachment precisely so that
 * there would be one variable to learn, and it is inherited down the process tree
 * rather than restated per process. An `--import` flag on the command line would also
 * have brought the instrument module up and would have proven less.
 *
 * Port 0 and an announcement on stdout, because a fixture must never collide with
 * whatever else the machine is doing.
 */
export function startService(
  dir: string,
  service: string,
  timeoutMs = 15_000,
): Promise<RunningService> {
  const proc = spawn(process.execPath, [service], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      NODE_OPTIONS: `--import ${INSTRUMENT_SPECIFIER}`,
      CBD_SOCKET_DIR: dir,
    },
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
      reject(new Error(`the service never announced a port. It wrote:\n${output}`))
    }, timeoutMs)

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
      reject(new Error(`the service exited with ${String(code)}. It wrote:\n${output}`))
    })
    // The announcement may already have arrived in the chunk that started this.
    settle()
  }).then((port) => ({
    proc,
    port,
    output: () => output,
    stop: () => proc.kill('SIGKILL'),
  }))
}

/** Runs a recorded suite, in its own process, against an already-started service. */
export function runSuite(
  mode: string,
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [BIN, mode], {
    cwd: PACKAGE_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * The environment an inner run needs: everything ambient, minus `NODE_OPTIONS`.
 *
 * The test process is deliberately *not* instrumented. Only the service is, so that
 * "there is one service" is a property of the fixture rather than of whatever
 * `NODE_OPTIONS` happened to be inherited from the ambient shell.
 */
export function ambientEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const { NODE_OPTIONS: _dropped, ...ambient } = process.env
  return { ...ambient, CBD_SOCKET_DIR: dir, ...extra }
}

/**
 * The environment an inner run needs when the *test process itself* is instrumented.
 *
 * `ambientEnv` drops `NODE_OPTIONS` so that the only instrumented process in a fixture is
 * the service the harness started — which is what makes "there is one service" a property
 * of the fixture rather than of the ambient shell. That is the right environment for a
 * suite that drives a service it was pointed at, and the wrong one for a suite that starts
 * services of its own: the claim there is that a child inherits the instrument module from
 * the test process (ADR-0005), and it can only inherit what the test process is carrying.
 *
 * The test process's own socket ends up in the same directory as the service's, which is
 * not an accident — it is the shape a real lane has, and it is what makes the collector's
 * own pid the one filter that has to hold (`cbd-0gw`).
 */
export function instrumentedEnv(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CBD_SOCKET_DIR: dir,
    NODE_OPTIONS: `--import ${INSTRUMENT_SPECIFIER}`,
    ...extra,
  }
}

export function readShard(name: string, path: string): ShardInput {
  return { name, records: parseShard(readFileSync(path, 'utf8'), path) }
}

/** The service's shard, beside the test process's — at the path the plugin derived. */
export function readServiceShard(shardPath: string, name = 'service'): ShardInput {
  return readShard(name, serviceShardPath(shardPath))
}

export function testsIn(shard: ShardInput): Extract<ShardRecord, { type: 'test' }>[] {
  return shard.records.filter(
    (record): record is Extract<ShardRecord, { type: 'test' }> => record.type === 'test',
  )
}

/** The pid a shard names as its own, which is how two shards are told from one. */
export function pidOf(shard: ShardInput): number | null {
  const first = shard.records[0]
  return first !== undefined && first.type === 'shard' ? first.pid : null
}

/** Where a file's execution was recorded: a test's window, or one of the buckets. */
export function bucketsHolding(shard: ShardInput, file: string): string[] {
  const out: string[] = []
  for (const record of shard.records) {
    if (record.type === 'shard' || record.type === 'end') continue
    const hit = record.touches.some((touch) => touch[0] === file)
    if (!hit) continue
    out.push(record.type === 'test' ? `test: ${record.title}` : `@${record.type}`)
  }
  return out
}

/**
 * A change at the top of a file, for asking the selector about it.
 *
 * Lines 1–2, which is where a module's body and its imports live — the part no
 * function range covers, so `select` falls through to the file-level rules rather than
 * to a function. That is the question these fixtures are asking: not "which function
 * changed" but "what does the map know about this file at all".
 */
export function changeTo(path: string) {
  return { path, status: 'M' as const, hunks: [{ start: 1, end: 2 }] }
}

/** The files a map has evidence for, by category — the residual, in one place. */
export function bucketFiles(shard: ShardInput, file: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const record of shard.records) {
    if (record.type === 'shard' || record.type === 'end') continue
    const key = record.type === 'test' ? `test: ${record.title}` : `@${record.type}`
    out[key] = record.touches.filter((touch) => touch[0] === file).map((touch) => touch[1])
  }
  return out
}
