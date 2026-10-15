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
   running in a separate Node process the tests talk to (an HTTP server started with `--inspect`).
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
- **Works on a process you did not start through the test runner.** A server started with
  `--inspect` exposes the same Profiler domain over the Chrome DevTools Protocol (CDP). Istanbul
  would need that server's build instrumented and a way to pull its global `__coverage__` object
  out per test.
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
- The inspector's in-process `post` may complete synchronously on the main thread. If the spike
  confirms that, a source can expose a `takeSync()` usable from hooks a framework does not await
  (section 7.1). Do not rely on it until measured.

### 4.3 `inspectorSource({ url } | { host, port })` — a separate Node process

CDP over WebSocket to a process started with `--inspect=127.0.0.1:<port>` (or `--inspect=0`, port
read from its stderr line `Debugger listening on ws://…`). The target list comes from
`http://<host>:<port>/json/list`. Node 22 has a global `WebSocket`; on older Node, use the `ws`
package.

- This is what makes black-box suites work: the tests send HTTP requests, the server's code runs,
  and the per-test window is taken from the server.
- **Requirement: one test runner per server during collection.** Two runners hitting one server
  make attribution meaningless. CBD cannot detect this; the docs must say it, and `cbd collect`
  should refuse to attach to a target another collector already holds (a lock file keyed by the
  target URL).
- Multi-process servers (cluster, worker pools, child processes): each process needs its own
  `--inspect` port and its own source. v1 supports a list of targets; discovery is the user's job.
- Security: `--inspect` gives full code execution to anyone who can reach the port. Bind to
  `127.0.0.1` only; the source refuses a non-loopback host unless `allowRemote: true`.

### 4.4 Later sources (designed for, not in v1)

- `nodeV8CoverageSource` — for child processes you cannot attach to: launched with
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
  granularity?: 'test' | 'group' | 'file'   // default 'test'
  settleMs?: number                         // wait before testEnd's take, for trailing async work; default 0
  takeAtStart?: boolean                     // default true: a take at testStart moves leftovers to @between
}

export class Recorder {
  constructor(opts: RecorderOptions)
  runStart(meta: RunMeta): Promise<void>        // starts sources; next take goes to @load
  testStart(id: TestId): Promise<void>
  testEnd(id: TestId, outcome: Outcome): Promise<void>
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
- **Duplicates** get an `ordinal`; `cbd stats` lists them, since a renamed duplicate shifts ordinals.
- **Renames** look like a deleted test plus a new unmapped test. A new test file or test is
  `unmapped` and is always selected (section 8.3).

### 6.3 Shard format

`.cbd/shards/<UTC timestamp>-<random>.jsonl`, one JSON object per line:

```jsonc
{"t":"run","v":1,"framework":"japa","commit":"3c5a43e6…","dirty":false,"sources":["in-process","server@127.0.0.1:9229"],"startedAt":"2026-10-15T20:41:02Z"}
{"t":"file","f":"src/keys/KeyService.ts","h":"sha256:…","fns":[["encrypt@0",40,88],["rotate@0",90,131],["@module",1,400]]}
{"t":"test","id":"japa:key-server:tests/key-store.spec.ts::rotation > rotates on 64GB","status":"passed","ms":412,"touch":{"src/keys/KeyService.ts":[0,1],"src/db/Pool.ts":[3]}}
{"t":"bucket","id":"@load","touch":{"src/keys/KeyService.ts":[2]}}
{"t":"bucket","id":"@between","touch":{"src/outbox/Poller.ts":[0]}}
{"t":"end","tests":214,"seconds":151.2,"overheadSeconds":19.7}
```

- `file` records are emitted the first time a file is seen; `fns` is `[key, startLine, endLine]`,
  and touches reference functions by index into it. That keeps a 1,000-test shard small.
- A shard with no `end` record was interrupted: `cbd build` refuses it unless `--partial`, and says so.
- A shard from a dirty tree is accepted but its map is marked `dirty`; selection warns.

---

## 7. Adapters

An adapter's whole job: compute a `TestId`, call the Recorder at the right moments, and make sure
those calls are awaited. Target size: 100–200 lines each.

### 7.1 japa (`@cbd/japa`)

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

The plugin:

```ts
import { cbd } from '@cbd/japa'
import { inProcessSource, inspectorSource } from '@cbd/core'

configure({
  suites: [...],
  plugins: [
    cbd({
      enabled: process.env.CBD === '1',            // off by default: zero cost when not collecting
      root: repoRoot,
      sources: () => [
        inProcessSource(),
        ...(process.env.CBD_INSPECT ? [inspectorSource({ url: process.env.CBD_INSPECT })] : []),
      ],
      granularity: 'test',
    }),
  ],
})
```

Wiring inside the plugin:

```ts
export function cbd(opts: CbdJapaOptions): PluginFn {
  return async ({ runner, emitter }) => {
    if (!opts.enabled) return
    const rec = new Recorder({ ...opts, sources: opts.sources() })
    const outcomes = new Map<string, Outcome>()
    emitter.on('test:end', p => outcomes.set(keyFromPayload(p), toOutcome(p)))
    emitter.on('runner:start', () => rec.runStart({ framework: 'japa' }))   // or awaited in the plugin body
    runner.onSuite(suite => {
      const wrap = (test: Test) => test.setup(async () => {
        const id = idOf(suite, test)
        await rec.testStart(id)
        return async () => rec.testEnd(id, outcomes.get(testKey(id)) ?? { status: 'passed' })
      })
      suite.onTest(wrap)
      suite.onGroup(group => group.tap(wrap))
    })
    // runEnd: on runner:end, awaited through the runner's end hook; see spike item S2
  }
}
```

Open points for the spike (S2): whether a setup hook's returned cleanup runs after the test's own
teardown and before `test:end`; whether `onSuite` registration happens before test files are
imported; and how to await `runEnd` (a runner teardown hook, or `runner.onEnd`, whichever exists).

**Selection with japa.** Two ways, both supported:

1. `cbd select --format japa-args` prints `--files … --groups … --tests …` for the runner's own
   filters. Simple and visible; long selections hit argv limits, so it falls back to `--files` only
   past a threshold, which over-selects but never under-selects.
2. The plugin with `select: { since: 'origin/main' }` loads the map, computes the selection, and
   applies it as the runner's filters (or skips non-selected tests itself), printing
   `cbd: running 37 of 1,214 tests (12 changed functions in 4 files); full list: .cbd/last-selection.json`.
   When the selection is `mode: "all"`, it prints the reason and changes nothing.

### 7.2 node:test (`@cbd/node-test`)

`beforeEach` / `afterEach` hooks are awaited. Ship a module to preload with
`node --import @cbd/node-test/register --test`, which installs global hooks in each test file's
process (node:test runs files in subprocesses by default, so each has its own in-process source and
its own shard). The test ID comes from the `TestContext` (`t.name`, `t.fullName` on Node ≥ 22.3).

### 7.3 Vitest (`@cbd/vitest`)

A `setupFiles` entry with `beforeEach` / `afterEach` (awaited), using `expect.getState()` /
`task` for the ID. One source per worker. Vitest's own `@vitest/coverage-v8` must be off during a
CBD collection: two Profiler sessions on one isolate interfere (assumed; verify).

### 7.4 Jest (`@cbd/jest`)

A custom `testEnvironment` wrapping the project's one, implementing `handleTestEvent`, which Jest
awaits: `test_start` → `testStart`, `test_done` → `testEnd`. The ID comes from the event's test and
its parent `describe` blocks. Jest's `--coverage` off during collection, for the same reason.

### 7.5 Mocha (`@cbd/mocha`)

A root hook plugin (`--require @cbd/mocha/register`) with `beforeEach` / `afterEach`, using
`this.currentTest.titlePath()`.

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

### 8.2 Which changes

```ts
export function changesSince(opts: { root: string; since: string; worktree?: boolean }): Promise<Change[]>
export interface Change { path: string; status: 'A' | 'M' | 'D' | 'R'; from?: string; hunks: LineRange[] }
```

**The diff is taken from the map's commit, not from the branch base.** A map built at `X`, used on a
branch whose base is `Y`, must count every change in `X..worktree`, or a change that landed between
`X` and `Y` is invisible. `cbd select` with no map for the current base finds the nearest ancestor
commit that has one (`git rev-list --first-parent`), and reports how far back it is.

### 8.3 Selection rules, in order

| case | result |
|---|---|
| a changed file matches `alwaysAll` globs (lockfile, `package.json`, test config, `tsconfig*`, migrations — user-configured) | `mode: all`, reason names the file |
| a changed file is touched only by `@load` or `@teardown` (startup code, global setup) | `mode: all` |
| a changed file is a test file | select every test in that file; a new test file → all its tests |
| a changed file is in the map, and a hunk intersects a mapped function's line range | the tests that touched that function |
| a changed file is in the map, and a hunk is outside every function (imports, top-level constants, class field initializers) | every test that touched the file |
| a changed file is in the map but no test touched it | nothing selected; reported as `untested` |
| a changed file was **never seen** by the map and matches `include` | `mode: all` by default (`unknownPolicy: 'all' \| 'ignore' \| 'file-importers'`) |
| a deleted file in the map | every test that touched it |
| a file touched by `@between` only | its tests cannot be known; `mode: all` by default (`betweenPolicy`) |
| the map is `dirty` or older than `maxAgeCommits` | the selection carries a warning; `--strict` makes it `mode: all` |

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
  map: { commit: string; distance: number; dirty: boolean; builtAt: string }
}
export type Reason =
  | { kind: 'function'; file: string; fn: string; tests: number[] }
  | { kind: 'file'; file: string; tests: number[] }
  | { kind: 'test-file'; file: string }
  | { kind: 'all'; why: 'always-all' | 'load' | 'unknown-file' | 'between' | 'stale-map' | 'no-map'; file?: string }
```

### 8.5 Other queries

- `reaches(map, test, file, line?)` → boolean: does this test execute that function? A mutation
  testing tool uses it to check that the test named as a mutant's killer can reach the mutant at all,
  and to choose which tests to run against each mutant.
- `testsFor(map, file, fn?)`, `filesFor(map, test)`: the two directions of the map.
- `explain(map, file[:line])`: which tests reach it and how often, for humans and agents.
- `stats(map)`: tests, files, unmapped files under `include`, the share of tests per file (a file
  every test touches selects everything and is worth knowing about), buckets' sizes, collection
  overhead.

---

## 9. The public surface

### 9.1 Packages

| package | depends on | contents |
|---|---|---|
| `@cbd/core` | `@jridgewell/trace-mapping` only | sources, Normalizer, Recorder, shard writer, map builder and reader, `changesSince`, `select`, queries. No test-framework imports, ever. |
| `@cbd/cli` | core | the `cbd` binary |
| `@cbd/japa` | core; peer `@japa/runner` ≥ 5 | the japa plugin |
| `@cbd/node-test`, `@cbd/vitest`, `@cbd/jest`, `@cbd/mocha` | core; the framework as a peer | later adapters |
| `@cbd/mcp` | core | optional MCP server |

(`@cbd` is a placeholder scope; check npm before settling on a name.)

### 9.2 CLI

```
cbd collect [--target ws://127.0.0.1:9229/… ...] [--listen <port>] -- <test command>
      run a test command with CBD=1 and inspector targets passed through the environment;
      print one line at the end: tests recorded, overhead, shard path

cbd build [--commit <sha>] [--partial] [--gzip]
      merge shards for a commit into .cbd/maps/<commit>

cbd select [--since <ref>] [--worktree] [--strict] [--format json|lines|japa-args|vitest-args|jest-args]
      print the selection; exit 0 for a subset, 3 for "all", so scripts can branch on it

cbd explain <file>[:<line>]         which tests reach this, and through which functions
cbd reaches <test-key> <file>[:<line>]
cbd stats [--commit <sha>]
cbd verify --since <ref> -- <full test command>
      run the full suite, then report every failing test the selection would have skipped (a miss)
cbd gc [--keep <n>]                 prune old shards and maps
cbd mcp                             start the MCP server (stdio)
```

Output follows one rule: **quiet by default, JSON on request.** A human or an agent gets one line
per question; `--format json` gives everything.

### 9.3 Configuration — `cbd.config.json` at the repo root, committed

```jsonc
{
  "include": ["src/**", "libs/*/src/**"],
  "exclude": ["**/*.d.ts", "**/generated/**"],
  "alwaysAll": ["pnpm-lock.yaml", "**/package.json", "**/tsconfig*.json", "**/migrations/**", "tests/**/bin/*.ts"],
  "unknownPolicy": "all",
  "betweenPolicy": "all",
  "granularity": "test",
  "maxAgeCommits": 50,
  "stateDir": ".cbd"
}
```

`.cbd/` is gitignored; maps are build artifacts.

### 9.4 Library use

```ts
import { loadMap, changesSince, select } from '@cbd/core'

const map = await loadMap({ root, near: 'HEAD' })              // nearest ancestor commit with a map
const changes = await changesSince({ root, since: map.commit, worktree: true })
const selection = select(map, changes, config)
if (selection.mode === 'all') runEverything(selection.reasons)
else runOnly(selection.tests)
```

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
| **Background work bleeds across tests** (an outbox poller, a timer, a request still in flight) | code credited to the wrong test, or to none | `takeAtStart` moves leftovers to `@between`; `settleMs`; `betweenPolicy: all`; `stats` reports the bucket's size so you know how big the problem is |
| **Tests that depend on order** | a test touches code only because an earlier test left state behind | coverage still records what really ran in that order; a reordered run can differ, so `verify` should run in the CI order |
| **Under-selection** (a real failure skipped) | the expensive failure | safe defaults (unknown → all, `@load` → all), `alwaysAll`, maps checked for age, `cbd verify` measures misses, and full runs still gate merges |
| **Overhead of precise coverage and the inspector** | slower collection runs | collection is occasional; measure in the spike; `granularity: 'group'` halves the takes |
| **`take()` cost grows with loaded functions** | slow per-test snapshots in a large server | `detailed: false`; filter early by URL; cache by script hash; measure per take in the spike |
| **Two coverage tools on one isolate** | wrong or empty counts | adapters refuse to start when the framework's own V8 coverage is on |
| **Source maps missing or wrong** | touches attributed to `dist/` files, or the wrong lines | fall back to the generated file and report it in `stats`; never guess |
| **`--inspect` exposed** | remote code execution on the server | loopback only unless `allowRemote`; collection only, never in production |
| **Multi-process servers** | code in a worker process is invisible | a list of targets; `stats` cannot see what was not attached, so the docs say it |

---

## 12. Build plan

Staged so that each stage ends in something that runs. Estimates are working days for one developer,
before reviews.

### Stage 0: Spike (about 1 day)
**Goal**: prove the four assumptions the design rests on, on a real suite.
**Success Criteria**:
- S1: `takePreciseCoverage` with `callCount: true` returns per-window deltas, in-process and over
  CDP to an `--inspect` server; record the per-take time on the largest available suite.
- S2: a japa plugin's `test.setup` hook (and its returned cleanup) brackets each test, awaited, for
  top-level and grouped tests; `runEnd` can be awaited.
- S3: source maps from a TypeScript loader (inline) and from `tsc` output (`.map` files) map function
  starts back to the right `.ts` lines.
- S4: overhead of a full collection run against the same run without CBD.
- S5: prior art — confirm no existing open-source, framework-neutral library already does this.
**Tests**: throwaway scripts; the results go in a `SPIKE.md`.
**Status**: Not Started

### Stage 1: Core sources and Normalizer (2 days)
**Goal**: `inProcessSource`, `inspectorSource`, `normalize()` with source maps and stable function keys.
**Success Criteria**: a fixture project with a TS loader and a `dist/` build yields the expected
`(file, fn)` touches for known calls; a function not called in a window is absent.
**Tests**: fixture-driven unit tests; one test spawns a fixture server with `--inspect=0`.
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
**Status**: Not Started

### Stage 4: The japa adapter (1 day)
**Goal**: `@cbd/japa` collecting and selecting.
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

The originating project starts its test server with `spawn(process.execPath, ['dist/Server'])`, so
an `--inspect` flag can be added at that point.

**From V8 / Node documentation, not yet exercised here**:
- `takePreciseCoverage` resetting counts when `callCount: true`;
- `Debugger.scriptParsed` carrying `sourceMapURL`;
- `/json/list` target discovery;
- Node 22's global `WebSocket`.

**Assumptions for the spike to confirm or kill**:
- the in-process inspector's `post` completing synchronously;
- the japa setup-cleanup ordering relative to `test:end`;
- two Profiler sessions interfering;
- the size and parse time of a map;
- the overhead figures.

**Not looked for yet**: prior art (S5).
