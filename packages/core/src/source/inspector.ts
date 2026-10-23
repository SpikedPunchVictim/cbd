/**
 * Coverage from a *separate* Node process, over the Chrome DevTools Protocol.
 *
 * This is the fallback (ADR-0005). `socketSource` is the primary path: it reaches
 * anything `NODE_OPTIONS` can be set on, with no port to choose, discover or guard.
 * Attaching exists for a target whose environment genuinely cannot be set — a
 * process started by someone else, an image that rejects inherited options.
 *
 * ## What this file contains
 *
 * The contract (option shape, security rule, target resolution) and the CDP client:
 * the `/json/list` walk, one WebSocket speaking the `Profiler` and `Debugger`
 * domains, generated-text fetches, and the collector lock keyed by target origin.
 *
 * ## The hard part, stated plainly
 *
 * `Recorder` is synchronous end to end, and cannot stop being so: japa does not
 * await its lifecycle hooks (A0 F1), so an awaited take would land after the next
 * test had started and attribute one test's execution to another (see the
 * `Recorder` header). That is why `Source.takeSync()` exists at all.
 *
 * A socket cannot be synchronous. So an out-of-process source is the first
 * `Source` with `supportsSync === false`, and the Recorder has to consume it
 * through `take()` without awaiting it. The contract that makes that sound:
 *
 *   - **Dispatch time is the window boundary, not completion time.** `take()` is
 *     called while the window is open; the request must be *sent* immediately, so
 *     the peer's coverage reset happens at roughly the boundary the Recorder
 *     meant. The promise may settle later.
 *   - **Windows must not overlap in meaning, only in flight.** japa runs one test
 *     at a time, so a run that issues the next take before the previous one has
 *     settled is still asking for the windows in order — the counter is drained by
 *     each take, in the order the requests reach the target. `dispatch()` sends a
 *     boundary now and hands back a handle whose `settle()` resolves no earlier
 *     than the handles dispatched before it. `take()` remains for callers that can
 *     wait, and refuses a second outstanding take because a bare promise cannot say
 *     which window its reply belongs to.
 *   - **A take is a reset.** The delta is `since the previous take of either
 *     kind` — `takeSync()` and `take()` drain the same counter. Mixing them does
 *     not give two views of one window; it gives two half-windows.
 *
 * The second is why the Recorder needs `dispatch()` and not just `take()`: for an
 * in-process source, async is a convenience; for this one it is the only option,
 * and getting it wrong is silent misattribution, which is the under-selection
 * failure this project treats as the unacceptable one.
 *
 * ## One runner per server
 *
 * Attribution is meaningless if two runners share one server — every window would
 * contain the other's requests. CBD cannot detect this from inside, so the source
 * refuses to attach while another collector holds the target: a lock file under
 * the OS temp directory, keyed by the target origin and holding the owner's pid.
 *
 * ## Coverage before the attach
 *
 * `Profiler.startPreciseCoverage` begins counting when it is called. Work the
 * target did before that — start-up, module imports — is not in the first window
 * and cannot be recovered. The injected instrument covers a process from birth;
 * this source covers it from the attach.
 *
 * ## Multi-process servers
 *
 * A cluster or worker pool needs one `--inspect` port per process and one source
 * per port. Discovering them is the caller's job.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLineIndex } from '../line-index.js'
import { nowUs } from '../instrument-protocol.js'
import type {
  DriftStats,
  GeneratedScript,
  PendingTake,
  QueuedSource,
  ScriptInfo,
  V8ScriptCoverage,
} from '../types.js'

export const DEFAULT_INSPECTOR_HOST = '127.0.0.1'

/** How long to wait for a target to answer before giving up. */
export const DEFAULT_INSPECTOR_TIMEOUT_MS = 10_000

export interface InspectorSourceOptions {
  /**
   * A `ws://` debugger URL, exactly as the target printed it on stderr:
   * `Debugger listening on ws://127.0.0.1:9230/<uuid>`. Mutually exclusive with
   * `port`; use it when the caller already knows the URL, which is the case when
   * the port was discovered from a log line rather than chosen.
   */
  url?: string
  /** Host of the target's inspector port. Defaults to `127.0.0.1`. */
  host?: string
  /**
   * The target's inspector port. Required unless `url` is given. Mutually
   * exclusive with `url`. Note that `--inspect=0` means the port is chosen by the
   * OS and must be read back from the target's output; resolving that is the
   * caller's job, not this contract's.
   */
  port?: number
  /**
   * Attach to a host that is not loopback.
   *
   * `--inspect` is remote code execution for anyone who can reach the port. This
   * must be `true` *and* the caller must have meant it; it is not inferred from a
   * hostname that merely looks local.
   */
  allowRemote?: boolean
  /** Milliseconds to wait for the target to answer. */
  timeoutMs?: number
}

/** A resolved target. Built by {@link resolveInspectorTarget}. */
export interface InspectorTarget {
  /** `http://host:port` — where `/json/list` enumerates debuggable targets. */
  origin: string
  host: string
  port: number
  /**
   * Present only when the caller supplied `url` directly. Otherwise the WebSocket
   * URL is discovered from `/json/list`, because it carries a per-process UUID
   * that cannot be guessed from the port.
   */
  url?: string
}

/** Raised for a target that cannot or must not be attached to. */
export class InspectorTargetError extends Error {
  override readonly name = 'InspectorTargetError'
}

/**
 * The variable `cbd collect --target` uses to hand an attach target to the adapter.
 *
 * `--inspect` is remote code execution for anything that can reach the port, so this
 * is a variable a collector sets rather than one a suite is expected to inherit.
 */
export const INSPECT_ENV = 'CBD_INSPECT'

/** Set to `1` when the collector meant a non-loopback target. */
export const INSPECT_ALLOW_REMOTE_ENV = 'CBD_INSPECT_ALLOW_REMOTE'

/** Whether an environment value says `allowRemote`. Only `1`/`true`, never "any truthy string". */
export function allowRemoteFromEnv(value: string | undefined): boolean {
  return value !== undefined && /^(1|true)$/i.test(value)
}

/**
 * Whether a host names this machine's own loopback.
 *
 * Fails closed: anything unrecognised is *not* loopback, so it needs
 * `allowRemote`. `0.0.0.0` is deliberately not loopback — it is the bind-all
 * address, the opposite of a loopback-only bind.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (bare === 'localhost' || bare === '::1') return true
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare)
  if (octets === null) return false
  const parts = [octets[1], octets[2], octets[3], octets[4]].map(Number)
  if (parts.some((part) => part > 255)) return false
  return parts[0] === 127
}

/** IPv6 literals need brackets back before they go into a URL. */
function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

function portOf(url: URL): number {
  if (url.port !== '') return Number(url.port)
  if (url.protocol === 'ws:' || url.protocol === 'http:') return 80
  if (url.protocol === 'wss:' || url.protocol === 'https:') return 443
  throw new InspectorTargetError(`inspectorSource: ${url.href} has no usable port`)
}

/**
 * Turns options into a target, or explains why it will not.
 *
 * This is policy rather than mechanism, which is why it is implemented here while
 * the client is not: it is the part that has to be right before anything connects
 * to anything.
 */
export function resolveInspectorTarget(options: InspectorSourceOptions): InspectorTarget {
  // An empty string is not a URL; treating it as one would make `{ url: '' }` a
  // target with no host rather than a missing target.
  const url = options.url === '' ? undefined : options.url
  const port = options.port

  if (url !== undefined && port !== undefined) {
    throw new InspectorTargetError(
      'inspectorSource: give either `url` or `port`, not both — a target named two ' +
        'ways is a target whose security check cannot be reasoned about',
    )
  }
  if (url === undefined && port === undefined) {
    throw new InspectorTargetError(
      'inspectorSource: no target. Pass `url` (a ws:// debugger URL) or `port` ' +
        '(and optionally `host`).',
    )
  }

  const host = url === undefined ? (options.host ?? DEFAULT_INSPECTOR_HOST) : new URL(url).hostname

  if (!isLoopbackHost(host) && options.allowRemote !== true) {
    throw new InspectorTargetError(
      `inspectorSource: refusing to attach to ${host}. --inspect is remote code ` +
        'execution for anything that can reach the port; pass `allowRemote: true` ' +
        '(or --allow-remote) if that is genuinely intended.',
    )
  }

  if (url !== undefined) {
    const parsed = new URL(url)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new InspectorTargetError(
        `inspectorSource: \`url\` must be a ws:// or wss:// debugger URL, got ` +
          `${parsed.protocol}//. An http:// origin points at the /json/list index — ` +
          'pass `host` and `port` instead.',
      )
    }
    const wsPort = portOf(parsed)
    return {
      origin: `${parsed.protocol === 'wss:' ? 'https' : 'http'}://${hostForUrl(host)}:${wsPort}`,
      host,
      port: wsPort,
      url: parsed.href,
    }
  }

  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InspectorTargetError(
      `inspectorSource: port must be an integer in 1..65535, got ${String(options.port)}`,
    )
  }
  return { origin: `http://${hostForUrl(host)}:${port}`, host, port }
}

/**
 * Reads the value `--target` was given: `ws://host:port/<uuid>`, `host:port`, or a
 * bare port. The forms are resolved through {@link resolveInspectorTarget}, so a
 * remote host without `allowRemote` is refused here, before anything connects.
 */
export function parseInspectorTarget(value: string, allowRemote = false): InspectorSourceOptions {
  const text = value.trim()
  if (text === '') {
    throw new InspectorTargetError(
      'inspectorSource: empty target. Pass a ws:// debugger URL, host:port, or a port.',
    )
  }
  if (/^https?:\/\//i.test(text)) {
    throw new InspectorTargetError(
      `inspectorSource: ${text} is an http:// origin, which is the /json/list index ` +
        'rather than a debugger URL. Pass host:port instead.',
    )
  }

  // The last colon, so `[::1]:9229` keeps its host in one piece.
  const colon = text.lastIndexOf(':')
  const port = colon === -1 ? text : text.slice(colon + 1)
  if (!/^wss?:\/\//i.test(text) && !/^\d+$/.test(port)) {
    throw new InspectorTargetError(
      `inspectorSource: "${text}" is not a target. Pass a ws:// debugger URL, ` +
        'host:port, or a port.',
    )
  }
  const options: InspectorSourceOptions = /^wss?:\/\//i.test(text)
    ? { url: text }
    : colon === -1
      ? { port: Number(text) }
      : { host: text.slice(0, colon), port: Number(port) }
  if (allowRemote) options.allowRemote = true

  resolveInspectorTarget(options)
  return options
}

// ---------------------------------------------------------------------------
// The collector lock
// ---------------------------------------------------------------------------

interface LockRecord {
  pid: number
  origin: string
  token: string
}

/**
 * Where the lock for an origin lives.
 *
 * In the OS temp directory rather than the repository: two checkouts recording the
 * same server must conflict, and the server is a property of the host, not of
 * either checkout.
 */
export function inspectorLockPath(origin: string): string {
  const name = createHash('sha256').update(origin).digest('hex').slice(0, 16)
  return join(tmpdir(), 'cbd-inspector', `${name}.lock`)
}

function readLock(path: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string') return undefined
    return {
      pid: parsed.pid,
      origin: typeof parsed.origin === 'string' ? parsed.origin : '',
      token: parsed.token,
    }
  } catch {
    return undefined
  }
}

/**
 * Whether a process still exists. `EPERM` means it does, owned by someone else.
 *
 * A pid that is not a positive integer is never alive: a malformed lock is treated
 * as abandoned rather than as a permanent refusal to attach.
 */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The refusal a second collector gets, and the same words from the pre-flight check.
 */
function heldError(origin: string, pid: number): InspectorTargetError {
  return new InspectorTargetError(
    `inspectorSource: ${origin} is already being recorded by collector pid ` +
      `${String(pid)}. Two collectors on one target split its coverage counter, ` +
      'so neither map is correct; stop the other run, or use the injectable source.',
  )
}

/**
 * Refuses a target a live collector holds, without connecting.
 *
 * `cbd collect` runs this before spawning the suite, because the attach itself
 * happens in the test process: there the same refusal would reach the user as a
 * runner stack trace, after the suite had already started. A stale lock is left
 * alone — {@link inspectorSource} reclaims it.
 */
export function assertInspectorUnheld(options: InspectorSourceOptions): InspectorTarget {
  const target = resolveInspectorTarget(options)
  const holder = readLock(inspectorLockPath(target.origin))
  if (holder !== undefined && processAlive(holder.pid)) throw heldError(target.origin, holder.pid)
  return target
}

/**
 * One collector per target, enforced rather than documented.
 *
 * Two runners attached to one server split one `takePreciseCoverage` counter
 * between them: every window contains whichever requests the other runner's take
 * did not drain, and neither map is right. There is no safe degraded mode, so the
 * second attach is refused.
 *
 * **The stale case is the common one.** A collector that was killed leaves its
 * lock, and refusing forever would make a crashed run poison its target. A lock
 * whose pid is gone is removed and re-taken. The token is what makes the release
 * safe: a collector that lost the race for a stale lock must not unlink the file
 * its successor now owns.
 */
function acquireLock(origin: string): { release: () => void } {
  const path = inspectorLockPath(origin)
  try {
    mkdirSync(join(tmpdir(), 'cbd-inspector'), { recursive: true })
  } catch (error) {
    throw new InspectorTargetError(
      `inspectorSource: cannot create the lock directory for ${origin}: ${String(error)}`,
    )
  }

  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600)
      try {
        const record: LockRecord = { pid: process.pid, origin, token }
        writeSync(fd, JSON.stringify(record))
      } finally {
        closeSync(fd)
      }
      return {
        release: () => {
          const held = readLock(path)
          // Only the owner unlinks. After a stale takeover the token belongs to
          // someone else, and deleting their lock would allow a third collector in.
          if (held?.token !== token) return
          try {
            unlinkSync(path)
          } catch {
            // Already gone.
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new InspectorTargetError(
          `inspectorSource: cannot take the collector lock for ${origin}: ${String(error)}`,
        )
      }
      const holder = readLock(path)
      if (holder !== undefined && processAlive(holder.pid)) {
        throw heldError(origin, holder.pid)
      }
      // The holder is gone, or the file is unreadable. Re-read immediately before
      // removing it: between the observation and the unlink another collector may
      // have replaced a stale lock with a live one, and deleting that would admit a
      // second collector. This narrows the window rather than closing it — the
      // token in the record is what makes the *release* path exact — which is
      // acceptable for a lock that protects a local development run.
      const latest = readLock(path)
      const stale =
        holder === undefined
          ? latest === undefined
          : latest !== undefined && latest.token === holder.token && !processAlive(latest.pid)
      if (!stale) continue
      try {
        unlinkSync(path)
      } catch {
        // Someone else removed it first, which is also a retry.
      }
    }
  }
  throw new InspectorTargetError(
    `inspectorSource: lost the race for the collector lock on ${origin}; another ` +
      'collector attached at the same moment.',
  )
}

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

interface CdpError {
  code: number
  message: string
}

interface CdpMessage {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: CdpError
}

interface PendingCall {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * One WebSocket, one `id`-keyed request table.
 *
 * `send()` writes in the calling tick. That is not tidiness: dispatch time is the
 * window boundary, and a take that waited for `open` or for a previous reply would
 * fold one test's execution into its neighbour's window. `inspectorSource` awaits
 * the connection before returning, so every later call has an open socket.
 */
class CdpClient {
  #socket: WebSocket
  #timeoutMs: number
  #pending = new Map<number, PendingCall>()
  #nextId = 1
  #open = true
  #closed = false
  #onEvent: ((method: string, params: unknown) => void) | undefined

  static async connect(url: string, timeoutMs: number): Promise<CdpClient> {
    const socket = new WebSocket(url)
    // A permanent sink: the handlers below are removed once they have decided the
    // outcome, and an 'error' EventTarget event with no listener is not something to
    // rely on being silent.
    socket.addEventListener('error', () => {})
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
      }
      const timer = setTimeout(() => {
        done()
        try {
          socket.close()
        } catch {
          // Already gone.
        }
        reject(
          new InspectorTargetError(
            `inspectorSource: ${url} did not answer within ${String(timeoutMs)}ms`,
          ),
        )
      }, timeoutMs)
      const onOpen = (): void => {
        done()
        resolve()
      }
      const onError = (): void => {
        done()
        reject(new InspectorTargetError(`inspectorSource: cannot open ${url}`))
      }
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
    })
    return new CdpClient(socket, timeoutMs)
  }

  constructor(socket: WebSocket, timeoutMs: number) {
    this.#socket = socket
    this.#timeoutMs = timeoutMs
    socket.addEventListener('message', (event: MessageEvent) => {
      this.#settle(String(event.data))
    })
    socket.addEventListener('close', () => {
      this.#fail(new InspectorTargetError('inspectorSource: the debugger connection closed'))
    })
    socket.addEventListener('error', () => {
      this.#fail(new InspectorTargetError('inspectorSource: the debugger connection failed'))
    })
  }

  onEvent(handler: (method: string, params: unknown) => void): void {
    this.#onEvent = handler
  }

  #settle(text: string): void {
    let message: CdpMessage
    try {
      message = JSON.parse(text) as CdpMessage
    } catch {
      // The stream cannot be trusted to carry the next reply either.
      this.#fail(new InspectorTargetError('inspectorSource: unreadable message from the target'))
      return
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.#pending.delete(message.id)
      if (message.error !== undefined) {
        pending.reject(
          new InspectorTargetError(
            `inspectorSource: ${message.error.message} (CDP ${String(message.error.code)})`,
          ),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (message.method !== undefined) this.#onEvent?.(message.method, message.params)
  }

  #fail(error: Error): void {
    this.#open = false
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new InspectorTargetError('inspectorSource: the source is closed'))
    }
    if (!this.#open) {
      return Promise.reject(new InspectorTargetError('inspectorSource: the target is gone'))
    }
    const id = this.#nextId
    this.#nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(
          new InspectorTargetError(
            `inspectorSource: no reply to ${method} within ${String(this.#timeoutMs)}ms`,
          ),
        )
      }, this.#timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      this.#socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    // Id 0 is outside the request space, so the reply (if the socket flushes at
    // all) is dropped rather than resolving something. Ending the session also
    // releases the coverage state; losing this message is not a leak.
    try {
      this.#socket.send(JSON.stringify({ id: 0, method: 'Profiler.stopPreciseCoverage' }))
    } catch {
      // Already gone.
    }
    this.#fail(new InspectorTargetError('inspectorSource: the source is closed'))
    try {
      this.#socket.close()
    } catch {
      // Already gone.
    }
  }
}

interface ScriptParsed {
  scriptId: string
  url: string
  sourceMapURL?: string
}

interface TakePreciseCoverage {
  result: V8ScriptCoverage[]
}

interface ScriptSource {
  scriptSource: string
}

/**
 * The WebSocket URL for a target named by host and port.
 *
 * Node's debugger carries a per-process UUID in the path, so it cannot be derived
 * from the port; `/json/list` is the only way to learn it. The list is data from the
 * target, so its URL goes through the same loopback rule as a caller-supplied one.
 */
async function discoverDebuggerUrl(
  target: InspectorTarget,
  timeoutMs: number,
  allowRemote: boolean,
): Promise<string> {
  let list: unknown
  try {
    const response = await fetch(`${target.origin}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new InspectorTargetError(
        `inspectorSource: ${target.origin}/json/list answered ${String(response.status)}`,
      )
    }
    list = await response.json()
  } catch (error) {
    if (error instanceof InspectorTargetError) throw error
    throw new InspectorTargetError(
      `inspectorSource: cannot read ${target.origin}/json/list: ${String(error)}`,
    )
  }

  const entries = Array.isArray(list) ? list : []
  const entry = entries.find(
    (item): item is { webSocketDebuggerUrl: string } =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl === 'string',
  )
  if (entry === undefined) {
    throw new InspectorTargetError(
      `inspectorSource: ${target.origin}/json/list named no debuggable target. Is the ` +
        'process still running, and started with --inspect?',
    )
  }

  const parsed = new URL(entry.webSocketDebuggerUrl)
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new InspectorTargetError(
      `inspectorSource: /json/list returned ${parsed.protocol}// as a debugger URL`,
    )
  }
  if (!isLoopbackHost(parsed.hostname) && !allowRemote) {
    throw new InspectorTargetError(
      `inspectorSource: /json/list points at ${parsed.hostname}, which is not loopback; ` +
        'pass `allowRemote: true` if that is genuinely intended.',
    )
  }
  return parsed.href
}

/**
 * How often to ask a starting target for its pid.
 *
 * The gap is short because the wait is short: a target is identifiable as soon as
 * its bootstrap has run, which is milliseconds after the debugger line it prints.
 * Ten milliseconds costs a handful of round trips at worst and keeps an already
 * started target's attach indistinguishable from before.
 */
const PID_RETRY_MS = 10

/**
 * The target's pid, waiting out the window in which it does not have one yet.
 *
 * A process attached to while it is still bootstrapping answers
 * `Runtime.evaluate('process.pid')` with `undefined` rather than an error: the
 * execution context exists, but the global `process` has not had its fields
 * installed. There is no event that says the bootstrap finished, and attaching to
 * a target the moment it starts is the ordinary case for a service someone has
 * just brought up — so the question is repeated until the answer is a pid or the
 * caller's timeout runs out. Coverage is already counting from the earlier
 * `startPreciseCoverage`; nothing is lost by waiting.
 */
async function readTargetPid(client: CdpClient, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const reply = (await client.send('Runtime.evaluate', {
      expression: 'process.pid',
      returnByValue: true,
    })) as { result?: { value?: unknown } }
    const pid = reply.result?.value
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) return pid
    if (Date.now() >= deadline) {
      throw new InspectorTargetError(
        'inspectorSource: the target did not report a process id within ' +
          `${String(timeoutMs)}ms. Coverage would be written to a shard that names the ` +
          'wrong process, so the attach is refused. A target that is still starting ' +
          'may not have one yet; a target that is not a Node process never will.',
      )
    }
    await new Promise((resolve) => setTimeout(resolve, PID_RETRY_MS))
  }
}

/**
 * Attach to a Node process started with `--inspect`, and report its coverage.
 *
 * Refuses a target another collector holds (see `acquireLock`), then enables the
 * `Profiler` and `Debugger` domains and starts precise coverage. The returned
 * source is a `QueuedSource`: `dispatch()` is the boundary the `Recorder` sends
 * from a lifecycle hook it cannot await, and `settle()` reads the window later.
 *
 * **A take is a reset, exactly as for every other source.** `takePreciseCoverage`
 * returns and resets the isolate's counter, so windows partition one stream rather
 * than showing overlapping views. A second `take()` while one is outstanding is
 * refused: a bare promise cannot say which window a late reply belongs to.
 * `dispatch()` does not refuse — its handles carry the order the boundaries were
 * sent in, which is the same thing the socket source's chain guarantees.
 */
export async function inspectorSource(options: InspectorSourceOptions): Promise<QueuedSource> {
  const target = resolveInspectorTarget(options)
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSPECTOR_TIMEOUT_MS
  const allowRemote = options.allowRemote === true
  const lock = acquireLock(target.origin)

  let client: CdpClient | null = null
  try {
    const url = target.url ?? (await discoverDebuggerUrl(target, timeoutMs, allowRemote))
    const connected = await CdpClient.connect(url, timeoutMs)
    client = connected

    const scripts = new Map<string, ScriptInfo>()
    const missingGenerated = new Set<string>()
    let closed = false

    // Installed before `Debugger.enable`, which replays `scriptParsed` for every
    // script already compiled. That replay is what makes the first take's table
    // complete instead of starting from whatever loaded after the attach.
    connected.onEvent((method, params) => {
      if (method !== 'Debugger.scriptParsed') return
      const parsed = params as ScriptParsed
      scripts.set(parsed.scriptId, {
        url: parsed.url,
        ...(parsed.sourceMapURL === undefined ? {} : { sourceMapURL: parsed.sourceMapURL }),
      })
    })

    await connected.send('Profiler.enable')
    await connected.send('Debugger.enable')
    await connected.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false })

    // The shard header has to name the process the coverage came from, and a
    // debugger port says nothing about which pid is behind it. Asking the target is
    // the only answer that stays true when the port was forwarded or discovered.
    // `Runtime.evaluate` needs no `Runtime.enable`.
    const pid = await readTargetPid(connected, timeoutMs)

    /** Windows sent but not yet answered, and the chain keeping their order. */
    let outstanding = 0
    let nextSeq = 0
    let tail: Promise<void> = Promise.resolve()

    let driftWindows = 0
    let driftTotalUs = 0
    let driftMaxUs = 0
    let maxDepth = 0
    let lastSentUs: number | null = null
    let minGapUs = 0

    /**
     * Sends a boundary now and returns the handle for its window.
     *
     * The send is written in this tick, so the timestamp and the boundary are the
     * same event; only the reply is deferred. Nothing here refuses a second
     * dispatch, because a runner that cannot wait is exactly the caller this
     * exists for — and because the handles resolve in dispatch order, the windows
     * stay attributable.
     */
    function dispatch(): PendingTake {
      if (closed) throw new InspectorTargetError('inspectorSource: the source is closed')

      const sentAtUs = nowUs()
      const seq = nextSeq++
      outstanding += 1
      if (outstanding > maxDepth) maxDepth = outstanding

      // The gap belongs to what the suite asked for, so it is read at dispatch and
      // not when the reply lands.
      if (lastSentUs !== null) {
        const gap = sentAtUs - lastSentUs
        if (minGapUs === 0 || gap < minGapUs) minGapUs = gap
      }
      lastSentUs = sentAtUs

      const window = connected.send('Profiler.takePreciseCoverage').then((raw) => {
        // The closest thing to drift this transport can measure: how long the
        // boundary took to be answered. The socket source compares the peer's own
        // receive time with the send time; CDP reports no receive time, so this is
        // an upper bound rather than the same quantity.
        const driftUs = nowUs() - sentAtUs
        driftWindows += 1
        driftTotalUs += driftUs
        if (driftUs > driftMaxUs) driftMaxUs = driftUs
        return (raw as TakePreciseCoverage).result
      })

      const settled = window.finally(() => {
        outstanding -= 1
      })
      const previous = tail
      tail = settled.then(
        () => undefined,
        () => undefined,
      )

      return { seq, settle: () => previous.then(() => settled) }
    }

    return {
      kind: 'inspector',
      supportsSync: false,
      pid,

      takeSync(): V8ScriptCoverage[] {
        throw new InspectorTargetError(
          'inspectorSource.takeSync: a debugger round trip cannot complete inside the ' +
            'synchronous lifecycle hook this source is driven from. Use take().',
        )
      },

      async take(): Promise<V8ScriptCoverage[]> {
        if (closed) throw new InspectorTargetError('inspectorSource: the source is closed')
        if (outstanding > 0) {
          throw new InspectorTargetError(
            'inspectorSource: a take is already outstanding. take() cannot say which window ' +
              'a late reply belongs to, so a second one is refused rather than folded into ' +
              'the first. Wait for it, or use dispatch(), whose handles carry the window order.',
          )
        }
        return dispatch().settle()
      },

      dispatch,

      drift: (): DriftStats => ({
        windows: driftWindows,
        maxUs: driftMaxUs,
        meanUs: driftWindows === 0 ? 0 : driftTotalUs / driftWindows,
        maxDepth,
        minGapUs,
      }),

      scripts: () => scripts,
      generated: (scriptId: string): GeneratedScript | undefined =>
        scripts.get(scriptId)?.generated,
      generatedMissing: () => [...missingGenerated],

      /**
       * Fetch generated text for the recorded scripts, after the last window.
       *
       * Called by the recorder's `prepare()`, never at a boundary: a debugger round
       * trip inside a closing window lengthens that window and shows up as drift.
       * A script with no file URL is not transformed, and needs nothing.
       */
      async prepare(scriptIds: readonly string[]): Promise<void> {
        for (const scriptId of scriptIds) {
          if (closed) return
          const info = scripts.get(scriptId)
          if (info === undefined || info.generated !== undefined) continue
          if (!info.url.startsWith('file:')) continue
          try {
            const source = (await connected.send('Debugger.getScriptSource', {
              scriptId,
            })) as ScriptSource
            const index = buildLineIndex(source.scriptSource)
            info.generated = { lineStarts: index.starts, length: index.length }
          } catch {
            // The text is unavailable, so a loader-transformed script cannot be
            // converted against the file on disk. Recorded as health by the caller.
            missingGenerated.add(scriptId)
          }
        }
      },

      close(): void {
        if (closed) return
        closed = true
        connected.close()
        lock.release()
      },
    }
  } catch (error) {
    client?.close()
    lock.release()
    throw error
  }
}
