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
**Status**: Not Started

### Stage A2: sources and Normalizer
**Goal**: from a running test, get a stable set of `(file, function)` touches.
**Success criteria**: `inProcessSource` returns per-window deltas; `normalize()` filters by
URL, keeps functions with count > 0, maps back through source maps **and** through path
projection, and yields `name@ordinal` keys stable across edits elsewhere in the file.
**Tests**: fixture-driven units; a function not called in a window is absent; the
same fixture normalized from the no-source-map build produces the same `src/` keys.
**Status**: Not Started

### Stage A3: Recorder, shards, build, map reader
**Goal**: bucket assignment and the on-disk map.
**Success criteria**: three tests plus a background timer produce the right per-test
touches and a non-empty `@between`; an interrupted shard is refused; `cbd build` merges
and `loadMap` reads back; map bytes and parse ms recorded.
**Tests**: unit tests over the Recorder with a fake source; shard → map → query round trip.
**Status**: Not Started

### Stage A4: diff, select, verify
**Goal**: every rule in §8.3, plus the money shot.
**Success criteria**: one table-driven test per rule row; the hunk-coordinate case
(three hunks, accumulating offsets — must use **old-side** line numbers) passes; a
rename-with-modification selects the tests touching `from`; `verify` reports a
deliberately planted miss.
**Tests**: a fixture git repo built in a temp directory per test, as §12 Stage 3 specifies.
**Status**: Not Started

## Phase B — measurement against VS Code

### Stage B0: environment
**Goal**: `test-node` green on `src/vs/platform` from a temp clone.
**Success criteria**: cloned outside the user's tree; `npm ci` done; transpile done;
`--runGlob` selects the subtree; T_full recorded. Expect ~1 h and ~2 GB.
**Status**: Not Started

### Stage B1: the measurement run
**Goal**: the numbers that decide the project.
**Success criteria**, recorded as JSONL telemetry:
T_full and T_subset; collection overhead as a % of T_full; take p50/p95 on a real
isolate; normalize cost over ~2,000 real TS files; map bytes and parse ms;
**all-rate with reasons**, and `mode` broken down by `always-all / load / unknown-file /
between / stale-map`; and `verify`'s **miss count** — the one number that decides safety.
**Status**: Not Started

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
