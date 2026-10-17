/**
 * Launching the fixture service for tests that need a real second process.
 *
 * Shared because three specs now need one — the instrument wire, `socketSource`,
 * and whatever the multi-process work adds — and a second copy of the spawn
 * arguments is where a difference in `NODE_OPTIONS` or the socket directory would
 * hide.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { socketSource } from '../../src/source/socket.js'
import type { QueuedSource } from '../../src/types.js'

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** `tests/service/main.ts`, compiled. Imports nothing from CBD, by design. */
export const SERVICE = fileURLToPath(new URL('../service/main.js', import.meta.url))

/**
 * The published subpath, so a spec fails if `./instrument` is missing from the
 * package exports — the difference between a module that exists and one that can
 * be reached.
 */
export const INSTRUMENT_SPECIFIER = '@spikedpunch/cbd/instrument'

export interface RunningService {
  proc: ChildProcess
  dir: string
  socketPath: string
  /** Resolves once the service has announced itself on stdout. */
  ready: Promise<void>
  /** stdout and stderr, concatenated — the module under test must write to neither. */
  output(): string
  run(command: string): void
  stop(): void
}

export function launchService(env: NodeJS.ProcessEnv = {}): RunningService {
  // Three cases, and the second is the one that bites. A plain call gets a fresh
  // temp directory. A caller that passes `CBD_SOCKET_DIR` owns that directory —
  // which is how two services are put in one place to test discovery. An explicit
  // `undefined` means "leave it unset", which is how the inertness test asks for a
  // service that must not open a socket at all; spreading `env` would leave the
  // variable absent and then a `?? dir` would quietly set it again, so it has to be
  // handled rather than defaulted.
  const inert = 'CBD_SOCKET_DIR' in env && env.CBD_SOCKET_DIR === undefined
  const dir = inert ? mkdtempSync(join(tmpdir(), 'cbd-service-')) : (env.CBD_SOCKET_DIR ?? mkdtempSync(join(tmpdir(), 'cbd-service-')))

  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env }
  if (inert) delete childEnv.CBD_SOCKET_DIR
  else childEnv.CBD_SOCKET_DIR = dir

  const proc = spawn(process.execPath, ['--import', INSTRUMENT_SPECIFIER, SERVICE], {
    cwd: PACKAGE_ROOT,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let output = ''
  const ready = new Promise<void>((resolve) => {
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      output += chunk
      if (output.includes('ready')) resolve()
    })
    proc.stderr?.on('data', (chunk: string) => {
      output += chunk
    })
  })

  return {
    proc,
    dir,
    socketPath: join(dir, `pid-${String(proc.pid)}.sock`),
    ready,
    output: () => output,
    run: (command) => proc.stdin?.write(`${command}\n`),
    stop: () => proc.kill('SIGKILL'),
  }
}

/** Runs `body` with one service, and always tears both it and the directory down. */
export async function withService(
  env: NodeJS.ProcessEnv,
  body: (service: RunningService) => Promise<void>,
): Promise<void> {
  const service = launchService(env)
  try {
    await service.ready
    await body(service)
  } finally {
    service.stop()
    rmSync(service.dir, { recursive: true, force: true })
  }
}

/**
 * One service, one source, both torn down.
 *
 * A service left alive holds the parent's stdio pipes open, so the test process
 * finishes its suite and then never exits — which looks exactly like a hang, with
 * no output to say why. Every test that starts a service kills it, and this is
 * here so none of them has to remember to.
 */
export async function withSource(
  env: NodeJS.ProcessEnv,
  body: (source: QueuedSource, service: RunningService) => Promise<void>,
): Promise<void> {
  await withService(env, async (service) => {
    await waitForSocket(service.socketPath)
    const source = await socketSource({ dir: service.dir, timeoutMs: 5_000 })
    try {
      await body(source, service)
    } finally {
      source.close()
    }
  })
}

export async function waitForSocket(socketPath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`socket ${socketPath} never appeared`)
}
