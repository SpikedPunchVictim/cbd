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
import { join, resolve } from 'node:path'
import type { GeneratedScript, V8ScriptCoverage } from './types.js'

/**
 * Not bumped when `TakeResult` gained `reads`/`dirReads` or the snapshot gained
 * `reads`/`untakenReads`. A mismatch is a hard failure on both sides (`hello` throws,
 * and a snapshot of another version is refused by recovery), so a bump would make an
 * older instrument unusable to gain a field that is optional everywhere. Every one of
 * these fields may be absent: an instrument that predates them reports no reads, which
 * is the old behaviour, and a collector treats an absent field as "none". Bump only for
 * a change an older peer would misread rather than ignore.
 */
export const INSTRUMENT_PROTOCOL = 1

/**
 * The header a correlated request carries, and the environment variables that
 * turn correlation on.
 *
 * Declared here rather than in `correlate.ts` because this module is the wire
 * contract and has no runtime imports: the injected instrument reads the env name
 * from it without pulling the test-side HTTP client patch (and `https`/`tls`) into
 * every instrumented service. Measured, that extra module load was visible in the
 * first take's cost on the fixture that measures boundary drift.
 */
export const CORRELATION_HEADER = 'x-cbd-correlation'
export const CORRELATION_HEADER_ENV = 'CBD_CORRELATION_HEADER'
export const CORRELATION_ENV = 'CBD_CORRELATION'

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
   *
   * It **returns what it had already consumed** — the coverage its self-snapshots
   * took since the process started, which no client has read. The collector in
   * this process starts its own session only after the module stands down, so
   * without the handoff everything that ran before that moment (the test
   * runner's static imports, most importantly) is gone from the isolate counters
   * with nobody to receive it. That was `cbd-1ci`: a module loaded during the
   * import phase and never executed again left no evidence, so a change to it
   * escalated through `unknown-file` although the run had loaded it.
   */
  __cbdInstrument?: { stop: () => Promise<V8ScriptCoverage[]> }
}

/** One parsed script, as `Debugger.scriptParsed` reported it. */
export interface ScriptRow {
  id: string
  url: string
  sourceMapURL?: string
  /**
   * Generated line starts, for a loader-transformed script.
   *
   * The service's inspector answers `Debugger.getScriptSource` synchronously; the
   * module records the line starts only when it had to send an injected map,
   * because that is the case where the file on disk is not the text V8 compiled
   * (`cbd-x2j`). The collector's `socketSource` carries this into `ScriptInfo`.
   */
  generated?: GeneratedScript
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
  /**
   * Whether this process is already taking request boundaries.
   *
   * True when it inherited `CBD_CORRELATION_HEADER` from a recording test process.
   * The collector uses it to skip the `correlate` op — one round trip it does not
   * need, on a path where the difference between attaching inside the test that
   * started the process and attaching during the next one is a whole window of
   * attribution.
   *
   * Absent from an instrument older than this field, which is indistinguishable
   * from `false` for that caller: it sends the op, and an old instrument answers
   * that it does not know it.
   */
  correlating?: boolean
  /**
   * The header name this process is correlating for, when it is correlating.
   *
   * `correlating` alone says "some header"; a collector that asked for a different
   * name would skip its `correlate` op and then receive no request windows. The
   * echo is what lets the collector compare instead of assume.
   */
  correlationHeader?: string
  /**
   * The collector's run session, echoed from the hello.
   *
   * A source makes one id per run and sends it with the hello, so a snapshot
   * window can say which run produced it. Take ids restart at 1 per client and
   * `sentAtUs` is meaningful only within one process lifetime, so without this a
   * later run can substitute an earlier run's execution for a lost window. Absent
   * from an instrument older than this field, and then the source does not recover
   * from snapshots at all: it reports the loss instead of substituting a run it
   * cannot identify.
   */
  session?: string
}

/**
 * A delta the instrument took on its own initiative, at a correlated request's
 * boundary.
 *
 * `ids` are the request ids that were in flight for the interval, so the collector
 * can join the delta to the tests that sent those requests. A window with no id
 * is never sent as one of these: it is ordinary coverage, delivered with the next
 * take and attributed by time exactly as before.
 */
export interface RequestWindow {
  ids: string[]
  coverage: V8ScriptCoverage[]
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
  /**
   * Correlation ids in flight when this boundary was crossed.
   *
   * `coverage` ran while these requests were open, so the recorder credits it to
   * those tests as well as to the window it was taken for. That double credit is
   * deliberate: it is what keeps a request's work from being lost when another
   * test's boundary happens to take it first.
   */
  ids?: string[]
  /** Request-boundary windows taken since the previous reply. */
  requests?: RequestWindow[]
  /**
   * Files the process read since the previous take.
   *
   * A service reads a routing table, a config, a fixture — data whose change must
   * select the tests that drove it, and which no function in the map names. The
   * paths are canonical, the same spelling the build keys its map by, and they are
   * attributed to the boundary that closes here exactly as coverage is.
   */
  reads?: string[]
  /** Directories the process listed since the previous take. */
  dirReads?: string[]
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
  /**
   * The run session of the collector this take was served for.
   *
   * Recovery compares it, so a window left by a collector that died is never
   * offered to the next run. A window without one — written by an instrument older
   * than this field — is not recoverable either, for the same reason.
   */
  session?: string
  coverage: V8ScriptCoverage[]
  /**
   * The script rows this take delivered. Kept with the window until it is
   * acknowledged, so a lost reply can still be resolved without the snapshot
   * carrying the whole table (see `SnapshotFile.scripts`).
   */
  scripts?: ScriptRow[]
  /**
   * The correlation tags this take's reply carried, kept for the same reason as
   * the coverage: a reply that never arrived is recovered by take id, and a
   * recovered window that dropped its ids would credit a request's work to
   * whatever boundary happened to recover it.
   */
  ids?: string[]
  requests?: RequestWindow[]
  /**
   * The files the process read during this window, kept for the same reason as the
   * coverage: a recovered window that dropped its reads would lose the file
   * dependencies of exactly the window whose reply was lost. Absent in a snapshot
   * written before this field existed, which reads as none.
   */
  reads?: string[]
  dirReads?: string[]
}

/** What an instrumented process leaves beside its socket. */
export interface SnapshotFile {
  protocol: number
  pid: number
  /** `nowUs()` when the instrument module started. Comparable across processes. */
  startedAtUs: number
  /**
   * The most recent collector session this process served.
   *
   * A file without one predates sessions, and its windows cannot be attributed to a
   * run; recovery refuses it rather than guessing. The unnumbered fallback
   * (`untaken`/`pendingRequests`) is similarly offered only to this session.
   */
  session?: string
  /** `nowUs()` when this file was written. */
  atUs: number
  /** Set only on the write made by the exit handler. */
  endedAtUs?: number
  /**
   * The script rows the harvester may not have: those in unacknowledged windows,
   * plus any parsed since the last take.
   *
   * **Not the full table, deliberately.** It used to be, and on a lane server the
   * table is 4770 rows and 12 MB, rewritten after every served take on the
   * process's own loop — measured as ~1 ms added to every boundary (`cbd-3z1`).
   * A take's reply carries its rows, and an acknowledged take is one the
   * collector has absorbed, so repeating those rows in the snapshot buys nothing.
   * What must survive a death is the part no reply has delivered, which is small
   * after the first ack and is the whole table before it.
   */
  scripts: ScriptRow[]
  /** Takes the client has not acknowledged. Ordered by `takeId`. */
  windows: SnapshotWindow[]
  /**
   * Coverage taken since the last client take, and not yet in any window.
   *
   * **Present only on the exit write.** The per-take and periodic files are bounded
   * to what a lost take can be recovered from *by id* — its window and the script
   * rows no reply has delivered. The accumulator is not one of those things: it can
   * hold thousands of request windows, and rewriting it every 500 ms reached 398 MB
   * and ~97% of a CPU on a real suite (`cbd-n9t.2`). A process that dies with only
   * the bounded file loses the last partial window and the run's shard is refused;
   * a live process whose write never reached the instrument keeps the accumulator,
   * and the next successful take carries it.
   */
  untaken?: V8ScriptCoverage[]
  /**
   * Request-boundary windows taken since the last take was served.
   *
   * They have no take id yet — they are delivered with the next reply — so they
   * cannot be recovered by number. They are kept in the **exit** write so a
   * process that dies before that reply is read still leaves their coverage with
   * the ids that owned it; the unnumbered fallback in `recoverWindow` reads them
   * there. The periodic file omits them for the same reason it omits `untaken`:
   * they are unbounded between boundaries (`cbd-n9t.2`), and the next take
   * delivers them while the process is alive.
   */
  pendingRequests?: RequestWindow[]
  /**
   * Files read since the last take, in the exit write only.
   *
   * The same exit-only bound as `untaken`: they are what a process that read a file
   * and then died leaves behind, and a harvest that returned coverage without them
   * would drop the dependency.
   */
  untakenReads?: string[]
  untakenDirReads?: string[]
}

/** The file the instrument writes, derived from the pid it belongs to. */
export function snapshotPath(dir: string, pid: number): string {
  return join(dir, `pid-${String(pid)}.coverage.json`)
}

export type InstrumentOp = 'hello' | 'take' | 'close' | 'ack' | 'correlate' | 'generated'

export type InstrumentRequest =
  /** `session` names this run; see `HelloResult.session`. */
  | { id: number; op: 'hello'; session?: string }
  | { id: number; op: 'take'; sentAtUs?: number }
  | { id: number; op: 'close' }
  /** `ackId` is the last take the client has safely absorbed. */
  | { id: number; op: 'ack'; ackId: number }
  /**
   * Turns on request-id correlation and names the header to read.
   *
   * An operation rather than an environment variable because the collector is
   * the side that knows correlation is wanted, and a separately started service's
   * environment is not the collector's to change (ADR-0005's rule that the
   * service is started the way a developer starts one). The op is idempotent: a
   * rescanning source may configure the same process once when it attaches and
   * never again, but a second collector is not an error.
   */
  | { id: number; op: 'correlate'; header: string }
  /**
   * Generated line starts for named scripts, fetched after the last window.
   *
   * The end-of-run request is the one place a source read is outside every test
   * window. Asking at a take would lengthen that boundary; asking at scriptParsed
   * puts the read inside whatever window happens to be open (`cbd-x2j`).
   */
  | { id: number; op: 'generated'; ids: string[] }

export type InstrumentResponse =
  | { id: number; op: 'hello'; ok: true; result: HelloResult }
  | { id: number; op: 'take'; ok: true; result: TakeResult }
  | { id: number; op: 'close'; ok: true; result: { closing: true } }
  | { id: number; op: 'ack'; ok: true; result: { acked: number } }
  | { id: number; op: 'correlate'; ok: true; result: { header: string } }
  | {
      id: number
      op: 'generated'
      ok: true
      result: {
        generated: Record<string, GeneratedScript>
        /**
         * Script ids whose generated text this process could not produce.
         *
         * A loader-transformed script's offsets cannot be converted against the file
         * on disk, so the build needs to know that the text it wanted is missing
         * rather than fall back silently (`cbd-x2j`). Absent from an instrument older
         * than this field; the source derives the same set from the reply.
         */
        missing?: string[]
      }
    }
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
  /** The unfinished line, in the pieces it arrived in. Joined once its newline comes. */
  #pending: string[] = []

  push(chunk: string): string[] {
    const lines: string[] = []
    let from = 0
    // Only the new chunk is searched: re-scanning the buffered head on every chunk
    // made one huge line quadratic in its size.
    let newline = chunk.indexOf('\n', from)
    while (newline !== -1) {
      this.#pending.push(chunk.slice(from, newline))
      lines.push(this.#pending.join(''))
      this.#pending = []
      from = newline + 1
      newline = chunk.indexOf('\n', from)
    }
    if (from < chunk.length) this.#pending.push(from === 0 ? chunk : chunk.slice(from))
    return lines
  }
}

/** The env var that turns the injected module on. Unset means fully inert. */
export const SOCKET_DIR_ENV = 'CBD_SOCKET_DIR'

/**
 * The socket directory from `env`, as an absolute path.
 *
 * A relative value resolves against each process's own working directory, so a
 * child spawned with another cwd (or after a `chdir`) would listen in a different
 * place and never be collected. Resolve it where it is first read and write the
 * absolute value back, so every process spawned afterwards inherits the same
 * directory. Unset or empty stays as it is: that is "no service".
 */
export function socketDirFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[SOCKET_DIR_ENV]
  if (raw === undefined || raw === '') return raw
  const absolute = resolve(raw)
  if (absolute !== raw) env[SOCKET_DIR_ENV] = absolute
  return absolute
}

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
