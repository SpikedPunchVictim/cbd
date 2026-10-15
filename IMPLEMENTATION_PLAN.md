# CBD — spike implementation plan

Scope: **prove the pipeline end to end and take the measurements that decide viability**,
before committing to the full build in CBD.md §12. Two phases, in order:

- **Phase A — fixture.** Build and debug the whole pipeline against a purpose-built
  fixture where a full cycle is seconds. This is where correctness gets shaken out.
- **Phase B — measurement.** Point the working pipeline at VS Code (`src/vs/platform`)
  and record the real numbers. Not a debugging session.

Target use case under test throughout (narrowed from CBD.md by the user, 2026-10-15):
**unit tests only, not integration tests.** Consequences applied below:
`inspectorSource`/CDP, `--target`/`--listen`, the HTTP control server and `browserSource`
are all **out of scope** — they exist for out-of-process suites. `inProcessSource` only.

Goal metric: `E[time] = P(all)·T_full + (1 − P(all))·T_subset` on a ~20 min suite that
should be ~2 min. See `.explore/FINDINGS.md` §7.

---

## Design amendments forced by measurement (before any code)

These came out of `.explore/` and the VS Code recon, and are preconditions for the
relevant stages rather than optional polish.

1. **Path projection for `outDir` builds (blocker for Phase B).** VS Code sets
   `"sourceMap": false` and its node tests execute `out/vs/**/*.js` while git tracks
   `src/vs/**/*.ts`. With no map, §5.3 keys the map by `out/…` and `changesSince` returns
   `src/…`, so nothing intersects and every change is "never seen" → `mode: all` forever.
   Fix: a `(outDir, srcDir, extMap)` projection *in addition to* source-map resolution.
   For 1:1 builds it is a pure string transform and needs no map at all.
2. **`unknownPolicy` must be graduated, not binary.** Measured per-commit all-rate 7–49%
   (median ~19%) at whole-repo scope, compounding to a ~2.4% subset rate at a 10-commit
   window. Needs an asset class that never forces `all`, not just `all | ignore`.
3. **Hunk-aware `alwaysAll`.** `"version"`-only `package.json` hunks should not trigger
   `all`; dependency/engines/scripts hunks should. Worth 17–20% of package.json commits
   in changesets repos (`FINDINGS.md` §3).
4. **Path-convention owners for data files.** `__snapshots__/foo.test.ts.snap` →
   the test in `foo.test.ts`; fixtures under a test dir → the owning test. Removes the
   largest genuinely-unit-test-relevant unknown class.
5. **Adapter lifecycle handlers must be synchronous (A0 F1/F2).** japa calls
   `emitter.emit('test:end', …)` **without awaiting** it, so an async handler runs past
   the window boundary — measured: all five async listeners finished *after* `suite:end`.
   Coverage must be taken with a synchronous `takeSync()`, which the in-process inspector
   supports. This is the controlling constraint on the adapter's shape.
6. **`Source` carries both `takeSync()` and an async `take()` (A0 F9).** The sync member is
   what japa requires; the async member is the seam that keeps out-of-process/integration
   collection reachable later without a breaking change. Cheap now, load-bearing then.

## Spike facts already established

- `takePreciseCoverage` with `callCount: true` **resets** — per-window deltas are real (S1a).
- The in-process inspector `post` **is synchronous** — `takeSync()` is viable from hooks
  a framework does not await (S1b).
- `Debugger.scriptParsed` carries `sourceMapURL` (inline `data:` maps work).
- Take cost tracks loaded **functions**, not scripts: ~2 ms/take at 20k loaded functions,
  ~4.5 ms at 50k, ~6 ms at 100k. URL filtering cannot reduce take cost; fewer takes can.
- Registry reachable. `@japa/runner` **5.4.0** installed, `@japa/core` 10.4.0,
  `@jridgewell/trace-mapping` 0.3.31.
- **Stage A0 (see `.explore/A0-japa-hooks.md`)**: japa does not await `emit` (F1);
  `takeSync()` confirmed working inside a real hook (F2); per-test deltas and the inverse
  map proven correct end to end (F3); all six §13 hook names exist in 5.4.0, plus
  `Test.cleanup` and `group.setup/teardown` (F4); `test:cleanup` is a phase label, not an
  event (F5); `getActiveTest()` is `undefined` in hooks (F6); a japa **plugin** receives
  the emitter, so the adapter needs no changes to user test files (F7); `runner.onSuite` /
  `suite.onTest` / `suite.onGroup` / `group.tap` fire at *import* time, giving the
  test→file map for free (F8).

---

## Phase A — fixture

### Stage A0: toolchain and hook facts
**Goal**: confirm the environment, and re-verify the japa hook facts the adapter rests on.
**Success criteria**: pnpm workspace installs; a japa suite runs and reports; the hook
points named in CBD.md §13 exist and behave, against the *installed* version
(`test.setup/teardown`, `group.each.setup/teardown`, `runner.onSuite`, `suite.onGroup`,
`suite.onTest`, `group.tap`, `test:start`/`test:end`, and whether `test:end` is awaited).
**Tests**: a throwaway japa suite that logs hook order, committed as a fixture test.
**Outcome**: complete. Findings in `.explore/A0-japa-hooks.md`, probe in `probe/`.
All success criteria met, with two results that change the design: `emit` is **not**
awaited (F1), so handlers must be synchronous, and the plugin receives the emitter (F7),
so the adapter needs no user-facing changes. The probe also proved per-test deltas and the
inverse map correct end to end (F3) — earlier and more cheaply than A2/A3 would have.
**Status**: Complete

### Stage A1: the fixture project
**Goal**: a small TS package that reproduces the shapes the Normalizer must handle.
**Success criteria**: ~40–80 test files under japa in one process; shared helper modules
used by many tests (the cross-cutting selection case); a `.snap`-style golden file; a JSON
fixture read with `fs`; a type-only module; and **two build outputs — one with source maps,
one without** — so amendment 1 is exercised rather than assumed. Own git repo, so
`changesSince` can be tested against real history.
**Tests**: the fixture's own suite runs green; a script asserts both build outputs load.
**Outcome**: complete, in `fixture/`. **15 spec files, 43 tests (42 pass, 1 skipped)**, run
green from *both* builds — 29 compiled modules each.
Shapes covered: cross-cutting helpers on both sides (`src/helpers.ts`, `tests/support/harness.ts`);
a two-hop chain (test → `strings` → `helpers`); a barrel (`src/index.ts`); a JSON fixture
read with `fs` (`data/settings.json`); a `.snap` golden file under `__snapshots__/`;
a type-only module imported with `import type`; a module with import-time work (`@load`);
an never-imported module (`src/uncovered.ts`); an unimported asset (`assets/theme.css`);
nested directories; generics and callbacks; async/timer paths.
`scripts/check-builds.mjs` asserts the difference structurally — out-maps pairs every `.js`
with a `sourceMappingURL`, out-nomaps has none — and was verified to *fail* when the
premise is broken, rather than passing vacuously.

Two deviations from the criteria as written, both deliberate:

- **15 spec files, not 40–80.** A1's job is *shape* diversity, and 15 files cover every class
  the selector must handle. Scale belongs to B1 (a real repo) and to an optional generator
  if A3's map-size numbers turn out to need it. Uniform generated files would have added
  volume without adding a single new shape.
- **No git history yet.** The fixture is a normal tracked directory rather than a nested
  git repo: a nested `.git` inside this repo is a submodule-shaped headache, and a
  *scripted* history in a temp directory is both deterministic and real git. But the
  script's exact content is dictated by which commit shapes A4's tests need (a version-only
  `package.json` bump, hunks with accumulating offsets, a rename-with-modification), so
  writing it now would be guessing. **Moved to A4**, where it has a consumer.
**Status**: Complete

### Stage A2: sources and Normalizer
**Goal**: from a running test, get a stable set of `(file, function)` touches.
**Success criteria**: `inProcessSource` returns per-window deltas; `normalize()` filters by
URL, keeps functions with count > 0, maps back through source maps **and** through path
projection, and yields `name@ordinal` keys stable across edits elsewhere in the file.
**Tests**: fixture-driven units; a function not called in a window is absent; the
same fixture normalized from the no-source-map build produces the same `src/` keys.
**Outcome**: complete, in `packages/core`. 29 tests green. `inProcessSource` with both
`takeSync()` and async `take()` (amendment 6), `normalize`, `scan`, path projection and
source-map resolution.

**The stage's central result.** The collector runs the fixture's suite twice — once per
build — and normalises each test's window in both. `out-maps` resolves 177 touches through
source maps and 0 by projection; `out-nomaps` resolves 0 through maps and 177 by
projection; and the two produce **byte-identical key sets for all 43 tests**. Amendment 1
is no longer a design note.

Attribution is transitive and specific: `toSlug delegates to the shared slug helper`
yields both `src/strings.ts::toSlug@0` and `src/helpers.ts::slug@0`, and 8 tests reach
`src/helpers.ts` — the cross-cutting case a filename rule cannot express.

Three findings that changed the code:

1. **V8 reports zero-count functions inside any script that has coverage.**
   (`.explore/spike/ordinal-probe.mjs`: three same-named `parse` methods, counts 0, 1, 0.)
   So ordinals are assigned over the file's *whole* function list, not the executed subset —
   otherwise a window running only the middle `parse` would call it `parse@0` while a window
   running both would call it `parse@1`, and keys would drift on every selection. `scan` is
   therefore the primitive and `normalize` is a filter over it, which also makes the inverse
   map free.
2. **`originalPositionFor` returns `source` in its RESOLVED form** — a `file:` URL — not the
   raw string in `map.sources`. Keying a lookup table on the raw form makes every lookup
   miss, and the script then resolves to nothing at all, silently. Cost an hour.
3. **`tsc` does not clean its `outDir`.** Turning `sourceMap` off left the previous build's
   `.map` files behind, so the no-maps build still had maps. Caught by A1's
   `check-builds.mjs` guard doing exactly its job; `build.mjs` now removes the output
   directory first.

A useful negative result: **no module body ever appears in a test window.** Every module is
imported before the first test starts, so the module body's count is 0 in every window. That
is the `@load` bucket separating cleanly from per-test attribution, and it means a
`<module>@0` touch in a window is a real signal that a test lazily loaded something.
**Status**: Complete

### Stage A3: Recorder, shards, build, map reader
**Goal**: bucket assignment and the on-disk map.
**Success criteria**: three tests plus a background timer produce the right per-test
touches and a non-empty `@between`; an interrupted shard is refused; `cbd build` merges
and `loadMap` reads back; map bytes and parse ms recorded.
**Tests**: unit tests over the Recorder with a fake source; shard → map → query round trip.
**Outcome**: complete. 56 core tests green. `Recorder`, the append-only shard with its
completeness footer, `buildMap`/`saveMap`/`loadMap`, and `testsForFunction`.

On the fixture, a real run records **43 tests (42 passed, 1 skipped)**, **28 `@load`
touches** and **8 `@between`**; the map is ~11 KB over 26 files and holds the 42 green tests.
The skipped test is recorded and then excluded from the map, which is amendment 5 working.

Three findings, two of them bugs in what I had written:

1. **`@load` cannot be taken when the shard header is written.** I had `runStart()` take a
   window, on the reasoning that it is called before the test files import. It is — but the
   take lands *before* those imports, so it captured nothing and the entire load phase was
   misfiled as `@between` (28 touches in the wrong bucket). The load window closes at the
   **first `testStart`**, which is where it is now captured.
2. **A skipped test emits start and end with `hasError: false`.** Mapping on `hasError`
   alone recorded the fixture's skipped test as a passing one with an empty window — the
   exact hazard amendment 5 exists for. `classifyStatus` now takes `isSkipped`/`isTodo` too.
3. **`group.each.setup` runs outside the test window** — between one test's end and the
   next one's start. So whatever it touches is unattributable and lands in `@between`,
   where the selector must treat it as reaching every test. Conservative, but it means a
   suite that leans on per-test setup inflates `@between`, and that is worth knowing before
   trusting an all-rate. Worth revisiting in A4.

Also: the import phase is not exclusively module bodies — a `test.group` definition callback
runs there too — so the useful invariant is narrower: a module body never appears *inside* a
test window.
**Status**: Complete

### Stage A4: diff, select, verify
**Goal**: every rule in §8.3, plus the money shot.
**Success criteria**: one table-driven test per rule row; the hunk-coordinate case
(three hunks, accumulating offsets — must use **old-side** line numbers) passes; a
rename-with-modification selects the tests touching `from`; `verify` reports a
deliberately planted miss.
**Tests**: a fixture git repo built in a temp directory per test, as §12 Stage 3 specifies.
**Outcome**: complete. 89 core tests green. `changesSince` (parsing `git diff -U0` directly),
`select` with all ten §8.3 rows, and `verify`. Temp git repos per test, real `git`, no stubs.

**The bug this stage found is the most serious of the project so far.**

`name@ordinal` was silently wrong. I had assumed — and the ordinal probe *seemed* to confirm —
that a take reports a script's whole function list, so ordinals could be computed from any
window. They cannot. V8 reports the full list only on the take following a script's
compilation; afterwards it reports only what had activity. Measured on the fixture's
`src/helpers.js`: a mid-run take reported **two** functions where the file has six.

The consequence was not a missing entry but a **collision**. Two different anonymous arrows,
each the only anonymous function in its own window, both became `<anonymous>@0`; merging by key
fused them into a single function spanning lines 8–24 — which then matched any hunk in between
and selected the wrong tests. A change to `slug` selected eight tests instead of two.

The fix is a per-script ordinal registry, seeded on first sighting and consulted thereafter,
keyed by generated offset (exact within a process, where offsets never move). CBD.md §6.3's
`file` record exists for precisely this. After the fix every function has one coherent range and
exactly its enclosing function's test set.

**Known limitation, recorded rather than papered over:** the first sighting is not always
complete either — during import, a take already omitted one arrow — so a late-appearing function
gets an appended ordinal rather than its source-order one. Ordinals are therefore deterministic
for a given build and suite, which is all selection needs (the map is rebuilt per commit, and a
hunk is matched against line ranges, never against another map's keys), but they are not
guaranteed to survive an arbitrary edit elsewhere in the file as CBD.md hoped. Fixing that
properly means deferring key assignment to `cbd build`, where the union over every window is
known. **Worth doing before the map is relied on across a long-lived branch.**

Two smaller findings:

- A change with no content — a mode change, a pure rename — emits no `---`/`+++` lines, so the
  path must come from the `diff --git a/X b/Y` header.
- The `@teardown` bucket is a third bucket after all. I had collapsed it into `@between`; §8.3
  gives `@load` and `@teardown` one answer (startup code, `all`) and `@between` its own policy,
  and `seen` had to be added to the map so rule 6 (`untested`) and rule 7 (`unknown-file`) —
  which have *opposite* answers — can be told apart.

Deviations: the map is one `map.json` rather than §8.1's five files (the doc's layout is an
optimisation for large maps, and `select` reads the whole thing either way); and no CLI, so
`buildMap`/`saveMap`/`loadMap` are called directly.
**Status**: Complete

## Phase B — measurement against VS Code

### Stage B0: environment
**Goal**: `test-node` green on `src/vs/platform` from a temp clone.
**Success criteria**: cloned outside the user's tree; `npm ci` done; transpile done;
`--runGlob` selects the subtree; T_full recorded. Expect ~1 h and ~2 GB.
**Status**: In Progress

Recon, before anything was run. Clone landed at **VS Code 1.143.0, `a8f47b48`**,
depth 400 so B1 keeps a real commit range, 622 MB, in `~/temp/cbd-b0/vscode`.

**VS Code has two build pipelines and they differ exactly on amendment 1's axis:**

| | `compile-client` (`npm run gulp compile`) | `transpile-client` (`build/next/index.ts transpile`) |
|---|---|---|
| compiler | tsc | **esbuild**, per file |
| source maps | `src/tsconfig.json` → `"sourceMap": false` | **`sourcemap: 'inline'`** |
| output | `out/vs/…` | `src/…` → `out/…`, a pure prefix rewrite |

The recon note that "VS Code sets `sourceMap: false`" is true of the gulp/tsc path and
**false of the transpile path**, which is the one a developer runs day to day
(`watch-transpile`). `build/next/transpile.ts` sets `sourcemap: 'inline'`, and
`rewriteSourceMappingURL` only fires for production bundles, so the inline map survives
into `out/`.

Two consequences:

1. **The projection rule for VS Code is `src/` ↔ `out/`** — a pure string rewrite, which is
   what A2 implements, and `SRC_DIR`/`OUT_DIR` in `build/next/index.ts:65` confirm it. But
   projection *also* assumes line-preservation, and **esbuild's TS transform is not
   line-preserving**: it strips type-only lines and rewrites enums, class fields and
   decorators. So on the transpile build the correct path is source-map resolution, which is
   available; projection would be wrong there even though the paths match. Amendment 1
   stands for the tsc build and for genuinely map-less repos, not for esbuild output.
2. **This exposed a latent under-selection bug**, now fixed and committed (`e9058df`):
   `createScriptResolver` fell back to projection when a script declared a `sourceMapURL`
   that would not load or parse. The fixture could not catch it — `out-maps` always has
   readable maps, `out-nomaps` declares none, so the fallback fired in neither build and 92
   tests stayed green over it. It now returns `null`, dropping the script so the unknown-file
   rule escalates. Regression test added (`tests/source-maps.spec.ts`), control plus both
   failure modes.

**Selection injection point**: `test/unit/node/index.js:72` sets the test root to `out/`
(`path.join(REPO_ROOT, out)`) and the default glob is `**/test/**/*.test.js` against it.
`--runGlob` globs from there, but the useful hook is `--run`, which takes a **`string`**, so
minimist collects repeated `--run a --run b` into an array — an arbitrary selected subset can
be passed directly, and it accepts `src/…` paths, rewriting `/^src/` → `out`.

**The mocha adapter — `packages/mocha` (`@cbd/mocha`), built and green (2 tests).**

VS Code runs **mocha**, not japa, so the only lifecycle wiring Phase A had did not apply. The
core seam held up: `inProcessSource`, `Recorder`, `normalize`, the map and the selector are
untouched, and the adapter is a patch plus a pair of hooks.

`mocha.rootHooks()` turned out not to be a special mechanism — it attaches ordinary
`beforeEach`/`afterEach` to the **root suite** (`mocha/lib/mocha.js`, verified in the installed
10.8.2). Mocha runs root hooks outermost, so the window brackets the test *and* its own
suite-level `beforeEach`/`afterEach`. That is strictly better than japa's window, where
`group.each.setup` fell between tests and had to be filed as `@between` (A3 finding 3); the
setup a test causes is now attributed to the test that caused it.

`Mocha.prototype.run` is the single funnel — `test/unit/node/index.js` builds its own `Mocha`
instance and calls `runner.run(cb)`, so the CLI's `--require` root hooks would land on a
different, empty instance. Hence `NODE_OPTIONS="--import …/auto.js"` (auto.ts), which patches
that one method and writes the shard footer from inside the `run` callback — the only point
ahead of mocha's own `process.exit`. The top-level `await` in `auto.ts` is load-bearing:
`run()` is synchronous and cannot await an inspector connection, so the session is opened
while Node is still resolving the `--import` list.

Nothing else calls the adapter directly in the test: a plain `mocha spec/calc.spec.js` with
only `--import` added comes out the other side as per-test windows, which is the seam the
whole project rests on.

**Two findings from building it:**

1. **Mocha runs root hooks for a *pending* test.** I asserted the opposite in a comment and the
   test disagreed. So a skipped test does open a window and arrives with `state` undefined —
   japa's trap in different clothing (A3 finding 2), defended the same way, by reading the
   pending flag before trusting the state that is present. The status keeps it out of the map.
2. **A path alias silently empties the whole map.** Node's ESM loader resolves symlinks, so the
   script URLs V8 reports carry the realpath. On macOS `tmpdir()` is `/var/…` and its realpath
   is `/private/var/…`, so a projection rule written with the unresolved prefix matches no
   script, every script is dropped, and the map comes out empty. This is **fail-safe** (nothing
   is under-selected — every change becomes `unknown-file` → `mode: all`) but it is a *silent
   total* failure: the entire speedup disappears with no error. Worth either realpath-ing the
   projection prefixes once at configuration time or emitting a loud warning when a run that
   passed the prefilter yielded zero files. Not done yet — flagged rather than folded in.

**Transpile and scope.**

`npm ci` completed clean (~1.5 GB incl. per-extension workspaces). `npm run transpile-client`
— esbuild, `--exclude-tests` not set — reports **10,270 files → `out/` in 4.2 s**. Fast enough
that a per-commit re-transpile in B1 costs nothing.

`out/` holds **2,512** `.test.js` files. The unit scope for `src/vs/platform` is **629**:
`vs/platform/**/test/{common,node}/**/*.test.js`. That brace glob reproduces the set the
runner's own `excludeGlobs` would leave (629 exactly, verified both directions) — which
matters because **`--runGlob` bypasses `excludeGlobs`**, so a naive `--runGlob
"vs/platform/**/test/**/*.test.js"` would pull in 695 files and load `electron-main` tests
that cannot run under node.

The runner is reached directly with `node test/unit/node/index.js --runGlob …`, no mocha CLI.
Smoke run: 30 tests in 9 ms, 0.2 s wall.

**Source maps, and a correction to the recon.** `src/tsconfig.json`'s `"sourceMap": false`
describes the *gulp/tsc* build. The transcompile path that `watch-transpile` uses emits an
inline map per file, and its `sources` is an **absolute** path with no `sourceRoot`:

```
sources: ["/Users/…/vscode/src/vs/platform/markers/common/markerService.ts"]
```

So for VS Code the **source-map** resolver carries the whole map and projection is only a
fallback — the opposite of amendment 1's premise, which was written against the tsc build.
This is also why the esbuild-is-not-line-preserving point is moot here: the map is
authoritative and the transform's line shifts never reach the map. Projection remains the
right answer for a genuinely map-less build (the fixture's `out-nomaps`), and would be the
*wrong* answer for esbuild output, which is what `e9058df` enforces.

Not yet done: `T_full` (running), then the recording run and the map.

### Stage B1: the measurement run
**Goal**: the numbers that decide the project.
**Success criteria**, recorded as JSONL telemetry:
T_full and T_subset; collection overhead as a % of T_full; take p50/p95 on a real
isolate; normalize cost over ~2,000 real TS files; map bytes and parse ms;
**all-rate with reasons**, and `mode` broken down by `always-all / load / unknown-file /
between / stale-map`; and `verify`'s **miss count** — the one number that decides safety.
**Status**: Blocked on B2.

### Stage B2: stop normalizing in the hot loop
**Goal**: make the per-test overhead small enough for B1 to measure anything else.
**Success criteria**: recording overhead under ~10% of `T_full`; the shard records raw
byte ranges and no resolved paths; `buildMap` resolves each `(script, function)` once.
**Status**: Not Started — this is the first thing B1 found, and it is the reason B1 is
blocked.

**The measurement that forces it.** `T_full` for the 629-file platform scope is **104 s**
(16,017 passing, 165 pending, 1 failing — `CopilotAgent` in `agentHost`, which fails on
`.agent-session-cwd-*` leaking in from the shell's working directory, i.e. the harness's own
artefact, not the code). Source maps carry the map with **no projection configured at all**,
which settles amendment 1 for VS Code.

Then the overhead, from `.explore/spike/probe-first-take.mjs` over 10 modules:

| | |
|---|---|
| `takeSync()` | **3 ms** — 90 scripts, 1,731 functions |
| `normalize()` | **108 ms** → 137 touches |

**We spend 36× longer processing coverage than collecting it.** A fresh pass over the same
payload costs ~23 ms of that in reading files and re-parsing source maps, so caching is worth
~23% and does not close the gap — the remaining ~83 ms is the per-function `originalPositionFor`
lookups. Per script, ~1.2 ms; across VS Code's 10,270 scripts and 16,017 windows that is tens of
minutes of overhead on a 104-second suite.

**It is structural, not a bug.** Every window re-reads and re-indexes every file it touches,
re-parses every source map, and re-resolves every function's position — and a function in a
cross-cutting file is resolved once per window it appears in. `lifecycle.ts` appears in 284 of
30 windows in a small run. The work is `O(windows × functions in window)` when it should be
`O(distinct (script, function))`.

**The fix.** Stop resolving at take time. The shard records, per window, only the executed
functions' **byte ranges** — script id, start offset, end offset. No paths, no names, no line
numbers. Every map lookup, file read and ordinal assignment moves to `cbd build`, where each
unique `(script, function)` is resolved exactly once. This is the `file` record CBD.md §6.3
already describes.

It also closes three other things at once:

1. **Ordinals become stable by construction** — assigned from the union over every window, which
   is the proper fix A4 could only flag as a limitation.
2. **Our own normalization work stops being attributed to the following test window.** Traces of
   it are visible in the fixture too, filtered out only because they are outside the project root.
3. Bytes on disk replace CPU in the hook, which is the right trade: a first estimate is ~150
   executed functions per window at ~15 B each, so ~50 MB for a 16 k-window run, deleted once the
   map is built.

**Fallback if that size is unacceptable**: cache `FileCache` and `TraceMap` across windows, as
`OrdinalRegistry` already is. Measured ceiling ~23%, so it is a mitigation and not a fix.

---

## Success / kill criteria

- **Kill** if, at a realistic unit-scope config and a ~5-commit window, `verify` finds a
  miss at a rate that cannot be driven to zero. Under-selection is the only unacceptable
  failure; everything else is tunable.
- **Kill** if `E[time]` at realistic `P(all)` is not meaningfully below T_full, i.e. if the
  policy levers in amendments 2–4 cannot get `P(all)` low enough to matter.
- **Proceed** if misses are zero across a real commit range and `P(all)` is driven low
  enough that `E[time] ≪ T_full`. The mechanism is then proven and the remaining work is
  the adapters in CBD.md §7.

## Open decisions

- The project directory is **not a git repository**. CBD.md's own process and the user's
  guidelines both assume incremental commits; needs `git init` before code lands.
- Package scope name: `@cbd` is a placeholder (CBD.md §9.1) and collides with cannabidiol
  on npm. Needs a check before anything is published.
