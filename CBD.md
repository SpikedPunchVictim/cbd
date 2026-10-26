# CBD — coverage-based dependency mapping for test selection

A standalone, framework-neutral tool that records **which source code each test executes**, keeps that
as a map keyed by commit, and answers **"which tests can this change affect?"**. Test runners plug in
through thin adapters; japa is the first.

This document is the kickoff design. It was written from a working project (a TypeScript monorepo
whose backend suites are japa tests that drive a separately started HTTP server), but nothing below
depends on that project. Section 13 says which statements were verified and which are assumptions
for the first spike.

---

## 1. Problem and goals

Running every test on every change is slow, and in agent-driven workflows it also costs tokens: the
output of tests that could not have been affected is pure noise. Tools that select tests from the
**import graph** (Jest's `--findRelatedTests`) over-select badly in a backend, where every route
transitively imports half the codebase, and they miss anything reached at runtime (dependency
injection, route tables, dynamic `import()`, a server under test running in another process).

CBD selects from **observed execution**: run the suite once with V8 coverage on, take a snapshot at
every test boundary, and record which functions each test ran. Later, a diff names changed
functions, and the map names the tests that ran them.

### Goals

1. **Per-test attribution** of executed code, at function granularity, mapped back to original
   source through source maps.
2. **Framework-neutral core.** The core never imports a test framework's types. Adapters translate
   framework lifecycle events into four calls: `runStart`, `testStart`, `testEnd`, `runEnd`.
3. **In-process and out-of-process code.** Code running in the test process itself, *and* code
   running in a separate Node process the tests talk to — reached by injecting CBD's instrument
   module through `NODE_OPTIONS`, not by attaching a debugger (ADR-0005).
4. **Safe by default.** When the map cannot answer, the answer is "run everything", with the reason.
   A selection is advisory and explainable, never a silent skip.
5. **Consumable by anything**: a CLI with JSON output, a library API, framework-specific argument
   emitters, and an optional MCP server for coding agents.

### Non-goals (v1)

- Browser coverage (Playwright's `page.coverage`) — designed for (section 4.4), not built.
- Hosted map storage, dashboards, or a SaaS. Maps are files; a pluggable store comes later.
- Line-level selection. Function level is the unit; file level is the fallback.
- Replacing a full CI run. CBD shortens the inner loop; a full run still gates merges.

---

## 2. How it works, end to end

```
 ┌──────────── collect (slow, occasional: nightly, on main, or on demand) ───────────┐
 │                                                                                   │
 │  test runner ──adapter──► Recorder ──take()──► CoverageSource(s) ──► V8 Profiler   │
 │    (japa)    testStart/    │                    in-process / remote                │
 │              testEnd       ▼                                                       │
 │                       Normalizer (scripts → source files/functions via source maps)│
 │                            ▼                                                       │
 │                       shard: .cbd/shards/<run>.jsonl  (one record per test)        │
 └───────────────────────────────────┬───────────────────────────────────────────────┘
                                     ▼
                        cbd build  → .cbd/maps/<commit>/   (merged, indexed map)
                                     ▼
 ┌──────────── select (fast, every change) ──────────────────────────────────────────┐
 │  git diff <map commit>..worktree → changed files + hunks → changed functions       │
 │  → tests whose recorded functions intersect → Selection {mode, tests, reasons}     │
 │  → consumer: japa args / JSON / library call / MCP tool                            │
 └───────────────────────────────────────────────────────────────────────────────────┘
```

### Why V8 coverage, not Istanbul/nyc

- **No instrumentation step.** V8 counts natively; no Babel transform, no rebuilt `dist/`, and the
  code under test is the code that ships.
- **Works on a process you did not start through the test runner.** CBD's instrument module can run
  inside any Node process whose environment you control — a server started by its own script, a
  lane's service — and serve deltas over a unix socket. The Profiler domain is the same one the
  test process uses. Attaching over the Chrome DevTools Protocol to an `--inspect` target is the
  fallback for a process whose environment genuinely cannot be set. Istanbul would need the
  server's build instrumented and a way to pull its global `__coverage__` object out per test.
- **Counters can be reset per snapshot.** `Profiler.takePreciseCoverage` returns the counts since
  the last take *and resets them* when `callCount: true`, which is exactly a per-test delta.
  Istanbul's counters only grow; per-test deltas mean diffing large objects.
- `c8` uses V8 coverage too, but only through `NODE_V8_COVERAGE`, which writes once at process exit:
  per-process, not per-test. CBD drives the Profiler directly.

---

## 3. Concepts and vocabulary

| term | meaning |
|---|---|
| **Test ID** | A stable string naming one test: `<framework>:<suite>:<file>::<group path> > <title>`. Section 6.2. |
| **Window** | The interval between two `take()`s. A test window runs from `testStart` to `testEnd`. |
| **Touch** | A function (file and range in original source) with a nonzero count in a window. |
| **Buckets** | Where a window's touches go: a test, `@load` (code run before the first test: imports, global setup), `@between` (code run between tests: other tests' leftover async work, pollers), `@teardown` (after the last test). |
| **Shard** | One collection run's raw records, append-only JSONL. Runs can be sharded across machines. |
| **Map** | Shards merged and indexed for one commit, plus a manifest. Read-only once built. |
| **Selection** | The answer to a change: `mode: "subset"` with a test list, or `mode: "all"` with the reason. |

---

## 4. Coverage sources

```ts
export interface CoverageSource {
  readonly id: string                      // "in-process", "server@127.0.0.1:9229"
  start(): Promise<void>                   // Profiler.enable + startPreciseCoverage, Debugger.enable
  take(): Promise<RawSnapshot>             // takePreciseCoverage: counts since last take, then reset
  stop(): Promise<void>
}

export interface RawSnapshot {
  sourceId: string
  takenAt: number                          // performance.timeOrigin + now(), for ordering
  scripts: V8ScriptCoverage[]              // verbatim from V8 (scriptId, url, functions[].ranges[])
  scriptsParsed: ScriptInfo[]              // new since the last take: scriptId, url, hash, sourceMapURL
}
```

A Recorder can hold **several sources at once** — the test process *and* the server it talks to —
and takes all of them at each boundary, in parallel.

### 4.1 Settings for every source

- `Profiler.startPreciseCoverage({ callCount: true, detailed: false })`
  - `callCount: true` is what makes `take` reset counts, so each window is a delta.
  - `detailed: false` gives function granularity: far smaller payloads and less overhead than block
    coverage. Block coverage (`detailed: true`) is a later option for line-level selection.
  - Precise mode, not best-effort: best-effort lets V8 garbage-collect coverage of functions whose
    code was flushed, so a function could silently drop out of a window.
- `Debugger.enable`, listening for `Debugger.scriptParsed`, to learn each script's URL, content hash
  and `sourceMapURL` (often an inline `data:` URL when a loader such as tsx transpiles TypeScript).
  The same mechanism works in-process and remotely, so the Normalizer has one code path.
  `Debugger.getScriptSource` fetches source text when it is needed to turn character offsets into
  lines (cached by hash).

### 4.2 `inProcessSource()` — the test process itself

`node:inspector` `Session` connected to the current isolate (`session.connect()`), or
`connectToMainThread()` from a worker. Covers unit and integration tests that import the code under
test, which is most projects.

- Works inside worker threads (Vitest, Jest workers, Mocha parallel): each worker has its own
  isolate and its own source, and an adapter in each worker records its own tests.
- The inspector's in-process `post` completes synchronously on the main thread — measured, including
  inside `process.on('exit')`. `inProcessSource.takeSync()` is what makes a framework that does not
  await its hooks recordable (section 7.1).
- **Standing the injected module down is a handoff.** When the test process carries `NODE_OPTIONS`
  (it must, for the services it starts to be instrumented), the injected module is already running
  here, and its 500 ms self-snapshots have taken the coverage counters since process birth. The
  in-process source calls its off switch, and the switch returns what it had consumed; the source
  delivers that in its first window, which is the `@load` bucket. Without the handoff the import
  phase — where a module a suite merely loads executes — was invisible (`cbd-1ci`).
- **The periodic self-snapshot is bounded, and knobbed.** The injected module writes a recovery file
  on each take and every 500 ms. That file carries only what a lost take can be recovered from by
  id — its unacknowledged window and the script rows no reply has delivered. The accumulator
  (coverage taken since the last take) and the request queue are *not* in the periodic file: on a
  service handling thousands of requests between two test boundaries they reached 398 MB, and
  rewriting them every half second put the service at ~97% CPU (`cbd-n9t.2`). The **exit** write is
  complete, including both. `CBD_SNAPSHOT_MS` overrides the interval, and `0` keeps only the exit
  write; a SIGKILL then loses the run, whose shard has no footer and is refused rather than
  trusted.

### 4.3 A separate Node process: injection first, attaching as the fallback

**The primary mechanism is injection (ADR-0005).** The target is started with
`NODE_OPTIONS="--import @spikedpunch/cbd/instrument"` and `CBD_SOCKET_DIR=<dir>`. The module runs
inside the target, drives `node:inspector` for its own isolate, and serves the coverage delta plus
`Debugger.scriptParsed` rows on `pid-<pid>.sock` in that directory. `socketSource` reads one target;
`rescanningSocketSource` re-lists the directory at every boundary so a service the suite starts
itself is picked up too (ADR-0007).

- **One variable, no port.** The developer sets it where they already set the test side, or once in
  the environment template that starts the service. Nothing in the server's source changes, and
  nothing has to be discovered.
- **Multi-process by inheritance.** `NODE_OPTIONS` is inherited, so a cluster, a worker pool or a
  spawned child instruments itself for the same reason its parent did. Each process has its own
  socket and pid; when several targets feed one shard, script ids are namespaced by pid.
- **No listening TCP port.** A unix socket in a directory the developer owns is not an
  unauthenticated code-execution surface, so there is no loopback rule and no collector lock file to
  keep.
- **A process that dies still leaves evidence.** The instrument writes `pid-<pid>.coverage.json`
  beside its socket — after each take, on an interval, and at exit. A target the source held
  recovers a numbered window by take id, or the unnumbered lifetime exactly once (ADR-0007). A
  process that exits before it could be attached — the ordinary shape of a test that shells out
  to a CLI — unlinks its socket but leaves the exit write; the re-scan harvests that lifetime
  once, for the boundary that discovered the process, when the file names no collector session
  and the process was born during the recording.
- **What it cannot reach.** A target whose environment cannot be set, and one that cannot resolve
  `@spikedpunch/cbd/instrument` from its own module graph. The in-process case is section 4.2.

**A request can name the test that sent it (ADR-0008).** The window above is closed by the test
runner, so service work that happens after `testEnd` — a response still in flight, a request the
test fired without awaiting — is credited to whichever test's window is open when it runs. With
correlation, the recorder puts `x-cbd-correlation: <test-id>` on outgoing `http`/`https`/`fetch`
calls while a test window is open; the instrument takes a tagged delta at the request's start and
end; and the reply carries those deltas back. The recorder writes each as an ordinary test record
for the id's owner. Three properties matter:

- **Framework-neutral.** The hook is `http.Server.prototype.emit('request')`, below Express,
  Fastify, Koa and a bare server. HTTP/2 and clients that bypass the `http` module are not
  covered and fall back to time-based attribution.
- **Safe under concurrency.** One V8 counter cannot be split between concurrent requests, so a
  delta carries the *set* of ids in flight and is credited to all of them — over-selection.
- **Unmatched is not dropped.** An id the run does not own becomes `@between`, which §8.3
  escalates. `CBD_CORRELATION=off` records with time-based attribution only.

**The fallback is `inspectorSource({ url } | { host, port })`.** CDP over WebSocket to a process
started with `--inspect=127.0.0.1:<port>` (or `--inspect=0`, with the port read from its stderr line
`Debugger listening on ws://…`); targets come from `http://<host>:<port>/json/list`. It exists for a
target whose environment genuinely cannot be set, and is not the default path. Coverage starts at the
attach, so anything the process did before it — start-up, module imports — is outside the first window.

- This reaches a black-box suite whose service genuinely cannot be restarted with an environment
  change: the tests send HTTP requests, the server's code runs, and the per-test window is taken
  from the server.
- **It is a `QueuedSource`, driven exactly like the injected source.** `dispatch()` sends the
  `Profiler.takePreciseCoverage` request in the tick the boundary happens and returns a handle; the
  handle's `settle()` resolves no earlier than the handles dispatched before it, so overlapping
  boundaries still partition one counter in order. `drift()` reports the round trip each boundary
  cost, which is an upper bound rather than the socket source's server-side receive time.
- **A live service is never idle.** Background work — schedulers, heartbeats — runs inside every
  window, including the gaps between tests. That work lands in `@between` and escalates the files it
  touches to every test, so an attached run over-selects relative to an injected one. It is the
  price of not controlling the target, not a defect in the window.
- **A target is identified by asking it.** The shard header's pid comes from `Runtime.evaluate`,
  because a port says nothing about the process behind it. A target attached to while it is still
  bootstrapping answers `undefined` for a few milliseconds rather than with an error, so the
  question is repeated until the pid is there or the timeout expires.
- **`cbd collect --target` is how a run asks for it.** The flag resolves the target, refuses a
  non-loopback host unless `--allow-remote`, and refuses a target another collector holds — all
  before the suite is spawned, so a refusal is one `cbd:` line rather than a runner stack trace.
  The value travels to the test process in `CBD_INSPECT` (with `CBD_INSPECT_ALLOW_REMOTE` when the
  flag was given), where the japa plugin opens the service recorder from it exactly as it opens one
  from a socket directory. Both variables set at once is refused: they name one service two ways.
  One target per run, because one source reads one debugger port.
- **One test runner per server during collection.** Two runners hitting one server make attribution
  meaningless, and a take resets one counter shared by both. The source refuses a target another
  collector holds, through a lock file keyed by the target origin in the OS temp directory. A lock
  whose owning pid is gone is reclaimed, so a killed run does not poison its target.
- **Multi-process servers need one port per process**, and each needs its own source. That is the
  cost injection does not have.
- **Security: no remote attach.** `--inspect` gives full code execution to anyone who can reach the
  port. Bind to `127.0.0.1` only; the source refuses a non-loopback host unless
  `allowRemote: true`.

### 4.4 Later sources (designed for, not in v1)

- `nodeV8CoverageSource` — for child processes you can neither inject into nor attach to: launched with
  `NODE_V8_COVERAGE=<dir>`, and the child calls `v8.takeCoverage()` on a signal. Only process-level
  windows unless the child cooperates.
- `browserSource(page)` — Playwright/Puppeteer `page.coverage.startJSCoverage({ resetOnNavigation:
  false })` per test, for frontend code exercised by end-to-end tests.

---

## 5. Normalization: from V8 scripts to source functions

Input: one `RawSnapshot` per source. Output: `Touches` — a set of `(file, functionKey)`.

1. **Filter scripts** by URL: drop `node:` internals, anything under `node_modules` (configurable),
   anything outside `root`, and evaluated code with no URL. Configurable `include` / `exclude` globs.
2. **Keep functions with `count > 0`** in their first range (the function's own range; nested ranges
   refine blocks, which function granularity ignores). The script's top-level pseudo-function
   (`functionName: ""` spanning the whole script) is **module evaluation**: count it as a touch of
   the file's `@module` key, which almost always lands in the `@load` bucket.
3. **Map to original source.** Resolve the source map (inline `data:` URL, or a `.map` file next to
   a `dist/` file) and map the function's start offset to an original file, line and column, using
   `@jridgewell/trace-mapping` (small, fast, no native code). No map → the generated file is the
   source.

   A start offset with no mapping of its own falls forward to the next mapping that has one. The
   same-line lookup is not enough: `tsc` opens every file with unmapped boilerplate (`"use strict"`,
   the `__createBinding` helpers), so byte offset 0 — the module body — had no mapping on its line
   and resolved to nothing. For a file whose only executed function is its module body (a module of
   classes or constants re-exported by a barrel) that dropped the file from the map entirely even
   though the run had loaded it, and a change to it escalated as `unknown-file` instead of the
   truthful `@load` (`cbd-1ci`).

   A resolved path is then rewritten by any **relocation rule** that covers it: `from` names the
   staging root, `to` names the checkout (`CBD_RELOCATE_FROM` / `CBD_RELOCATE_TO`, ADR-0006). This
   is the case where a service runs from a *copy* of its
   build, as a deployed lane does: the copy's maps are correct and resolve inside the copy, so
   without a rule the map is keyed by a path no diff can name, and a repository change either
   misses the tests that drove it or degrades to `mode: all`. Relocation is deliberately not
   projection: projection is for a build with no map (the generated file *is* the source), and it
   is only sound because a 1:1 build preserves lines. Relocation claims something weaker — the
   copy is the same tree — and is applied after a map has already done the work. Order is map →
   relocate → include/exclude. A rule assumes the copy was built from the checkout; a stale copy
   over-selects, which is the acceptable direction.
4. **Name the function stably.** The key must survive edits elsewhere in the file, so it is not a
   line number. Use `name@ordinal`: the function's name (V8's `functionName`, or the nearest
   enclosing named function plus `>anon`) plus its ordinal among same-named functions in that file.
   Store the original line range alongside, for hunk intersection at selection time — line ranges
   are *data at the map's commit*, never the identity.
5. **Hash the original file** (sha256 of its content at collection time) so selection can tell
   which mapped files changed since.

Cost control: cache everything keyed by script hash (source text, parsed map, offset→line tables).
A suite loads the same few hundred scripts once; every later snapshot is a lookup.

---

## 6. The Recorder and the shard format

### 6.1 Recorder API

```ts
export interface RecorderOptions {
  root: string                              // repo root; every path in output is relative to it
  sources: CoverageSource[]
  shardDir?: string                         // default <root>/.cbd/shards
  include?: string[]; exclude?: string[]
  granularity?: 'test' | 'group'             // default 'test'; group takes one window per runner group
  settleMs?: number                         // wait before testEnd's take, for trailing async work; default 0
  takeAtStart?: boolean                     // default true: a take at testStart moves leftovers to @between
}

export class Recorder {
  constructor(opts: RecorderOptions)
  runStart(meta: RunMeta): Promise<void>        // starts sources; next take goes to @load
  testStart(id: TestId): Promise<void>
  testEnd(id: TestId, outcome: Outcome): Promise<void>
  groupEnd(): void                              // group granularity: one take for the tests since the last boundary
  runEnd(): Promise<RunSummary>                 // final take → @teardown; writes the shard trailer
}

export interface RunMeta {
  framework: string; frameworkVersion?: string
  commit?: string                               // default: git rev-parse HEAD in root
  dirty?: boolean                               // default: git status --porcelain is non-empty
  argv?: string[]; shardIndex?: number; shardTotal?: number
}

export type Outcome = { status: 'passed' | 'failed' | 'skipped' | 'todo'; durationMs?: number }
```

`testStart` / `testEnd` must be **awaited** by the adapter; section 7 says how for each framework.
A `testEnd` without a matching `testStart` is an adapter bug: the Recorder throws with both IDs.

### 6.2 Test identity

```ts
export interface TestId {
  framework: string                 // "japa"
  suite?: string                    // japa suite name, Jest project, Vitest project
  file: string                      // repo-relative test file
  path: string[]                    // enclosing group titles, outermost first
  title: string                     // the declared title, not the dataset-expanded one
  ordinal?: number                  // set only when file+path+title repeats
}
export function testKey(id: TestId): string   // "japa:key-server:tests/x.spec.ts::grp > title"
```

- **Dataset tests** (japa `.with()`, `test.each`) collapse to one ID: selection reruns the whole
  test, so per-row identity buys nothing and breaks when rows change.
- **Duplicates** get an `ordinal`: absent for the first occurrence in a file, then 1, 2, … in
  test-start order. The map identity is `(title, file, ordinal)`, so their coverage and failures no
  longer merge. Selection still filters by title and runs every occurrence — safe over-selection —
  and `cbd stats` lists the duplicate groups. A subset recording that runs only a *later* duplicate
  cannot know its full-run ordinal and may merge with the first occurrence; a full recording is
  deterministic.
- **Renames** look like a deleted test plus a new unmapped test. A new test file or test is
  `unmapped` and is always selected (section 8.3).

### 6.3 Shard format

`.cbd/shards/<UTC timestamp>-<random>.jsonl`, one JSON object per line. **Version 3**
(ADR-0002): a window records the executed functions' byte ranges, and the paths, lines
and ordinals are resolved once, by `cbd build`. Version 3 adds the `group` record, so one
window's touches can be shared by every test in a runner group; version 2 shards are still
read, and a version 2 header carrying a group record is refused.

```jsonc
{"type":"shard","version":2,"commit":"3c5a43e6…","pid":8123,"startedAt":"2026-10-15T20:41:02Z"}
{"type":"script","scriptId":"42","url":"file:///repo/dist/src/KeyService.js","sourceMapURL":"KeyService.js.map","size":8123,"mtimeMs":1729024862000}
{"type":"function","scriptId":"42","start":1200,"end":1688,"name":"encrypt"}
{"type":"function","scriptId":"42","start":0,"end":2100,"name":""}
{"type":"test","title":"rotation > rotates on 64GB","file":"tests/key-store.spec.ts","status":"passed","durationMs":412,"touches":{"42":[[1200,1688],[0,2100]]}}
{"type":"group","tests":[{"title":"rotation > rotates on 64GB","file":"tests/key-store.spec.ts","status":"passed","durationMs":412}],"touches":{"42":[[1200,1688],[0,2100]]}}
{"type":"load","touches":{"42":[[0,2100]]}}
{"type":"between","touches":{"42":[[3300,3412]]}}
{"type":"end","tests":214,"finishedAt":"2026-10-15T20:43:33Z"}
```

- A **group** record is written when the run records at `granularity: "group"`: one `touches`
  shared by every test in the record, expanded back into ordinary per-test windows by the build.
  The union is what the group executed, so each test is credited with all of it — over-selection
  inside the group and never under-selection. A group window also takes the gap between its
  tests, which is why no `between` record appears in this mode.
- A **script** row is written once per script, with the file's `size` and `mtimeMs` at
  recording time. The URL is the *relocated* one when a relocation rule applies, so a
  deployed lane's shard names bytes the checkout still has.
- `sourceMapURL` is recorded **only when the file does not declare one**. A tsc inline map is
  tens of KB per script and the build reads the same stat-checked file, so repeating it is pure
  duplication; a loader-injected map (ts-node on a `.ts` file with no comment) exists only in
  `Debugger.scriptParsed` and must be recorded. When the file's declaration differs from what the
  inspector reported, the inspector's wins — it describes the bytes V8 executed. Measured on the
  grizzly stores run: 2,437 service script rows carried 35.2 MB of file-declared maps, 62.4% of
  that shard (`cbd-n9t.1`).
- A **transformed script's** offsets index generated text, not the file: Vitest/Vite, Jest and
  ts-node compile in memory. A later `script` row for the same script may carry
  `generated: {"lineStarts":[…],"length":…}`; it is written after the run's last window, once the
  source's `prepare()` has fetched the text, and the build merges it into the script row. The build
  indexes those line starts instead of the file. Untransformed scripts omit the field and record
  nothing extra (`cbd-x2j`).
- A **function** row is written once per `(script, start offset, end offset)`, the first
  time any window executes it. The **range** is the identity, not the start: Jest's
  CommonJS VM wrapper and the first function it contains can both begin at offset 0,
  and a start-only key merged `add` into `<module>`. Names are V8's raw
  `functionName`; the build decides the module body (`<module>`) and anonymous
  (`<anonymous>`) names.
- A **test** row may carry `ordinal` (absent for the first occurrence of a `(file, title)`, then
  1, 2, …), which is what keeps same-named tests in one file distinct in the map (`cbd-gkj`).
- **Touches** are `scriptId -> [[startOffset, endOffset], …]` for the functions that ran.
  Nothing in a window names a file, a line or a function.
- **Ordinals are assigned from the union over every window**, in resolved source order.
  That is the proper fix for the A4 collision, where a function first reported late
  used to collide with another of the same name.
- **A shard is tied to its build.** An offset only means something against the exact
  bytes it was measured from, so `cbd build` compares each script's size and mtime and
  **refuses** a shard whose script changed. Refusing beats guessing: guessing would
  attribute the range to whatever now sits there, silently, in the under-selecting
  direction. Shards from one build still merge across CI machines.
- **Version 1 is refused**, not migrated: its touches are resolved tuples, which carry
  no script id, so the byte ranges they came from cannot be recovered.
- Projection, relocation and include/exclude moved to the build. The same
  `CBD_PROJECTION_*`, `CBD_RELOCATE_*` and `CBD_INCLUDE` variables are read by
  `cbd build` (and by `cbd collect`, which builds in the same process). A missing rule
  makes a path unknown, which escalates to `mode: all`; it never under-selects.
- A shard with no `end` record was interrupted: `cbd build` refuses it unless `--partial`, and says so.
- A shard from a dirty tree is accepted but its map is marked `dirty`; selection warns.

---

## 7. Adapters

An adapter's whole job: compute a test identity, call the Recorder at the right moments, and keep
every per-test handler synchronous — in a framework that does not await its events, a handler that
awaits would take coverage after the next test has started. Target size: 100–200 lines each.

**The contract (version 1).** Every adapter reports the same three things, and the rest of the
toolchain consumes only those:

- **Identity.** `testId(file, title)` is `<file>::<title>`. An adapter may also report a
  `titlePath` and a definition site; neither changes the id, because a line number moves when
  unrelated code above the test does. Where two tests genuinely share a title in one file,
  selection runs both — over-selection is the safe direction.
- **A window.** `testStart` before the test body, `testEnd` after it, synchronously.
- **Results.** The outcome and the duration, on that same `testEnd`.

Test code — or a helper it calls — can add what the recorder cannot observe:
`recordRead(path)`, `recordDirRead(dir)`, `recordDependency(paths)` and `recordOpaque(reason)`,
exported from `@spikedpunch/cbd`. They take no test id; the open window receives them, and a call
outside every window is ignored, which leaves the file unknown and escalates to `all`. A read is
kept in the map only when it is under the project root and inside `include`, and never under
`node_modules` — a change outside that scope could not select the test anyway. A read of a build output is also recorded at the source a
sibling source map names, or at the path a projection rule produces, so a `tsc` test that reads
`dist` is selected by a change to `src`.

A read made while a spec file is importing is recorded in a spec scope. The build attributes it to
that spec's tests when the adapter named the file (Vitest, Jest); an adapter that cannot name it
(japa, mocha, node:test) gets the whole shard, which is conservative but never drops the dependency.
`recordOpaque` marks a test as selected by any in-scope change — the honest fallback for a test that
spawns a tool or drives a service.

The adapters also wrap the test process's public `node:child_process` spawn, exec and fork calls and
note an opaque dependency while a window is open, so a test that runs a tool is not silently omitted.
Only the call is seen; the child's work is not. `CBD_TRACK_PROCESSES=0` turns the wrapper off.

`cbd collect` writes the v2 selection file `{ "version": 2, "tests": [{ id, file, title, … }] }`;
a v1 `{ "titles": [...] }` file is still read, so an adapter and a CLI do not have to upgrade
together. `ADAPTER_CONTRACT_VERSION` is exported from the package root and the adapter entry, and
`cbd --version --format json` reports it.

The contract is window-based, deliberately not `AsyncLocalStorage`-based: no supported runner lets
a *plugin* wrap the test body, and a context established in a `beforeEach` does not reliably survive
into the runner's own invocation. A runner that overlaps tests by default must serialize windows or
decline to record. `cbd-vitest`, `cbd-jest` and `cbd-node-test` decline: an overlapping window throws
instead of charging one test's coverage to another, and the shard is left without an end
record so the build refuses it. See
[ADR-0017](arch/decisions/0017-adapter-contract.md).

### 7.1 japa (`@spikedpunch/cbd-japa`)

Facts read from the installed `@japa/runner` 5.0.0 and `@japa/core` 10.4.0:

- A plugin is `({ config, cliArgs, runner, emitter }) => void | Promise<void>`, registered in
  `configure({ plugins: [...] })`.
- `Test.executing(cb)` / `Test.executed(cb)` are static callbacks, but the core calls them with
  `forEach` and **does not await them**. An async `take()` there would run into the next test.
  Do not use them.
- Awaited per-test hooks exist: `test.setup()` / `test.teardown()`, `group.each.setup()` /
  `group.each.teardown()`, reachable for every test through `runner.onSuite(suite => …)`,
  `suite.onGroup(group => …)`, `suite.onTest(test => …)` and `group.tap(test => …)`.
- The emitter has `test:start` / `test:end` events (what reporters use). They are not awaited, but
  `test:end` carries the outcome, which is all the adapter needs from it.
- japa runs tests in one process, one at a time, so a single in-process source attributes cleanly.

The plugin, as built:

```ts
import { cbd } from '@spikedpunch/cbd-japa'

// Recording is driven by the environment: CBD_SHARD names the shard, CBD_SOCKET_DIR
// names the directory the service's instrument wrote into, CBD_COMMIT names the
// commit the map will be keyed by. With CBD_SHARD unset the plugin is inert.
configure({
  suites: [...],
  plugins: [cbd()],
})
```

Wiring facts the implementation rests on, all measured (`.explore/A0-japa-hooks.md`):

- **Every per-test handler is synchronous.** japa does not await `emit`, so a handler that awaited
  a take would attribute one test's execution to the next. The `Recorder` is driven through its
  synchronous API; a socket source accepts a boundary with `dispatch()` and the replies are drained
  at `runner:end`, the one event japa awaits.
- **The file is japa's.** `payload.meta.fileName` is set by the runner as it imports each file and
  reaches every `test:start` / `test:end` payload. No stack walk, no source parsing.
- **The identity is the bare title.** `payload.title.original`, never `expanded`; japa's own filter
  matches the bare string (A0 F10).
- **There is no `auto.ts`, deliberately.** `@japa/runner` exports only functions and its plugin list
  is module-private, so there is nothing for a `--import` module to patch. One explicit line in
  `configure` is the integration.
- **A `register` preload moves the start of recording earlier.** The plugin starts recording when
  japa installs it, so anything the runner entry imports above `configure` (a shared test-kit, a
  config module) runs unrecorded and is unknown to the map. `--import @spikedpunch/cbd-japa/register`
  opens the session before the entry runs and parks it; the plugin adopts it instead of starting a
  second, so those executions land in `@load`. The plugin line stays — the preload cannot install
  the window hooks — and a plugin-only setup behaves as before. The preload is inert without
  `CBD_SHARD`, which it reads and removes so a spawned child does not reopen the shard.
- **The adapter's own files are excluded from the scan.** So are core's. `NODE_OPTIONS` reaches the
  test runner too (ADR-0005), and a workspace link resolves outside `node_modules`, where the
  default prefilter cannot hide the tool. `CBD_INCLUDE_SELF=1` lifts that floor for the
  one case where the tool is the subject: recording CBD's own suites (dogfooding), where a map
  without core's `src` would answer every source change with `mode: all`.

**Selection with japa.** The plugin computes the titles and sets `config.filters.tests` inside
`run()`; it does **not** emit `--tests` CLI args. `configure()` snapshots `processCLIArgs` at call
time, so args are silently discarded when the consumer calls it first (A0 F11); a filter set by the
plugin cannot be lost that way. `--groups` is never emitted: japa rejects every ungrouped test once
`groups` is non-empty, and a group is allowed if any test in it matches, so it silently drops tests.
Bare titles can collide across groups; a collision runs both, which over-selects. When the selection
is `mode: "all"` the plugin prints the reason and changes nothing.

**Narrowing the files japa imports.** The title filter is applied after japa has imported every
spec file, so on its own it saves test time but not load time. When `CBD_SELECTION` is a v2 file the
plugin also sets `config.filters.files` to the selected tests' files; the planner greps its resolved
file list against it before importing, for a glob, a list or a function `files` alike. The rule is
that a file leaves the run only when the selection proves it can: a selected test with no file, a
relative or missing path, a v1 titles-only file, an explicit `only`, or a `--files` the caller
already gave all leave every file loading and the title filter alone applies. Extra files cost
time; a missing one is a missed test.

### 7.2 node:test (`@spikedpunch/cbd-node-test`)

**Implemented.** One preload:

```sh
node --import @spikedpunch/cbd-node-test/register --test
```

With `CBD_SHARD` unset the preload is inert for recording, so the flag can be committed. node:test
runs each test file in its own child process by default, and the preload runs **before the file is
evaluated** — so each child creates one in-process source and **one shard per test file**, named
from the file's path. The file's import phase lands in `@load`. Windows are the global
`beforeEach`/`afterEach` hooks; the file's `after` hook writes the footer. A statically skipped test
reaches no hook and opens no window.

The identity is `t.fullName` (`outer > inner > adds`), with `t.name` only as a fallback on Node
versions before 20.16/22.8. The outcome is `t.passed`, which is `true` only after a passing body;
anything else is failed. A `t.skip()`/`t.todo()` **inside a body** leaves `passed` true, so the
hook wraps those context methods and records the window as skipped. A test registered
`{todo: true}` does reach the hooks but exposes no marker; it is recorded as passed with a
hooks-only window, which can only over-select.

**Selection is a re-execution.** `--test` does not load user preloads in the parent runner, and
the child's harness reads its options before the preload runs; a `beforeEach` call to `t.skip()`
does not stop the body either. The preload therefore spawns the same test file once more with
`--test-name-pattern` (the child's stdout is inherited, so the parent still reads TAP) and exits;
the pattern is built from the selection titles with ` > ` translated to the single spaces node:test
matches. That costs one extra process per test file during a subset run. A pattern the caller
already set is left alone, with a warning: running more tests than selected is the safe direction.
`--test-isolation=none` cannot re-execute a child or record per file, so the adapter warns and
records nothing (the old map stands; a changed file escalates).

### 7.3 Vitest (`@spikedpunch/cbd-vitest`)

**Implemented.** One line in the config:

```ts
export default defineConfig({
  test: { setupFiles: ['@spikedpunch/cbd-vitest/setup'] },
})
```

With `CBD_SHARD` unset the setup is inert, so the line can be committed. The setup file runs **once
per test file**: it creates one in-process source and **one shard per file**, named from the base
shard plus the file's name and a hash — so several workers never append to one another's file, and
a worker killed mid-file leaves a shard with no footer (refused) rather than corrupting the run's
artifact. Windows are the awaited `beforeEach`/`afterEach`, which run first and last for a setup
file; the file's import phase lands in `@load`.

The identity is the suite path plus the test name, without the file, so two same-named tests
in one file stay distinct in the map. Vitest 4+ reports it as `task.fullTestName`; Vitest 3 does
not, and the suite chain is walked instead (a real Directus SDK run on 3.2.7 turned 82 tests into
77 map entries before that fallback, exactly the collision the full name exists to prevent). Selection is applied by **skipping an unselected test in
`beforeEach`, before a window opens**: Vitest's `-t` is a regex, and arbitrary titles cannot be
pasted into one safely. A statically skipped test opens no window. Vitest's own
`@vitest/coverage-v8` must be off during a collection: two Profiler sessions on one isolate
interfere. A separately started service is **not collected yet** — several workers reading one
service would split its isolate's take stream — so the adapter records the test process, warns
once, and a server-side change escalates to `mode: all`.

### 7.4 Jest (`@spikedpunch/cbd-jest`)

**Implemented.** Two config lines:

```js
const { withCbd } = require('@spikedpunch/cbd-jest/config');

module.exports = withCbd({
  testEnvironment: '@spikedpunch/cbd-jest/environment',
});
```

With `CBD_SHARD` unset the environment is inert; `CBD_SELECTION` narrows the run through `withCbd`,
which sets Jest's `testNamePattern` from the selection — escaped titles with ` > ` turned into `\s+`
and anchored, because Jest joins the same parts with spaces. The config is loaded before the run and
the pattern is the only filter that sees an expanded `test.each` row; a setup-file wrapper did not,
and `.each` rows bypassed it (on a real Strapi run, refusing them failed 12 suites). Jest creates **one environment per test file**, and `setup()` is awaited before the test file
is evaluated — so the source is created then (the file's imports land in `@load`) and `teardown()`
writes the footer. That gives **one shard per test file**, named from the file's path, so two files in
one worker never append to one another and a worker killed mid-file leaves a shard with no footer
(refused) rather than a corrupted run artifact.

A test environment is loaded with `require`, so the entries Jest names are built as CommonJS with a
dynamic import of the ESM core. Windows are the awaited `handleTestEvent` events (`test_start`,
`test_done`). The identity is the enclosing `describe` names plus the test name, with Jest's
synthetic `ROOT_DESCRIBE_BLOCK` omitted; the outcome is `mode` first (`skip`/`todo` are skipped, and
a skipped test may never reach `test_done`) then the test's `errors`.

Selection is the config helper above, not a setup file: the names Jest filters on are the expanded
ones, and only its own pattern sees them. Jest's own `--coverage` must be off.

### 7.5 Mocha (`@spikedpunch/cbd-mocha`)

`NODE_OPTIONS="--import @spikedpunch/cbd-mocha/auto"` patches `Mocha.prototype.run` — the one funnel
every run passes through — and adds root hooks with `beforeEach` / `afterEach`, using
`this.currentTest.fullTitle()`. The same module reads `CBD_SELECTION` and applies the subset as one
anchored, per-title-escaped `grep`; selecting and recording are independent, as they are for japa. A
selection therefore has to be expressible as mocha's single filter, which exact full titles are.

### 7.6 Anything else: the manual protocol

Any harness can call the Recorder directly. For non-Node runners, `cbd collect --listen <port>`
starts a small local HTTP control server with `POST /run/start`, `/test/start`, `/test/end`,
`/run/end` (the same payloads as the API) and attaches to `--target` inspector URLs. A Python or Go
harness driving a Node server can then produce a map with no Node code of its own.

---

## 8. Building and selecting

### 8.1 Map layout

```
.cbd/maps/<commit>/
  manifest.json        { v, commit, dirty, builtAt, framework(s), shards[], tests, files, overheadSeconds }
  files.jsonl          per file: path, hash, functions [key, startLine, endLine]
  tests.jsonl          per test: key, status, ms, touches (file index → function indices)
  index.json           inverted: file → function → test indices  (what select reads)
  buckets.json         @load / @between / @teardown touches
```

JSON over SQLite on purpose: no native dependency, diffable, and a 2,000-test map is a few
megabytes gzipped (estimate; measure in the spike). `cbd build --gzip` compresses it. If maps grow
past what JSON parses in well under a second, `node:sqlite` is the upgrade path behind the same
`ImpactMap` interface.

`cbd build` merges every shard for one commit; shards from different machines (CI sharding) merge
cleanly because tests do not overlap. Two shards recording one test keep the union of its touches
and warn.

**Retention.** A shard is roughly the size of the coverage it holds — tens of megabytes for a real
suite — so an unbounded `.cbd/shards` grows by that much per run. `cbd gc --keep <n>` keeps the
newest `n` shards and the newest `n` maps (default 10, ordered by mtime rather than by name) and
removes the rest. It always keeps the map `select` would read, which can be older than the newest
`n` when another branch has recorded since; deleting it would turn a working selection into "no
map". Only files directly in `shards/` and directories directly in `maps/` are candidates, so a
scratch file beside them is never touched.

### 8.2 Which changes

```ts
export function changesSince(opts: { root: string; since: string; worktree?: boolean }): Promise<Change[]>
export interface Change { path: string; status: 'A' | 'M' | 'D' | 'R'; from?: string; hunks: LineRange[] }
```

**The diff is taken from the map's commit, not from the branch base.** A map built at `X`, used on a
branch whose base is `Y`, must count every change in `X..worktree`, or a change that landed between
`X` and `Y` is invisible. `cbd select` with no map for the current base finds the nearest ancestor
commit that has one (`git rev-list --first-parent`), and reports how far back it is.

**Untracked files are changes in worktree mode.** `git diff` never lists them, and a new file is the
most common change in a working tree; leaving them out answered "nothing changed" while a new file
broke the suite (`cbd-0na.1`). `git ls-files --others --exclude-standard` supplies them as status
`A` with insertion point 0, so they flow through the normal rules — a never-seen file reaches
`unknownPolicy` (`all` by default). `--no-worktree` asks about a commit, so untracked files are not
part of that answer. The state directory is excluded: shards and maps are build artifacts, not
source changes.

### 8.3 Selection rules, in order

| case | result |
|---|---|
| the loaded config file (`cbd.config.json`, or `--config`) changed | `mode: all`, reason `config-changed` — the map was built under the old rules |
| a changed file matches `alwaysAll` globs (lockfile, `package.json`, test config, `tsconfig*`, migrations — user-configured) | `mode: all`, reason names the file |
| a changed file is touched only by `@load` or `@teardown` (startup code, global setup) | `mode: all` |
| a changed file is a test file (it defines tests the map knows, or is a helper that statically contains a registration call) | select the tests the map knows in that file and **warn that an added test cannot be named** (`testFilePolicy: 'known'`, the default); `'all'` forces the suite; a new test file the map has never seen → all |
| a changed file is in the map, and a hunk intersects a mapped function's line range | the tests that touched that function |
| a changed file is in the map, and a hunk has **any line** outside every function (imports, top-level constants, class field initializers) | every test that touched the file, **plus every test in the process that evaluated the module body** (`@load`/`@teardown`); `mode: all` when the map has no such attribution |
| a changed function in the map **also executed at load** (its key is in `@load`) | its tests, **plus every test in the process that loaded the module** (`@load` observers); `mode: all` when the map has no such attribution. `@teardown` is excluded: it runs after the tests and cannot feed them |
| a changed file a test **read**, or a file under a directory a test **listed** | the tests that read or listed it, with reason `read`; composes with the function and test-file rules. A **code file** (`.ts .tsx .js .jsx .mjs .cjs .mts .cts .vue .svelte .astro`) the map never saw is **not** answered by a read: it reaches the never-seen rule below, and the read reason is kept |
| a test declared an **opaque** dependency (`recordOpaque`) and any in-scope file changed | that test is selected, with reason `opaque` |
| a changed file — or anything under a changed directory — is marked `partial` by an incremental map | `mode: all`, reason `partial` — the evidence could not be carried |
| a changed file is in the map but no test touched it | nothing selected; reported as `untested` |
| a changed file was **never seen** by the map and matches `include` | `mode: all` by default (`unknownPolicy: 'all' \| 'ignore' \| 'file-importers'`); `unknownPolicyFor` can override per glob |
| a deleted file in the map | every test that touched it; at least as strong as a module-scope edit, so a load or teardown file selects its observers and a `@between` file obeys `betweenPolicy`. A **renamed** file also counts its old path as deleted (a copy keeps its source and does not) |
| a file touched by `@between` only | its tests cannot be known; `mode: all` by default (`betweenPolicy`) |
| a change matches an `alwaysSelect` entry's `when`, or the entry has no `when` | the named tests are added, with reason `always`; an entry the map cannot resolve forces `mode: all` and warns |
| a changed file is outside `include` and no rule claims it | ignored, and named in `selection.ignored` |
| the map is `dirty` or older than `maxAgeCommits` | the selection carries a warning; `--strict` makes it `mode: all` |

A **pure insertion** has no old-side line range — git writes it as `@@ -N,0 +M,K @@` — so it cannot
be a hunk at all. It is carried separately as an insertion point: content inserted strictly inside a
mapped function is that function's (rule 4), and content inserted outside every function is answered
by the whole file (rule 5). Dropping it made an added block invisible and selected nothing
(`cbd-81h.1`, found by the replay harness).

**A hunk is not one thing.** git groups contiguous changed lines, so renaming a constant and the
JSDoc and signature that use it can put module scope and a function's first line in a single hunk.
Rules 4 and 5 are therefore evaluated independently: the hunk contributes every function it
intersects **and** sets the file-level answer when any of its lines lies outside every function.
Classifying the whole hunk as "the function's" hid the module-scope change and selected only that
function's tests — the case where a test compares a re-exported binding and calls no function
(`cbd-73r.1`). A hunk wholly inside a function still answers precisely.

The coverage check is against the map's **old-side** function ranges. When a hunk changes its line
count *and* contains a function's first line, the new text may be module scope even though the old
line was inside the function (a statement inserted above the declaration, for example). There is no
map at the new commit to place it, so the selection widens; an insertion inside the body does not.
The V8 entry for the module body is not a source function: its range is the whole file and would
mark every hunk covered, so it is excluded from the coverage check while its tests still count as
observers.

A **changed config file** forces `mode: all` before `include` is consulted. The map was built under
the old `include`, `alwaysAll`, `alwaysSelect` and policies, so it cannot answer for a selection
whose rules have changed; the file is often outside `include`, and reporting it as merely ignored
was wrong (`cbd-73r.3`). The comparison follows real paths (a symlinked or differently-cased config
is the same file), and a config outside `--root` is checked with a targeted git query because the
relative diff cannot see it.

**Reads are a dependency without execution.** A test that greps a source file, lists a directory or
runs `tsc` over a declaration executes none of it, so coverage has no edge to draw. The adapters
install a read tracker in the test process: the public `node:fs` and `node:fs/promises` read, stat,
existence and directory-listing calls are wrapped, `syncBuiltinESMExports()` makes named ESM imports
see the wrappers, and each path is charged to the test window open at **call time**. The shard and
map carry `reads` (file) and `dirReads` (directory); a change to a read file, or to any file under a
listed directory, selects the readers. Directories are kept even when they do not match `include`,
because a file under them might.

The boundary is stated rather than implied: a reference captured before install, a native addon,
reads during test-file import or between tests, and any process the instrument never loaded in.
A **service or child process the collector holds** is no longer in that list: the instrument
installs the same tracker inside the target, drains the paths with each take, and the collector
writes them into the test record for the boundary that closes the window, beside the test
process's own reads. An instrument older than the field reports none. `alwaysSelect` remains for
what no observed process read — a tool that reads a file it was spawned with, a native addon, a
process whose environment could not be set.

**`unknownPolicyFor` is a per-glob unknown-file policy.** The first matching entry wins, so a narrow
`all` can precede a broad `ignore`; a file the map knows still follows the normal rules, which is why
this is safer than narrowing `include` (a recorded file outside `include` would stop selecting
anything). Only `all` and `ignore` are values. An ignored unknown file is named in
`selection.ignored` and a warning names the entry; an entry whose globs match no file in the
repository warns, because the list drifts the same way `alwaysSelect` does.

**An incremental map carries evidence, not guesses.** `cbd build --incremental` (and
`cbd collect --incremental`) merges a run with the previous map. A test from that map is carried when
its evidence still describes the same bytes. A touched function in a changed file is carried when its
line range maps exactly through the diff (an insertion above it shifts it; a hunk that overlaps it
does not); reads and directory listings are path-level and survive a change. Whatever the change
overlaps and the run did not re-record is dropped, and every file it used — its own spec included — is
marked `partial`; a later change to a partial file, or to anything under a partial directory, forces
`mode: all` with reason `partial`. The marker survives a chain of
incremental builds: a later run cannot heal a test that is absent from the map, because there is no
window to re-record. A dropped test that declared an opaque dependency keeps that declaration with no
evidence attached — its stale ranges and reads still go — so any in-scope change continues to select
it. The map's `@load`/`@between`/`@teardown`
buckets and its per-shard load attribution are not carried: they describe processes that no longer
exist at the new commit, so a module-scope change in a load-reached file also escalates. The trade is
explicit: a select-mode recording keeps the map usable for every file it could not touch, and never
answers a moved line with the old tests.

A **changed test file** can *add* a test the map cannot name, so the selection says what it cannot
answer: it selects the tests the map knows in that file and **warns** that a newly added one will not
run (`cbd-81h.2`; the replay found a commit adding 18 tests to two known spec files, all
unselectable). `testFilePolicy: 'all'` is the opt-in that pays for the gap with a full run. `known`
is the default because spec edits are the ordinary way this repository's commits land — **53 of the
79** measured commits in one week and **140 of 253** in one month touch a stores spec, so `all`
would make nearly every run full and give up the tool's benefit. The gap is reported, not hidden:
`select` warns, and `verify`/the replay report an unnameable test as `newTests` rather than as a
miss.

A file under a tests directory that defines no tests — a helper, a fixture builder, a macro — is
ordinary code, not a test definition. It is answered by the function rules from the map's per-test
evidence; handing it to the test-file rule asked the registry for tests it does not have and escalated
to `all` (`cbd-e9l`, where that cost 26 points of all-rate on the target suite).

A helper can define tests through a function a spec calls (`defineLedgerContract(test)`): the
`test(...)` calls live in the helper, but the runner attributes them to the spec that registered
them, so the registry cannot see the helper as a test file. The selector therefore scans a
changed, seen file that matches a test glob for a registration call (`test(`, `it(`, `suite(`,
`describe(`, including `.each`/`.skip`/`.only`) and applies the test-file rule to it. Under `known`
it selects the tests that executed code in that file and warns about an added test; under `all` it
runs the suite. The scan is textual and can miss an aliased registration; a file it misses is still
answered by the function rules, and `alwaysSelect` can name it explicitly (`cbd-0na.3`).

**Module-scope code is not confined to the functions a test called.** A test can compare a top-level
binding of a module without ever calling a function in it — the case that broke `cbd-0na.2`, where an
import-line edit selected the 22 tests of the file's only function and left out the test that
compared the module-scope binding. When the module body ran outside a test window, the map records
which tests were in that process (`shardTests` and `loadShards`); those tests shared the module instance and can
observe it. A top-level change selects their union with the function index's tests. A map built
before that attribution existed has no answer and falls back to `mode: all`, which is what rule 2
already does for a file reached *only* by `@load`. A shard marked `role: 'service'` is the
exception to "the whole process": it is not where the tests ran, and its recorder names every test
title, so only the tests that actually touched the service are observers.

`alwaysAll` is checked **before** `include`, because it is a statement that a change there is beyond
the map's ability to answer, not a filter. The example config above lists `**/migrations/**` there
although `include` covers only `src/**`; checking `include` first silently dropped those changes,
which is under-selection (`cbd-0lu` found it on the fixture's JSON data file).

**`alwaysSelect` is for tests the map can never name.** A test that reads source files as text — a
schema-dialect check, a dependency-direction scan, a grep for a forbidden token — executes no code
from the files it reads, so coverage cannot connect the two. The entry names tests (`file` or
`file > bare title`) and is added to every subset whose `when` globs match a change; with no `when`
it fires on any in-scope change. An entry the map cannot resolve is not dropped: it forces
`mode: all` and warns, so a renamed test cannot silently stop being protected. The config loader
resolves repository-relative locators and rejects malformed entries; a `when` may claim a change
outside `include`, which is what lets an entry protect a source tree the normal selection ignores
(`cbd-0na.4`).

**Environment dependencies are declared, and compared by hash.** A test that branches on
`process.env.FLAG` has no file edge: the value comes from the shell or CI, not from the diff.
`recordEnv('FLAG')` names it; the shard and the map keep a 16-hex-character hash of the value the
recording saw, never the value, and `select` compares the current environment against those hashes.
The hashes are kept **per test**, not pooled per variable: another test's recorded value says nothing
about this one, and a test id recorded under several values (a CI matrix) keeps all of them and is
selected only when the current value matches none. A variable that moved selects the declaring
test, with reason `env-changed`; the rule runs before `sharedState`, so those tests pull in their
neighbours. A test with no hash for a variable leaves it alone rather than selecting on every run.
The hash is unsalted SHA-256 truncated to 64 bits: it keeps the value out of the map, but a
low-entropy value (`1`, `true`, a region name) is recoverable by hashing candidates, so do not
declare a variable whose value must stay confidential.
An undeclared variable stays invisible, which is the same boundary as any unrecorded dependency.

**`sharedState` is for tests that depend on their neighbours.** A test that patches a module-level
value and a test that observes it are a pair; running one without the other is not a smaller run but
a different one, and coverage cannot say so. The list names files; when a change selects a test that
touched one of them, every test that touched it is added with reason `shared-state`, repeated to a
fixpoint so the result does not depend on file order, and after every other rule has added its tests. A listed file that only ran at import counts as touched by its load observers (every test when the map has no per-shard attribution). It is declared
rather than inferred on purpose: a neighbour closure over every shared module collapses to the whole
suite. It does not model ordering, and `cbd verify` remains the measurement for what a subset missed.

**Ignored is not empty.** A changed file outside `include` (and not claimed by `alwaysAll` or an
`alwaysSelect.when`) is dropped from the selection, but it is named in `selection.ignored`; without
it a consumer cannot tell "nothing changed" from "a change I was told to ignore" (`cbd-0na.6`).

**A function that ran at load can feed later tests.** A changed function that executed while the
module was imported may have computed a value (a cached table, a registered handler) that any later
test in the same process consumes, so selecting only the tests that called it again under-selects.
Such a hit also selects the file's load observers, exactly as a module-scope hunk does. Only the
`@load` bucket counts; teardown code runs after the tests.

**A read does not clear an unseen code file.** A code file coverage never saw means the recording
was incomplete, so a read or listing edge cannot prove it unaffected. It goes to the never-seen rule
and `unknownPolicy` / `unknownPolicyFor` apply as usual. A non-code file (a JSON fixture, a schema)
executes nothing by nature, so its reads still answer it.

**Japa blind spot.** Code imported by the runner entry (`bin/test.ts`) before the plugin installs
is invisible to coverage, because the recorder is not yet attached when it is evaluated. With the
rule above such files are safe, but every change to one of them runs everything. The
`--import @spikedpunch/cbd-japa/register` preload closes the gap: it starts recording before the
entry's imports run (§7.1), so those files are in the map.

A **never seen** file is the important case: a TypeScript file containing only types, a `const enum`
that the compiler inlines into its users, a SQL file, a JSON fixture read with `fs`, an environment
default. V8 cannot see any of them. `unknownPolicy: 'all'` is the safe default;
`'file-importers'` (select the tests touching any file that imports the changed file, from a static
import scan) is the useful middle ground and comes after v1.

### 8.4 Selection output

```ts
export interface Selection {
  mode: 'subset' | 'all'
  reasons: Reason[]                    // why each test is in, or why the answer is "all"
  tests: TestId[]                      // empty when mode is 'all'
  unmapped: string[]                   // changed files the map could not answer for
  untested: string[]                   // changed files the map knows no test reaches
  ignored: string[]                    // changed files outside include, and not claimed by a rule
  map: { commit: string; distance: number; dirty: boolean; builtAt: string }
}
export type Reason =
  | { kind: 'function'; file: string; fn: string; tests: number[] }
  | { kind: 'file'; file: string; tests: number[] }
  | { kind: 'test-file'; file: string; tests: number[] }
  | { kind: 'read'; file: string; tests: number[] }
  | { kind: 'always'; tests: number[] }
  | { kind: 'all'; why: 'always-all' | 'load' | 'unknown-file' | 'between' | 'stale-map' | 'no-map' | 'test-file' | 'always-unknown' | 'config-changed'; file?: string }
```

### 8.5 Other queries

`cbd`'s verbs and the exported API answer the map's two directions. The map on disk is
`<stateDir>/maps/<commit>/map.json` (or `<mapsDir>/<commit>/map.json` when `mapsDir` is set); its
shape (`CoverageMap`: `tests`, `files`, buckets, `seen`, `shardTests`, `loadShards`, `reads`,
`dirReads`, `opaque`, `partial` and `carried`) is the supported export for another tool, and every
query below is derived from it.
Paths are stored relative to the map's root and resolved when it is loaded, so a map recorded in one
worktree answers the same in another checkout of the same commit.
`mapsDir` exists for the case where the worktrees should not even carry their own copy: point it at
an absolute path (the git common directory, a CI cache) and every checkout of the commit reads the
same map, while shards and the selection file stay local.

- `reaches(title, file[:line], { file? })` — `cbd reaches` — does this one test reach the file or
  line? Returns the resolved test, the target, whether the map has seen the file, the functions of
  the target file the test executed, and every file the test reached. A line outside every function
  is answered by the file-level rule (§8.3 rule 5). A bare title that names tests in more than one
  file is **refused with the candidate files**, never guessed at; `--file` disambiguates. A mutation
  testing tool uses the same relation to check that a mutant's killer can reach it at all.
- `reachesRows(rows)` — `cbd reaches --batch` — the same relation over a list of line ranges, for a
  mutation tool: per row, the tests that executed a line in the range and whether each named killer
  is among them. A row may name a line range or a `find` string, which the CLI resolves to a line;
  an unknown file is reported as such rather than as "no tests".
- `functionsForTest(map, index)`: every function one test reached — the inverse of
  `testsForFunction`, and the data behind `cbd reaches`.
- `testsForFunction(map, file, key)`, `functionsInFile(map, file)`: the other direction.
- `testsForLine(map, file, line)`: the tests that reach one source line — the function's tests,
  or every test that touched the file when the line is outside every function (§8.3 rules 4 and
  5 at line scale). This is the blast-radius query Gate B (`cbd-2ev`) is measured with.
- `explain(map, file[:line])`: which tests reach it and how often, for humans and agents. A zero
  answer says which zero it is: seen but reached by no test, or not in the map at all — the first
  runs nothing, the second runs everything.
- `stats()` — `cbd stats` — tests; mapped functions; files reached, seen, and untested; the
  **names** of the seen files no test reaches (the inverse map's other half, rather than only its
  count); tests per test file; functions per reached file and tests per mapped function (median,
  p90, max); the most-tested files (tests and functions); buckets' sizes. It deliberately does not
  claim a coverage percentage: only *executed* functions are in the map, so there is no denominator
  over the source. A source file no recorded process ever loaded cannot be named here — the map has
  no evidence for it — and `select` runs everything for such a file, so the text output says so
  rather than letting the list read as "everything else is covered".

---

## 9. The public surface

### 9.1 Packages

| package | depends on | contents |
|---|---|---|
| `@spikedpunch/cbd` | `@jridgewell/trace-mapping` only | sources, Normalizer, Recorder, shard writer, map builder and reader, `changesSince`, `select`, queries. No test-framework imports, ever. |
| `@spikedpunch/cbd-cli` | core | the `cbd` binary |
| `@spikedpunch/cbd-japa` | core; peer `@japa/runner` ≥ 5 | the japa plugin |
| `@spikedpunch/cbd-mocha` | core; peer mocha | the `NODE_OPTIONS` auto entry and root hooks |
| `@spikedpunch/cbd-vitest` | core; peer vitest ≥ 3.2 | the setup file: one source and one shard per test file, selection by runtime skip |
| `@spikedpunch/cbd-jest` | core; peer jest ≥ 29 | the test environment (one shard per file) and the selection config helper |
| `@spikedpunch/cbd-node-test` | core; the framework as a peer | later adapter |
| `@spikedpunch/cbd-mcp` | core | optional MCP server |

(`@cbd` is a placeholder scope; check npm before settling on a name.)

### 9.2 CLI

```
cbd collect [--target <host:port|ws://url> [--allow-remote]] -- <test command>
      run a test command with CBD_SHARD and CBD_COMMIT set; with --target, the
      service coverage comes from an --inspect process reached over CDP instead
      of an instrumented socket directory. One target per run: each process to
      attach to is one debugger port, and one source reads one port.

cbd build [--commit <sha>] [--partial] [--gzip]
      merge shards for a commit into .cbd/maps/<commit>

cbd select [--since <ref>] [--worktree] [--strict] [--format json|lines|japa-args|vitest-args|jest-args]
      print the selection; exit 0 for a subset, 3 for "all", so scripts can branch on it

cbd explain <file>[:<line>]         which tests reach this, and through which functions
cbd reaches <test-title> <file>[:<line>] [--file <test-file>]
      does this one test reach the file or line? (the inverse of explain)
cbd stats [--commit <sha>]
cbd verify --since <ref> -- <full test command>
      run the full suite, then report every failing test the selection would have skipped (a miss)
cbd gc [--keep <n>]                 prune old shards and maps
cbd mcp                             start the MCP server (stdio)
```

Output follows one rule: **quiet by default, JSON on request.** A human or an agent gets one line
per question; `--format json` gives everything.

Implemented today: `build`, `select`, `explain`, `stats`, `collect` and `gc`, in
`@spikedpunch/cbd-cli`. `reaches`, `verify` and `mcp` are not built yet, and the argument
formats below `json` are not implemented either — selection reaches japa through the plugin and
mocha through `auto`, not through `--tests` (see §7.1, §7.5). `collect` resolves the selection before it spawns the suite and passes
the subset as a file named by `CBD_SELECTION`; a runner that does not read it runs the full suite,
which is safe over-selection rather than a miss.

### 9.3 Configuration — `cbd.config.json` at the repo root, committed

```jsonc
{
  "include": ["src/**", "libs/*/src/**"],
  "exclude": ["**/*.d.ts", "**/generated/**"],
  "alwaysAll": ["pnpm-lock.yaml", "**/package.json", "**/tsconfig*.json", "**/migrations/**", "tests/**/bin/*.ts"],
  "alwaysSelect": [
    { "tests": ["tests/drain.spec.ts > AC29: the drain source names no outcome-unknown column"],
      "when": ["edge/pipeline/src/**"] },
    { "tests": ["tests/pipeline.spec.ts > no file imports outside the package"],
      "when": ["edge/pipeline/src/**"] }
  ],
  // Files whose module state tests share: selecting one test that touched a listed
  // file pulls in every test that touched it.
  "sharedState": ["src/clock.ts", "src/state/**"],
  "unknownPolicy": "all",
  "unknownPolicyFor": [{ "paths": ["typescript/tools/**"], "policy": "ignore" }],
  "betweenPolicy": "all",
  "testFilePolicy": "known",
  "granularity": "test",
  "maxAgeCommits": 50,
  "stateDir": ".cbd",
  "mapsDir": "../shared/cbd-maps"
}
```

`.cbd/` is gitignored; maps are build artifacts. The file is committed, and its editor
autocomplete comes from the schema shipped with the package:

```jsonc
{ "$schema": "./node_modules/@spikedpunch/cbd/cbd.config.schema.json", ... }
```

Every key is optional and absent keys take the safe default. An unknown key, or a value the
selector does not implement, is an error rather than a silent fallback. `granularity` is `"test"`
(one window per test) or `"group"` (one window per runner group, every test in it sharing the
union); an adapter with no group boundary warns and records per test rather than collapsing the
run into one window.

### 9.4 Library use

```ts
import { createCbd } from '@spikedpunch/cbd'

const cbd = createCbd({ root })              // config bound once (ADR-0003)
const { selection } = cbd.select()           // nearest ancestor map, diffed against the worktree
if (selection.mode === 'all') runEverything(selection.reasons)
else runOnly(selection.tests)
```

The lower-level `loadMap` / `changesSince` / `select` are exported too, for a consumer that
already has a map and a diff. The adapter seam (`Recorder`, the sources, `parseShard`) is
`@spikedpunch/cbd/adapter`, explicitly unstable.

---

## 10. How other tools consume it

| consumer | how | notes |
|---|---|---|
| **A developer's inner loop** | `cbd select --format japa-args \| xargs node bin/test.ts`, or the japa plugin with `select` on | the common case |
| **CI on a pull request** | download the map for the merge base (an artifact named by commit), `cbd select`, run the subset, and run the full suite on merge to main | a missing map means `mode: all`, never a failure |
| **CI on main / nightly** | `cbd collect -- <full suite>` then `cbd build`, upload `.cbd/maps/<sha>` as an artifact | the only place maps are produced |
| **A review or fix-loop orchestrator** (dev-cli `iter` in the originating project) | the library API: changed product files → selected groups, instead of only the groups whose spec files changed | the motivating use |
| **Mutation testing** (Stryker, or a custom `mutate` script) | `reaches()` to verify a named killer can reach its mutant; `testsFor()` to run only the tests that reach each mutant | Stryker has its own per-test coverage; CBD's is useful where Stryker cannot run, such as a server in another process |
| **Coding agents** | `cbd mcp` exposes `cbd_select`, `cbd_explain`, `cbd_reaches`, `cbd_stats` as tools | an agent asks "what tests cover `KeyService.rotate`?" and gets an answer without reading test files |
| **Editors** | `cbd explain file:line --format json` behind a code lens: "covered by 12 tests" | later |
| **Flaky-test tooling** | a flaky test whose touches did not change across failing runs is flaky in itself, not from code changes | later |

---

## 11. Risks and how the design meets them

| risk | effect | mitigation |
|---|---|---|
| **Background work bleeds across tests** (an outbox poller, a timer, a request still in flight) | code credited to the wrong test, or to none | request-id correlation (ADR-0008) credits a request to the test that sent it, even when it finishes later; `takeAtStart` moves leftovers to `@between`; `settleMs`; `betweenPolicy: all`; `stats` reports the bucket's size so you know how big the problem is |
| **Tests that depend on order** | a test touches code only because an earlier test left state behind | coverage still records what really ran in that order; a reordered run can differ, so `verify` should run in the CI order |
| **Under-selection** (a real failure skipped) | the expensive failure | safe defaults (unknown → all, `@load` → all), `alwaysAll`, maps checked for age, `cbd verify` measures misses, and full runs still gate merges |
| **Overhead of precise coverage and the inspector** | slower collection runs | collection is occasional; the take cost is V8 walking every loaded function (~13 ms at VS Code's size), so only fewer takes help; `granularity: 'group'` takes once per runner group instead of twice per test — 32,039 takes became ~1,349 on the `vs/platform` scope |
| **`take()` cost grows with loaded functions** | slow per-test snapshots in a large server | `detailed: false`; filter early by URL; cache by script hash; measure per take in the spike |
| **Two coverage tools on one isolate** | wrong or empty counts | adapters refuse to start when the framework's own V8 coverage is on |
| **Source maps missing or wrong** | touches attributed to `dist/` files, or the wrong lines | fall back to the generated file and report it in `stats`; never guess |
| **A debugger port exposed (fallback path only)** | remote code execution on the server | injection is the default and opens no TCP port; the attach path binds loopback unless `allowRemote`, and is collection-only |
| **The instrument must be resolvable from the target** | a target that cannot resolve it records nothing for its process | it is published as a subpath of the package the test side already depends on; a target whose environment genuinely cannot be set uses the attach fallback |
| **Multi-process servers** | code in a worker process is invisible | a list of targets; `stats` cannot see what was not attached, so the docs say it |

---

## 12. Build plan

Staged so that each stage ends in something that runs. Estimates are working days for one developer,
before reviews.

### Stage 0: Spike (about 1 day)
**Goal**: prove the four assumptions the design rests on, on a real suite.
**Success Criteria**:
- S1: `takePreciseCoverage` with `callCount: true` returns per-window deltas, in-process; record the
  per-take time on the largest available suite. (The out-of-process half is the injection spike and
  the attach fallback; see ADR-0005 and `cbd-a3v.4`.)
- S2: a japa plugin's `test.setup` hook (and its returned cleanup) brackets each test, awaited, for
  top-level and grouped tests; `runEnd` can be awaited.
- S3: source maps from a TypeScript loader (inline) and from `tsc` output (`.map` files) map function
  starts back to the right `.ts` lines.
- S4: overhead of a full collection run against the same run without CBD.
- S5: prior art — confirm no existing open-source, framework-neutral library already does this.
**Tests**: throwaway scripts; the results go in a `SPIKE.md`.
**Status**: Not Started

### Stage 1: Core sources and Normalizer (2 days)
**Goal**: `inProcessSource`, `socketSource` with the injected instrument module, `normalize()` with
source maps and stable function keys. (`inspectorSource` is the attach fallback for a target whose
environment cannot be set.)
**Success Criteria**: a fixture project with a TS loader and a `dist/` build yields the expected
`(file, fn)` touches for known calls; a function not called in a window is absent.
**Tests**: fixture-driven unit tests; one test starts a fixture server the way a developer does, with
`NODE_OPTIONS`, and reads it over the socket.
**Status**: Not Started

### Stage 2: Recorder, shards, build, map reader (1.5 days)
**Goal**: buckets, the shard format, `cbd build`, `loadMap`.
**Success Criteria**: a scripted run of three tests and a background timer produces the right
per-test touches and a non-empty `@between`; an interrupted shard is refused.
**Tests**: unit tests over the Recorder with a fake source; round-trip shard → map → queries.
**Status**: Not Started

### Stage 3: Selection and the CLI (1.5 days)
**Goal**: `changesSince`, `select` with every rule in section 8.3, `cbd select / explain / reaches /
stats / verify`.
**Success Criteria**: one table-driven test per row of section 8.3; `verify` reports a planted miss.
**Tests**: a fixture git repository built in a temp directory per test.
**Status**: `build` / `select` / `explain` / `stats` / `collect` implemented (`cbd-63j`, `cbd-pfu`).

### Stage 4: The japa adapter (1 day)
**Goal**: `@spikedpunch/cbd-japa` collecting and selecting.
**Success Criteria**: collect on a real japa suite (the originating project's stores suites, through
its lane mechanism), then for five historical commits `cbd verify` reports zero misses and the
selection ratio is recorded.
**Tests**: a fixture japa project run end to end.
**Status**: Not Started

### Stage 5: Documentation and release (0.5 day)
**Goal**: README with a five-minute quickstart for japa, the config reference, the adapter protocol
for writing new adapters, and the blind spots of section 8.3 stated plainly.
**Status**: Not Started

**Total**: about 7.5 days plus the spike, plus review rounds. The node:test, Vitest, Jest and Mocha
adapters and the MCP server are about a day each, after v1.

### Measuring success

- **Miss rate**: across N real commits, failing tests the selection skipped, from `cbd verify`.
  Target zero; any miss is a bug with a reproduction.
- **Selection ratio**: selected tests over all tests, median and 90th percentile across those
  commits. This is the payoff; report it honestly, including commits that went `mode: all`.
- **Time saved**: wall-clock of the subset against the full run.

---

## 13. What is verified and what is assumed

**Verified** by reading the installed packages (`@japa/runner` 5.0.0, `@japa/core` 10.4.0) in the
originating project:
- the japa plugin signature;
- `Test.executing` / `Test.executed` are called with `forEach` and not awaited;
- the awaited hook points `test.setup/teardown`, `group.each.setup/teardown`, `runner.onSuite`,
  `suite.onGroup`, `suite.onTest`, `group.tap`;
- the emitter's `test:start` / `test:end` events.

The originating project's dev-cli builds its server's environment from a template, so injection is
one line there and nothing in the server's source changes. It has since been exercised end to end on
that suite (`cbd-a3v`: 391/391, 112 server functions reached by exactly one test).

**Exercised since this was written**:
- `takePreciseCoverage` resetting counts when `callCount: true`;
- `Debugger.scriptParsed` carrying `sourceMapURL`;
- the in-process inspector's `post` completing synchronously, including inside `process.on('exit')`;
- the instrument module, its unix socket, and the snapshot a dying process leaves (ADR-0007);
- `/json/list` target discovery and the CDP WebSocket client, against a fixture started with
  `--inspect=0` (the shared source contract suite runs against it).

**Assumptions the design rests on**: two Profiler sessions on one isolate interfere (measured:
counters split); the map's size and parse time; the overhead of a recorded run (`cbd-7yd`); prior
art (S5) was not surveyed before this document was written.
