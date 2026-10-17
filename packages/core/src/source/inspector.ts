/**
 * Coverage from a *separate* Node process, over the Chrome DevTools Protocol.
 *
 * This is what makes the target suite work. The stores suites are
 * `@japa/api-client` suites: they send HTTP requests, a server started
 * separately by `dev-cli lane up` handles them, and the code that actually
 * matters runs in that server's process. `inProcessSource` sees the test process
 * and nothing else, so a map built with it alone is blind to every server-side
 * change — and a change the map has never seen escalates to `mode: all` in
 * `select`. Gate B measured on such a map fails for an artefactual reason.
 *
 * ## What this file is, and is not
 *
 * It is the **contract**: the option shape, the security rule, the target
 * resolution, and the tests that pin the `Source` semantics for an
 * out-of-process implementation. It is not the CDP client — the WebSocket, the
 * `/json/list` walk, the `Profiler` domain calls, and the lock file are
 * `cbd-a3v`'s work, and `inspectorSource()` below rejects until it lands.
 *
 * Splitting it this way is deliberate. The contract is what `cbd-a3v`'s pieces
 * are written against, and it is the part a mistake is expensive in.
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
 *   - **Windows must not overlap.** japa runs one test at a time, so a run that
 *     issues the next take before the previous one has settled is a contract
 *     violation. The `Recorder` must report it rather than attribute the late
 *     result to whichever window happens to be open when it arrives.
 *   - **A take is a reset.** The delta is `since the previous take of either
 *     kind` — `takeSync()` and `take()` drain the same counter. Mixing them does
 *     not give two views of one window; it gives two half-windows.
 *
 * The first two are why `take()` could not simply be wired into the Recorder and
 * left to work: for an in-process source, async is a convenience; for this one it
 * is the only option, and getting it wrong is silent misattribution, which is the
 * under-selection failure this project treats as the unacceptable one.
 *
 * ## One runner per server
 *
 * Attribution is meaningless if two runners share one server — every window would
 * contain the other's requests. CBD cannot detect this from inside; the docs must
 * say it, and `cbd collect` must refuse to attach to a target another collector
 * already holds. That is a lock file keyed by the target origin, and it belongs to
 * `cbd-a3v` alongside the client.
 *
 * ## Multi-process servers
 *
 * A cluster or worker pool needs one `--inspect` port per process and one source
 * per port. v1 supports a list of targets; discovering them is the caller's job.
 */
import type { Source } from '../types.js'

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
        'if that is genuinely intended.',
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
 * Attach to a Node process started with `--inspect`, and report its coverage.
 *
 * **Not implemented.** Everything above resolves and validates; the CDP client —
 * `WebSocket`, `/json/list`, the `Profiler` and `Debugger` domains, and the
 * collector lock file — is `cbd-a3v`. Until it lands this rejects, having already
 * refused any target the security rule disallows, so the rule is exercised through
 * the real entry point rather than only through its own unit tests.
 */
export async function inspectorSource(options: InspectorSourceOptions): Promise<Source> {
  const target = resolveInspectorTarget(options)
  throw new InspectorTargetError(
    `inspectorSource: the contract is defined but the CDP client is not built ` +
      `(cbd-a3v). Target resolved to ${target.url ?? target.origin}.`,
  )
}
