# CBD — state of play

Handoff note. Everything durable is in the repo: `CBD.md` (kickoff design),
`IMPLEMENTATION_PLAN.md` (stages + status), `.explore/FINDINGS.md` (measurements),
`.explore/A0-japa-hooks.md` (japa facts), and `git log`.

## What this is

A framework-neutral, coverage-based **test-selection** tool for Node/TypeScript. It records
which source code each test executes (V8 precise coverage, taken at every test boundary),
stores it as a map keyed by commit, and answers *"which tests can this change affect?"*

**Target use case (narrowed by the user): unit tests only, not integration tests.**
Goal: a ~20 min unit suite that should take ~2 min on a small change. Metric is expected
wall-clock, `E[time] = P(all)·T_full + (1−P(all))·T_subset` — `mode: all` costs what the
developer already pays today, so it is survivable.

Also wanted: the **inverse map** — "what code does no test reach?" Same data, read
backwards. Zero under-selection risk.

Seamless integration is a requirement: the developer runs `japa`/`vitest` as usual and CBD
works behind the scenes. `@spikedpunch/cbd/auto` via `NODE_OPTIONS="--import …"`, no `cbd` command to
remember.

## Layout

```
CBD.md                     kickoff design (671 lines)
IMPLEMENTATION_PLAN.md     stages, status, kill criteria
.explore/                  measurements + findings (read-only research, never shipped)
  FINDINGS.md              all-rate / windowed-subset measurements
  A0-japa-hooks.md         japa 5.4.0 hook facts
  STATE.md                 this file
  spike/                   measure.mjs, ordinal-probe.mjs (+ generated corpora, gitignored)
probe/                     A0 hook probe (scaffolding; delete once the adapter lands)
fixture/                   A1: stand-in consumer repo, 15 specs / 43 tests
packages/core/             A2: @spikedpunch/cbd
```

Toolchain: Node 24.18.0, pnpm 11.17.0, TypeScript 7.0.2 (the native port), japa 5.4.0,
`@jridgewell/trace-mapping` 0.3.31. macOS/zsh.

## Done — Phase A complete

- **A0** — japa hook facts verified against the installed 5.4.0. `probe/`.
- **A1** — the fixture: 15 specs, 43 tests, two builds differing only in `sourceMap`.
  `fixture/`. `scripts/check-builds.mjs` guards that difference structurally.
- **A2** — `inProcessSource`, `normalize`/`scan`, path projection, source-map resolution.
- **A3** — `Recorder`, the append-only shard with its completeness footer, `buildMap` /
  `saveMap` / `loadMap`.
- **A4** — `changesSince`, `select` (all ten §8.3 rows), `verify`.

89 core tests, 43 fixture tests, 5 probe tests. `pnpm -r test` from the repo root.

## Facts that must not be re-derived

1. **japa does not await `emit`.** `@japa/core` build/index.js:472,486,542,563 —
   `this.#emitter.emit("test:end", …)` with no `await`. An async handler runs detached;
   measured, all five async listeners finished after `suite:end`. **Adapter handlers must be
   synchronous.** This is why `takeSync()` exists and is load-bearing.
2. **`takePreciseCoverage` with `callCount:true` returns and resets** — each take is a true
   per-window delta.
3. **The in-process `post` callback fires before `post()` returns** — `takeSync()` is real.
4. **V8 reports zero-count functions** inside any script that has coverage (three same-named
   `parse` methods reported with counts 0, 1, 0). So ordinals are assigned over the file's
   *whole* function list; `scan` is the primitive, `normalize` a filter.
5. **`originalPositionFor` returns `source` resolved** (a `file:` URL), not the raw
   `map.sources` string. Keying on the raw form makes every lookup miss silently.
6. **Map `sources` are relative to the map file's directory** (empty `sourceRoot`).
7. **`tsc` does not clean its `outDir`** — remove it before building.
8. **japa plugins receive the emitter**, so the adapter needs no changes to user test files.
   `runner.onSuite`/`suite.onTest`/`suite.onGroup`/`group.tap` fire at *import* time.
9. **`getActiveTest()` is `undefined` in hooks** — take identity from the event payload.
10. **`test:cleanup` is not an event** — it is an error-phase label.
11. **No module body ever appears in a test window** — every module is imported first, so
    its count is 0. `<module>@0` in a window means a test lazily loaded something.
12. Take cost tracks loaded **functions** (~2 ms at 20k, ~6 ms at 100k), not scripts. URL
    filtering cannot reduce take cost; only fewer takes can.
13. **V8 reports a script's whole function list ONLY on the take following its compilation.**
    Afterwards it reports only what had activity — measured: two functions where the file has
    six. So ordinals must come from a per-script registry seeded at first sighting, not from
    each window's payload. Deriving them per window let two different anonymous arrows both
    become `<anonymous>@0` and merge into one bogus 17-line function, which then matched any
    hunk in between. This is the most serious bug found so far.
    **Its limitation:** the first sighting is not always complete either, so a late-appearing
    function gets an appended ordinal. Deterministic per build and suite — enough for
    selection — but not stable across arbitrary edits. Deferring key assignment to `cbd build`
    is the proper fix, and is worth doing before any long-lived branch relies on the map.
14. A change with no content (mode change, pure rename) emits no `---`/`+++` lines; the path
    must come from the `diff --git a/X b/Y` header.
15. `@teardown` is a distinct bucket from `@between`, and the map needs a `seen` set so that
    §8.3 rule 6 (`untested`, select nothing) and rule 7 (`unknown-file`, select everything) —
    opposite answers — can be told apart.

## Design amendments forced by measurement

1. Path projection for `outDir` builds — **done in A2**, validated by the two-build e2e.
2. `unknownPolicy` must be graduated, not binary (assets never force `all`).
3. Hunk-aware `alwaysAll` (`"version"`-only hunks should not trigger `all`).
4. Path-convention owners for `.snap` / fixture data files.
5. Adapter handlers must be synchronous.
6. `Source` carries both `takeSync()` and async `take()` — the seam that keeps integration
   testing reachable later without a breaking change.

## Next — Phase B: the measurement against VS Code

`IMPLEMENTATION_PLAN.md` has B0 (environment) and B1 (the measurement run). B0 is the
expensive one: clone VS Code to a temp dir, `npm ci` (~1–2 GB, Electron + Playwright),
transpile, get `test-node` green on `src/vs/platform` via `--runGlob`, record T_full.
Expect about an hour of wall clock.

B1's numbers decide the project: T_full and T_subset, collection overhead, take p50/p95 on a
real isolate, normalize cost over ~2,000 real TS files, map bytes and parse ms, all-rate with
reasons broken down, and `verify`'s **miss count** — the one number that decides safety.

Nothing in Phase A has been run against a real repository of any size. Every number so far
comes from a 43-test fixture, so the overhead and map-size figures are unvalidated at scale.

**Before B1, the ordinal-key fix is worth reconsidering**: a real repo will exercise lazy
imports and long-lived branches far more than the fixture does, which is exactly where the
first-sighting limitation bites.

## Open decisions

- The package scope `@cbd` is a placeholder and collides with cannabidiol on npm. Nothing
  is published; needs a check before it ever is.
- `Source.takeSync()` cannot work for out-of-process sources, so a future `inspectorSource`
  under japa will need timer-sampled or group-granularity windows.
- Whether `probe/` stays after the real adapter lands (probably not).
