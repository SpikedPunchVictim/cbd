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
works behind the scenes. `@cbd/auto` via `NODE_OPTIONS="--import …"`, no `cbd` command to
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
packages/core/             A2: @cbd/core
```

Toolchain: Node 24.18.0, pnpm 11.17.0, TypeScript 7.0.2 (the native port), japa 5.4.0,
`@jridgewell/trace-mapping` 0.3.31. macOS/zsh.

## Done

- **A0** — japa hook facts verified against the installed 5.4.0. `probe/`.
- **A1** — the fixture: 15 specs, 43 tests, two builds differing only in `sourceMap`.
  `fixture/`. `scripts/check-builds.mjs` guards that difference structurally.
- **A2** — `@cbd/core`: `inProcessSource`, `normalize`/`scan`, path projection, source-map
  resolution. 29 tests. `packages/core/`.

Run everything: `pnpm -r test` from the repo root.

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

## Design amendments forced by measurement

1. Path projection for `outDir` builds — **done in A2**, validated by the two-build e2e.
2. `unknownPolicy` must be graduated, not binary (assets never force `all`).
3. Hunk-aware `alwaysAll` (`"version"`-only hunks should not trigger `all`).
4. Path-convention owners for `.snap` / fixture data files.
5. Adapter handlers must be synchronous.
6. `Source` carries both `takeSync()` and async `take()` — the seam that keeps integration
   testing reachable later without a breaking change.

## Next — A3

Recorder, shards, `cbd build`, `loadMap`. Criteria in `IMPLEMENTATION_PLAN.md`.

## Open decisions

- The package scope `@cbd` is a placeholder and collides with cannabidiol on npm. Nothing
  is published; needs a check before it ever is.
- `Source.takeSync()` cannot work for out-of-process sources, so a future `inspectorSource`
  under japa will need timer-sampled or group-granularity windows.
- Whether `probe/` stays after the real adapter lands (probably not).
