/**
 * The wire between an injected instrument module and the collector that reads it.
 *
 * Kept in its own file because two processes that never share memory have to
 * agree on it: the module compiles into the target (`@spikedpunch/cbd/instrument`,
 * run under `NODE_OPTIONS`), and `socketSource` reads it from the test process.
 * Both import these types, so a change to one is a compile error in the other
 * rather than a field that quietly stops arriving.
 *
 * **Framing is newline-delimited JSON.** One request or response per line, which
 * is enough because every message is small and self-contained, and it means a
 * partial read is only ever a partial line. Not length-prefixed, because the
 * payloads are counted in kilobytes and a framing bug is a much more expensive
 * mistake than a slightly larger read.
 *
 * **`take` carries three things, and the script table is the one that is easy to
 * forget.** The coverage delta says which functions ran; the script rows say what
 * each `scriptId` *is* — in particular its `sourceMapURL`, which
 * `V8ScriptCoverage` does not carry at all. Without it `createScriptResolver` has
 * no map to resolve through, so a compiled service's coverage can never be
 * projected back onto its TypeScript sources and the map is worthless on exactly
 * the builds that matter. The spike that proved injection worked returned function
 * names only, which is why this was called out as the first thing to build.
 *
 * The third is a receipt timestamp, which exists only so the collector can report
 * how far each boundary drifted from where it was meant to land — see `nowUs`.
 *
 * **The script table is incremental and one-shot.** `Debugger.scriptParsed` fires
 * once per script, when it is first parsed, so each row is sent exactly once and
 * the client accumulates. Sending the whole table on every take would be hundreds
 * of kilobytes per take at the target suite's scale — 1555 tests, 1555 takes —
 * for data that never changes after the first time.
 */
import { join } from 'node:path'
import type { V8ScriptCoverage } from './types.js'

export const INSTRUMENT_PROTOCOL = 1

/**
 * The in-process handshake, for the one case the wire cannot describe: a collector
 * running *inside* a process the module was injected into.
 *
 * `NODE_OPTIONS` is inherited by every Node process a suite starts (ADR-0005), and
 * that includes the test runner itself — there is no way to instrument a suite's
 * children without instrumenting the process that spawns them. But
 * `Profiler.takePreciseCoverage` returns and resets counters for the whole isolate,
 * so two coverage clients in one process split one stream of execution between
 * them: measured, a window that ran a function twice reports one call when the
 * other client took in between. In the collector's process the other client is the
 * module's 500 ms self-snapshot, and the loss is silent — every window a little
 * short, in the direction this project must never be wrong in.
 *
 * So the module publishes an off switch on the global it already uses for its
 * duplicate-import guard, and the in-process source calls it once it is collecting
 * for itself. The module stays loaded, which is what matters: its job in this
 * process is to be in the environment its children inherit, not to be read here.
 */
export interface InstrumentScope {
  /** Set once, by whichever instance started, so a second import cannot start another. */
  __cbdInstrumented?: true
  /**
   * The running module's off switch. Stops taking, removes the socket and any
   * snapshot, and leaves the process alone. Absent when the module is inert.
   */
  __cbdInstrument?: { stop: () => void }
}

/** One parsed script, as `Debugger.scriptParsed` reported it. */
export interface ScriptRow {
  id: string
  url: string
  sourceMapURL?: string
}

export interface HelloResult {
  protocol: number
  pid: number
  /**
   * What this process believes it is. Descriptive: defaults to `'service'` and
   * nothing filters on it, because the role is inherited exactly as `NODE_OPTIONS`
   * is and would hide the very services it was meant to describe. The collector's
   * own socket is kept out of the map by pid — see `InstrumentRole`.
   */
  role: string
  startedAt: string
  /** How many scripts have been parsed so far, for a cheap sanity check. */
  scriptCount: number
}

export interface TakeResult {
  /** The window since the previous take. `takePreciseCoverage` resets on read. */
  coverage: V8ScriptCoverage[]
  /** Scripts parsed since the previous take. Sent once each, in arrival order. */
  scripts: ScriptRow[]
  /**
   * When the peer received this take, on the clock `nowUs()` reads.
   *
   * Paired with the `sentAtUs` the client put on the request, this is the *drift*:
   * how far the boundary actually landed from where the caller meant it. That
   * number is the whole reason `cbd-a3v.3` exists — server work done during the
   * drift lands in the wrong window, and the direction it lands in bleeds a test's
   * execution into `@between`, which escalates. Reported rather than assumed.
   */
  atUs: number
}

/**
 * One take's coverage, kept by the instrument until the client says it arrived.
 *
 * The difference between this and `TakeResult` is the whole point of ADR-0007's
 * second mechanism: a write succeeding is not the same event as a client reading
 * it. `takeId` is the request id, and `sentAtUs` is the boundary the client meant,
 * so a collector that lost the reply can find that exact window again by number
 * instead of guessing from a lifetime.
 */
export interface SnapshotWindow {
  takeId: number
  sentAtUs?: number
  coverage: V8ScriptCoverage[]
}

/** What an instrumented process leaves beside its socket. */
export interface SnapshotFile {
  protocol: number
  pid: number
  /** `nowUs()` when the instrument module started. Comparable across processes. */
  startedAtUs: number
  /** `nowUs()` when this file was written. */
  atUs: number
  /** Set only on the write made by the exit handler. */
  endedAtUs?: number
  /** The full script table, so the harvester can resolve source maps. */
  scripts: ScriptRow[]
  /** Takes the client has not acknowledged. Ordered by `takeId`. */
  windows: SnapshotWindow[]
  /** Coverage taken since the last client take, and not yet in any window. */
  untaken: V8ScriptCoverage[]
}

/** The file the instrument writes, derived from the pid it belongs to. */
export function snapshotPath(dir: string, pid: number): string {
  return join(dir, `pid-${String(pid)}.coverage.json`)
}

export type InstrumentOp = 'hello' | 'take' | 'close' | 'ack'

export type InstrumentRequest =
  | { id: number; op: 'hello' }
  | { id: number; op: 'take'; sentAtUs?: number }
  | { id: number; op: 'close' }
  /** `ackId` is the last take the client has safely absorbed. */
  | { id: number; op: 'ack'; ackId: number }

export type InstrumentResponse =
  | { id: number; op: 'hello'; ok: true; result: HelloResult }
  | { id: number; op: 'take'; ok: true; result: TakeResult }
  | { id: number; op: 'close'; ok: true; result: { closing: true } }
  | { id: number; op: 'ack'; ok: true; result: { acked: number } }
  | { id: number; op: string; ok: false; error: string }

export function encodeMessage(message: InstrumentRequest | InstrumentResponse): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * Splits a byte stream into whole lines, keeping the remainder.
 *
 * `StringDecoder` is deliberately not used: the messages are JSON, the socket is
 * local, and every field the collector actually relies on — script ids, urls,
 * paths — is ASCII. A multi-byte character split across two reads would corrupt
 * at most a function name, and the cost of buffering bytes to be safe is paid on
 * every take.
 */
export class LineSplitter {
  #buffer = ''

  push(chunk: string): string[] {
    this.#buffer += chunk
    const lines: string[] = []
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      lines.push(this.#buffer.slice(0, newline))
      this.#buffer = this.#buffer.slice(newline + 1)
      newline = this.#buffer.indexOf('\n')
    }
    return lines
  }
}

/** The env var that turns the injected module on. Unset means fully inert. */
export const SOCKET_DIR_ENV = 'CBD_SOCKET_DIR'

/**
 * A microsecond clock two processes on one host can compare.
 *
 * `Date.now()` is the obvious choice and is the wrong one: its millisecond
 * resolution is coarser than the quantity being measured. A unix-socket hop is
 * tens of microseconds, so a millisecond clock reports the drift as 0 or 1 and
 * says nothing.
 *
 * `process.hrtime.bigint()` is nanoseconds since an unspecified origin, and on
 * Linux and macOS Node sources it from `CLOCK_MONOTONIC`, which the kernel reads
 * once per machine rather than once per process. So two processes on the same
 * host are on the same origin. That is a property of the platform rather than
 * something this module can enforce, so it is *checked* rather than believed:
 * `socket-source.spec.ts` asserts the measured drift is small and non-negative,
 * which a pair of unrelated clocks could not produce.
 *
 * Divided down to microseconds because nanoseconds since boot overflow
 * `Number.MAX_SAFE_INTEGER` after about 104 days of uptime, and a counter that
 * silently loses precision on a long-lived box is a worse bug than the
 * resolution it buys back.
 */
export function nowUs(): number {
  return Number(process.hrtime.bigint() / 1000n)
}

/** Overrides the role a process announces. See `InstrumentRole`. */
export const ROLE_ENV = 'CBD_ROLE'

/**
 * What a process announces itself as — **descriptive, not a permission**.
 *
 * `NODE_OPTIONS` is inherited, so the instrument module loads in *every* Node
 * process in the tree — the service, its workers, and the test runner itself. The
 * runner's own coverage is already taken in-process by the adapter's source, so a
 * socket from it is not merely redundant: read by the collector it would double
 * every touch the test process produced.
 *
 * What keeps that socket out of the collector is the **pid**, and it has to be.
 * A role is inherited exactly as `NODE_OPTIONS` is, so a service the test process
 * starts for itself announces whatever the test process announces: filtering on it
 * would not separate the service from its client, it would hide the service, and
 * silently — discovery would keep succeeding, then stop, with nothing to report.
 * The hello still says what the process thinks it is, the shard still carries it,
 * and a reader may still find it useful; nothing decides on it (ADR-0007).
 */
export type InstrumentRole = 'service' | 'runner'

export function resolveRole(env: NodeJS.ProcessEnv = process.env): string {
  return env[ROLE_ENV] ?? 'service'
}
