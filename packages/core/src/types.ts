/**
 * Shapes shared by every coverage source and by the Normalizer.
 *
 * Nothing here mentions a test framework. CBD's core is framework-neutral by
 * rule: adapters translate their runner's lifecycle into these types, and the
 * core never learns which runner it was.
 */

/** A coverage range inside a function, in the generated file's byte offsets. */
export interface V8Range {
  startOffset: number
  endOffset: number
  /** With `callCount: true`, executions of this range since the previous take. */
  count: number
}

export interface V8Function {
  functionName: string
  isBlockCoverage: boolean
  /** `ranges[0]` spans the whole function; later ranges are blocks inside it. */
  ranges: V8Range[]
}

export interface V8ScriptCoverage {
  scriptId: string
  url: string
  functions: V8Function[]
}

export interface ScriptInfo {
  url: string
  /**
   * As reported on `Debugger.scriptParsed`. May be relative to the script's own
   * URL, or a `data:` URI carrying an inline map.
   */
  sourceMapURL?: string
}

/**
 * Where coverage comes from.
 *
 * Both a synchronous and an asynchronous take are on the interface because the
 * two consumers genuinely differ (A0 F1/F9): japa does not await its lifecycle
 * hooks, so a japa-driven adapter can only use `takeSync()`; an out-of-process
 * source speaking CDP over a socket can only offer `take()`. Carrying both keeps
 * the integration-testing door open without a breaking change later. The third
 * possibility — a boundary that can be *sent* synchronously even though the reply
 * cannot be — is `QueuedSource` below, and it is a separate interface so that a
 * source which has no such trick available is not obliged to pretend otherwise.
 */
export interface Source {
  readonly kind: string
  /** False when this source cannot produce a delta synchronously. */
  readonly supportsSync: boolean
  /** Throws if `supportsSync` is false. */
  takeSync(): V8ScriptCoverage[]
  take(): Promise<V8ScriptCoverage[]>
  /** `scriptId` -> info, populated from `Debugger.scriptParsed`. */
  scripts(): ReadonlyMap<string, ScriptInfo>
  close(): void
}

/**
 * One coverage delta and the correlation ids that were in flight for it.
 *
 * `ids` is a set rather than one id because concurrent requests cannot be
 * separated by a take: `takePreciseCoverage` resets one counter for the whole
 * isolate. Attributing the delta to every request that was in flight during it
 * over-selects, which is the safe direction; picking one would be a guess.
 */
export interface TaggedCoverage {
  ids: string[]
  coverage: V8ScriptCoverage[]
}

/**
 * A boundary's whole answer: the ordinary window, plus what the source took on
 * its own account.
 *
 * A queued source can produce more than one delta per boundary. The service
 * instrument takes at each correlated request's start and end, and those deltas
 * are delivered with the next boundary reply — that is `requests`. `ids` describes
 * `coverage`: the requests in flight when the boundary itself was crossed. Both
 * are opt-in and absent from sources that do not correlate anything.
 */
export interface TakeCapture {
  coverage: V8ScriptCoverage[]
  ids: string[]
  requests: TaggedCoverage[]
}

/**
 * A window whose take has been sent but not yet answered.
 *
 * `seq` is its position in the source's dispatch order, which is the order
 * `settle()` resolves in. Carrying it lets a caller keep a boundary-to-window
 * mapping without having to settle in lockstep — which is the whole reason this
 * type exists, because the caller that needs it cannot wait.
 */
export interface PendingTake {
  readonly seq: number
  settle(): Promise<V8ScriptCoverage[]>
  /**
   * The same reply with its correlation tags, when the source has any.
   *
   * A separate method rather than a wider `settle()` return type: a plain source
   * has no tags to report, and making every caller destructure an envelope it
   * never fills would be a worse contract than an optional capability. The
   * `Recorder` uses this when it is present and `settle()` otherwise.
   */
  settleTagged?(): Promise<TakeCapture>
}

/** What the boundary actually cost, over the windows taken so far. */
export interface DriftStats {
  windows: number
  maxUs: number
  meanUs: number
  /**
   * The most boundaries that were ever written and not yet answered.
   *
   * **Back-pressure, and only a proxy for sliding.** Two quite different things raise
   * it, and reading it as "the windows slid" is wrong for one of them. The first is
   * server-side queueing: boundaries written while an earlier one is still being served
   * wait behind it, and because a window begins when its boundary is *received* they
   * land late. Measured on this host, 200 boundaries written back to back drift 24ms and
   * put `drift` well into the milliseconds. The second is a client that is simply not
   * reading: the reply is in the socket buffer and the recorder has not got to it,
   * because it is parsing a large one (`cbd-llm`: the first take's reply, carrying the
   * whole function report, blocked the loop for up to 170ms — the table's maps are no
   * longer duplicated on the wire, but V8's first function list remains). That raises
   * the depth without moving a single boundary, and it is the ordinary case — a real run
   * measured at depth 7 with a mean drift of 0.34ms.
   *
   * So this is a liveness signal, not a precision one, and it stays **one** number
   * rather than being split into "queued" and "unread": telling those apart needs a
   * client-side arrived-but-unread counter, and the distinction it would buy is the one
   * `maxUs` against `minGapUs` already answers. **Whether the windows slid is `maxUs`
   * against `minGapUs`**: a boundary that landed later than the next one was sent is
   * one the runner did not ask for.
   *
   * **The first boundary of a process is the expensive one** (`cbd-h09`): its take
   * carries every script the process has parsed and the inspector is cold — measured at
   * about 7ms against a fraction of a millisecond once warm. A boundary dispatched inside
   * that cost drifts by it, so `maxUs > minGapUs` can be true at start-up on a run whose
   * steady state is exact. The place to see it is a test end immediately followed by the
   * next test start, which are a bucket boundary and a test boundary about 1ms apart.
   */
  maxDepth: number
  /**
   * The closest two boundaries ever came to each other, in microseconds.
   *
   * Drift is only ever a problem *relative to this*. A boundary that lands 300µs
   * from where it was meant is exact on a suite whose tests run for tens of
   * milliseconds and is worthless on one whose tests run for hundreds of
   * microseconds, and the drift alone cannot tell the two apart. So the number that
   * decides whether the socket hop costs anything is the ratio, and this is its
   * denominator — measured in the run rather than assumed from a benchmark, because
   * the spacing is a property of the suite and the take rate is a property of the
   * recording.
   *
   * Zero only for a source that never sent two boundaries, which a recorded run
   * cannot be: `@load` and `@teardown` are two on their own.
   */
  minGapUs: number
}

/**
 * A source whose boundaries can be sent now and read later.
 *
 * This is the capability an out-of-process source needs and `takeSync` cannot
 * express. japa does not await its lifecycle hooks, so a boundary handler cannot
 * wait for a socket round trip (A0 F1) — but it *can* write the request, and a
 * write is the boundary. `dispatch()` does exactly that and hands back a handle;
 * the deltas are read at the end of the run, where japa does await.
 *
 * The pair is complementary to `Source`, not a replacement: a source either has a
 * delta it can hand over in the same tick (`supportsSync`) or boundaries it can
 * send in the same tick (`QueuedSource`). A source with neither can only be
 * driven by a caller that owns the whole run.
 */
export interface QueuedSource extends Source {
  /**
   * The pid of the process on the other end.
   *
   * Its coverage is written to its own shard, and a shard's header names the
   * process it came from — so a recorder driving this source has to be told which
   * pid to write, or it would credit the target's execution to the process reading
   * it. Not optional, because getting it wrong is invisible: two shards claiming one
   * pid look entirely ordinary.
   */
  readonly pid: number
  /** Sends a boundary now. The write is synchronous; only the reply is deferred. */
  dispatch(): PendingTake
  /**
   * How far boundaries have landed from where the caller meant them.
   *
   * The drift is directional and the direction matters: server work done between
   * a boundary being sent and being received lands in the *previous* window, so a
   * test's execution bleeds into `@between`, which escalates a file to every test.
   */
  drift(): DriftStats
}
