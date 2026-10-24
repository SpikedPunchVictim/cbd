/**
 * Request-id correlation: the join between a test's window and work an
 * out-of-process service does for it.
 *
 * `cbd-a3v.3` attributes server execution to a test *by time*: the collector takes
 * a window from the service at each test boundary, so whatever the service ran
 * while that window was open is credited to the test whose window it was. That is
 * exact when the test awaits its request, and wrong in the direction that matters
 * when it does not: a request still in flight when the test ends, or a response
 * that arrives during the next test, lands in whichever window happens to be open.
 *
 * A request id carried on the request lets the two sides join by identity rather
 * than by time. There are three pieces, and all three are needed:
 *
 *   1. **A test-side id.** `Correlator` names each test window and remembers which
 *      test owns each name. `installRequestIds` puts that name on every outgoing
 *      `http`/`https`/`fetch` call made while the window is open.
 *   2. **A service-side boundary.** The injected instrument patches
 *      `http.Server.prototype.emit` and takes a coverage delta at the start and end
 *      of each correlated request, tagging the delta with the ids that were in
 *      flight for that interval (`source/instrument.ts`).
 *   3. **A join.** The service source carries those tagged deltas back in the take
 *      reply; the `Recorder` writes each one as a `test` record for its owner.
 *
 * **Framework-neutral by construction.** The service hook is on Node's own
 * `http.Server`, below Express, Fastify, Koa and a bare `createServer`, so no
 * per-framework adapter is needed. HTTP/2 servers (`http2.createServer`) and
 * clients that bypass the `http` module (a raw `undici` dispatcher) are not
 * covered, and that is named rather than hidden: their work falls back to the
 * time-based attribution that already exists, which over-selects rather than
 * dropping it.
 *
 * **An id the collector does not know is not a guess.** If the service tags a
 * window with an id no test window owns — a request from another client, a test
 * from a previous run — the recorder files that coverage under `@between`, which
 * §8.3 escalates. The alternative, dropping it, is under-selection.
 *
 * **Injection never overwrites an explicit header.** A test that sets the header
 * itself has said which identity it wants that request to carry; the adapter
 * supplies one only when the caller did not.
 */
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import {
  CORRELATION_ENV,
  CORRELATION_HEADER,
  CORRELATION_HEADER_ENV,
} from './instrument-protocol.js'

// The names live in the wire-contract module so the injected instrument can read
// them without importing this one (and with it `https`/`tls`). Re-exported here
// because this is where a test-side caller looks for them.
export { CORRELATION_ENV, CORRELATION_HEADER, CORRELATION_HEADER_ENV }

/** Which test a correlation id belongs to. The shape a shard record needs. */
export interface CorrelatedTest {
  title: string
  file: string | null
  /** The repeated-title discriminator the recorder assigned to this window. */
  ordinal?: number
}

/** The question the recorder asks of a correlation id. */
export interface OwnerIndex {
  ownerOf(id: string): CorrelatedTest | undefined
}

/**
 * The run's correlation ids, and which test each one belongs to.
 *
 * The id is a process-qualified counter rather than a UUID. It only has to be
 * unique among the ids a service could echo back during one run, and a counter
 * makes a shard readable by hand — which is worth more here than collision
 * resistance across runs, since an id from an earlier run is not a collision: the
 * current registry simply does not own it, and the recorder files it under
 * `@between`.
 */
export class Correlator implements OwnerIndex {
  readonly #owners = new Map<string, CorrelatedTest>()
  readonly #ordinals = new Map<string, number>()
  #current: string | undefined
  #next = 0
  #release: (() => void) | null = null

  /**
   * Opens a window, or returns the one already open.
   *
   * Idempotent because more than one recorder is driven from the same lifecycle
   * event: the test process and the service both hear `test:start`, and only one of
   * them may consume an id. The caller that drives several recorders calls this
   * once, and the idempotence is the guard against a future one that forgets.
   */
  begin(title: string, file: string | null): string {
    if (this.#current !== undefined) return this.#current
    this.#next += 1
    const id = `${String(process.pid)}-${String(this.#next)}`
    // Mirror the recorder's ordinal: the map keys a test by file, title and
    // ordinal, and a correlated record without one merges into the first duplicate.
    const key = `${title}\u0000${file ?? ''}`
    const ordinal = this.#ordinals.get(key) ?? 0
    this.#ordinals.set(key, ordinal + 1)
    this.#owners.set(id, { title, file, ...(ordinal === 0 ? {} : { ordinal }) })
    this.#current = id
    return id
  }

  /** Closes the window: requests made after this carry no id until the next test. */
  end(): void {
    this.#current = undefined
  }

  current(): string | undefined {
    return this.#current
  }

  ownerOf(id: string): CorrelatedTest | undefined {
    return this.#owners.get(id)
  }

  /** How many ids this run has named, for a test to assert the shape of a run. */
  get size(): number {
    return this.#owners.size
  }

  /**
   * Puts `header` on outgoing requests made while a window is open.
   *
   * Only the client side is patched here. The service side is the instrument's
   * job (`instrument.ts`), and it is deliberately the other process's: a service
   * that is never attached to, or runs on an older instrument, simply produces
   * time-based windows and the collector's answer is as good as it was before.
   */
  install(header: string = CORRELATION_HEADER): void {
    if (this.#release !== null) return
    const correlator = this
    const restore: Array<() => void> = []

    const patch = (
      target: Record<string, unknown>,
      name: string,
    ): void => {
      const original = target[name]
      if (typeof original !== 'function') return
      const patched = function (this: unknown, ...args: unknown[]): unknown {
        const id = correlator.current()
        if (id === undefined) return (original as (...a: unknown[]) => unknown).apply(this, args)
        return (original as (...a: unknown[]) => unknown).apply(this, inject(args, header, id))
      }
      target[name] = patched
      restore.push(() => {
        // Restore only what is still ours: someone else may have wrapped the
        // module since, and clobbering their wrapper would be a worse bug than
        // leaving this one in place.
        if (target[name] === patched) target[name] = original
      })
    }

    patch(http as unknown as Record<string, unknown>, 'request')
    patch(http as unknown as Record<string, unknown>, 'get')
    patch(https as unknown as Record<string, unknown>, 'request')
    patch(https as unknown as Record<string, unknown>, 'get')
    // A named ESM import of a builtin (`import { request } from 'node:http'`) is a
    // snapshot taken at link time; patching the default export alone leaves it
    // calling the original, untagged. The read tracker does the same for `fs`.
    syncBuiltinESMExports()

    // `fetch` is a global rather than a module export. Node >= 18 always has one.
    const originalFetch = globalThis.fetch
    if (typeof originalFetch === 'function') {
      const patchedFetch = function (
        input: Parameters<typeof originalFetch>[0],
        init?: Parameters<typeof originalFetch>[1],
      ): Promise<Response> {
        const id = correlator.current()
        if (id === undefined) return originalFetch(input, init)
        // A Request carries its own header list; `new Headers(init?.headers)`
        // alone would replace it with correlation only. Merge both sources.
        const base =
          typeof Request === 'function' && input instanceof Request ? input.headers : undefined
        const headers = new Headers(base)
        if (init?.headers !== undefined) {
          new Headers(init.headers).forEach((value, key) => headers.set(key, value))
        }
        if (!headers.has(header)) headers.set(header, id)
        if (typeof Request === 'function' && input instanceof Request) {
          return originalFetch(new Request(input, { ...init, headers }))
        }
        return originalFetch(input, { ...init, headers })
      }
      globalThis.fetch = patchedFetch
      restore.push(() => {
        if (globalThis.fetch === patchedFetch) globalThis.fetch = originalFetch
      })
    }

    this.#release = () => {
      for (const undo of restore.reverse()) undo()
      // The named bindings were re-pointed at the patches above; without this they
      // would keep calling them after the run asked for them to be gone.
      syncBuiltinESMExports()
    }
  }

  /** Undoes `install`. Safe to call when nothing is installed. */
  release(): void {
    const release = this.#release
    this.#release = null
    if (release !== null) release()
  }
}

function isOptions(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * A Node request call with the header added, without changing its overload.
 *
 * `http.request` accepts `(options[, callback])`, `(url[, options][, callback])`
 * and a URL object in place of the string; the injection has to land in the right
 * position or the callback becomes an options object. The options object is
 * copied rather than mutated because a caller may reuse it for later requests.
 */
function inject(args: unknown[], header: string, id: string): unknown[] {
  if (hasHeader(args, header)) return args

  const first = args[0]
  if (typeof first === 'string' || first instanceof URL) {
    const second = args[1]
    if (typeof second === 'function') {
      return [first, { headers: { [header]: id } }, ...args.slice(1)]
    }
    if (second === undefined) {
      // `(url, undefined, cb)` keeps the callback in the third slot; passing the
      // undefined through would make Node read it as the options object and drop
      // the callback entirely.
      const rest = args.slice(1)
      if (rest[0] === undefined) rest.shift()
      return [first, { headers: { [header]: id } }, ...rest]
    }
    if (isOptions(second)) {
      return [first, withHeader(second, header, id), ...args.slice(2)]
    }
    return args
  }
  if (isOptions(first)) return [withHeader(first, header, id), ...args.slice(1)]
  return args
}

function hasHeader(args: unknown[], header: string): boolean {
  for (const candidate of args) {
    if (!isOptions(candidate)) continue
    const headers = candidate.headers
    if (headers === undefined) continue
    if (Array.isArray(headers)) {
      if (headers.some((line) => namesHeader(line, header))) return true
      continue
    }
    if (isOptions(headers)) {
      if (Object.keys(headers).some((key) => key.toLowerCase() === header)) return true
    }
  }
  return false
}

function namesHeader(line: unknown, header: string): boolean {
  if (typeof line !== 'string') return false
  const colon = line.indexOf(':')
  return colon !== -1 && line.slice(0, colon).trim().toLowerCase() === header
}

function withHeader(
  options: Record<string, unknown>,
  header: string,
  id: string,
): Record<string, unknown> {
  const headers = options.headers
  let merged: unknown
  if (headers === undefined) {
    merged = { [header]: id }
  } else if (Array.isArray(headers)) {
    merged = [...headers, `${header}: ${id}`]
  } else if (isOptions(headers)) {
    merged = { ...headers, [header]: id }
  } else {
    merged = { [header]: id }
  }
  return { ...options, headers: merged }
}
