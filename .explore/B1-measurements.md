# B1 — the measurement run, first pass (2026-10-25)

Clone: `~/temp/cbd-b0/vscode`, VS Code 1.143.0, `a8f47b48`, `out/` built, Node 24.18.0.
Scope: `find out/vs/platform -name '*.test.js' | grep -E '/test/(common|node)/'` — 629 files,
`--run` repeated once per file (minimist takes one value per flag; a space-separated list silently
runs only the first file).

| metric | value |
|---|---|
| `T_full` (unrecorded, 3 runs consistent) | **128.29 s** — 16,015 passing, 165 pending, 3 failing |
| `T_recorded` (mocha adapter via `NODE_OPTIONS`, one shard) | **755.65 s** — 16,008 passing, 165 pending, 10 failing |
| collection overhead | **+627 s = 489% of `T_full` (5.9×)** — ≈39 ms per recorded test |
| shard | 77.8 MB (16,019 test records + 3 health/end) |
| `cbd build` (resolve + merge, 1 shard) | **17.18 s** → 192.6 MB map, 16,008 tests, 1,686 files |
| map parse (`loadMap`) | 1,087–1,475 ms over 3 loads |
| `cbd select` (map parse + rules) | 1.1–3.2 s |
| `T_subset` (107 selected tests, same 629-file load) | **17.72 s** — 107 passing |
| speedup | **7.2×** (128.29 → 17.72 s) |
| all-rate (20 evenly spaced function-interior changes) | **20/20 subset**, none `all` |
| reason mix (same 20) | function 24, read 9, test-file 7, opaque 20 |

Notes that matter for reading these numbers:

- **The opaque block is real.** 94 tests declare `spawned a process` (the process tracker), so every
  in-scope change adds them. That is the harness's own boundary, not noise from CBD.
- **A top-level change escalates to all in this shape.** VS Code's runner imports all 629 spec files
  into one process, so `loadShards` says every test evaluated a module's body; a hunk at module
  scope (line 10 of `markerService.ts`) selected all 16,008. Inside a function it selects that
  function's tests. Both are the documented rule, but the per-shard load attribution is coarse for
  a single-process harness and dominates the all-rate for module-scope edits.
- **Recording changes the failure set**: 3 failing unrecorded, 10 recorded. Not yet investigated;
  the extra ones are agent-host/proxy tests that assert on ambient state.
- Drift (take p50/p95) is not recorded for the in-process source — its `drift()` is absent by
  design. B0's probe measured 3 ms per `takeSync` over 90 scripts / 1,731 functions.
- **Miss count: not measured yet.** It needs a per-commit replay: record commit C, build, run the
  full suite at C for ground truth, select for `C-1..C`, and check every failing test was selected.
  At today's numbers that is ≈13 min recording + 2 min full run per commit, so 20 commits ≈ 5 h.

```jsonl
{"metric":"T_full_s","value":128.29,"scope":"vs/platform 629 files","node":"24.18.0"}
{"metric":"T_recorded_s","value":755.65,"tests":16008}
{"metric":"overhead_pct","value":489}
{"metric":"shard_bytes","value":81551360}
{"metric":"build_s","value":17.18,"map_bytes":201979863,"map_tests":16008,"map_files":1686}
{"metric":"map_parse_ms","value":[1431,1087,1475]}
{"metric":"select_ms","value":[3216,1780,1890]}
{"metric":"T_subset_s","value":17.72,"selected":107}
{"metric":"speedup","value":7.24}
{"metric":"all_rate","value":"0/20","sample":"function-interior"}
```

## Second pass — where the recorded time goes (2026-10-25)

Same clone, same 629-file scope, same mocha adapter, one shard. Timers inserted only in the
built `packages/core/dist` (source untouched) split each boundary's wall time into the take, the
projection, the table rows, the record build and the sink append. Recorded wall **597.1 s**,
16,010 passing / 165 pending / 8 failing; shard 81.4 MB, 95,278 appends.

| phase | total | share of recorded wall |
|---|---|---|
| `takeSync()` (V8 `Profiler.takePreciseCoverage`) | **415.5 s** over 32,039 takes | **69.6%** |
| `project()` (payload → byte ranges) | 9.9 s | 1.7% |
| table rows (scripts + functions, first sighting) | 11.3 s | 1.9% |
| record build (`JSON.stringify`) | 0.2 s | 0.03% |
| `appendFileSync` (all paths) | 23.5 s over 95,278 calls | 3.9% |
| everything else (suite itself, adapter, read tracking) | 136.7 s | 22.9% |

`13.0 ms` per take. **Two takes per test**: `testStart` takes the gap and files it as `@between`,
`testEnd` takes the test. 32,039 takes for 16,019 tests.

The take cost is V8 walking the isolate's loaded functions, not payload size — the spike's curve
(~6 ms at 100k functions) says this process carries roughly 200k. Nothing about the take's
arguments reduces it; `detailed: false` is already what the recorder asks for. So the only lever
is **fewer takes**, and the second lever is the sink: 247 µs per `appendFileSync` because every
call reopens the shard.

Even at zero take cost the run would sit at 181.6 s against a 128.3 s unrecorded suite — the
projection, table row reads/hashes and 95k synchronous appends are 53 s (41% of `T_full`) on
their own. Both halves need fixing; the take is the larger one.

```jsonl
{"metric":"T_recorded_s","value":597.1,"tests":16019,"instrumented":true}
{"metric":"takes","value":32039,"per_test":2,"ms_per_take":13.0,"total_s":415.5,"share_pct":69.6}
{"metric":"project_s","value":9.9}
{"metric":"table_s","value":11.3}
{"metric":"record_build_s","value":0.23}
{"metric":"append_s","value":23.5,"calls":95278,"us_per_call":247}
{"metric":"non_take_recorded_s","value":181.6,"T_full_s":128.29,"overhead_pct":41}
```

**What a fix has to reach.** At test granularity, dropping the `@between` take halves the take
cost to 208 s — still 162% of `T_full`. Group granularity (mocha suites: 1,349 in this scope,
median 1 per file) costs ~18 s; file granularity (629 files) ~8 s. The ~10% target needs one of
those, plus buffered shard writes.

## Third pass — group windows (2026-10-25, after Stage B4)

Same clone, same 629-file scope, same mocha adapter, one shard, `CBD_GRANULARITY=group` so the
recorder takes once per mocha suite instead of twice per test. Clean runs, no instrumentation
unless stated.

| | test windows | group windows |
|---|---|---|
| recorded wall (clean) | 597.1 s (instrumented) | **154 s, 155 s** |
| takes | 32,039 | **1,226** |
| take total | 415.5 s | **18.8 s** (instrumented run) |
| shard | 81.4 MB | **17.45 MB** |
| `cbd build` | 17.18 s / 192.6 MB map | **5.8 s / 71.1 MB map**, 1,683 files |
| tests recorded | 16,019 | 16,019 in 1,224 group records |
| `between` records | 16,018 | **0** — the gap folds into the next group |

`T_full`, measured five times in this session: 92, 96, 105, 116, 134 s (median 105). The baseline
genuinely spreads ~±20%, which is why the overhead below is a range and not a percentage.

**Recorded overhead: 154.5 s vs 105 s median → +49.5 s, ~47%** (against this session's fastest
run, 60%; against the slowest, 34%). Down from 489%. The 10% criterion is **not met**.

Where the remaining time goes, from a CPU profile of a clean grouped run (149 s, 147.8 s sampled):

| | |
|---|---|
| `Profiler.takePreciseCoverage` (`post node:inspector`) | **17.1 s** |
| all CDB JS (`recorder`, `line-index`, projection, adapter) | **3.6 s** |
| `(idle)` — waiting on children and async work | 49.8 s |
| the suite's own work | the rest |

The profile also settles the last unexplained term: **140 child processes are spawned during the
run** (23 synchronously, 0.8 s of the parent's wall). Each inherits `NODE_OPTIONS` and pays the
preload import even though it is inert — measured at 60 ms against 6 ms bare, so ~8 s across the
run. That is a real recorder cost and a cheap one to remove: `auto.ts` imports the core module
graph statically before it knows whether the process is recorded (a static-import fix, not a
design change).

So the honest attribution of the +49.5 s is: ~19 s of takes, ~4 s of recorder JS, ~8 s of inert
child preloads, and the rest indistinguishable from the baseline's own spread.

Selection is still usable at this granularity. A function-interior change in
`src/vs/base/common/color.ts` selects **95 tests** (1 function + the 94 opaque declarations),
against 107 at test granularity in the first pass; `async.ts` line 762 selects 758, `pfs.ts`
line 80 selects 189. A module-scope hunk still selects every test, which is the single-process
`@load` attribution from the first pass, unchanged by grouping. Map-level: `between` and
`teardown` hold no refs in this shape.

```jsonl
{"metric":"T_recorded_group_s","value":[154,155],"granularity":"group"}
{"metric":"T_full_s","value":[92,96,105,116,134],"scope":"vs/platform 629 files"}
{"metric":"overhead_pct_group","value":47,"basis":"median T_full 105s"}
{"metric":"takes_group","value":1226,"take_s":18.8}
{"metric":"shard_group_bytes","value":17452634}
{"metric":"build_group_s","value":5.8,"map_bytes":71137566,"map_files":1683}
{"metric":"cbd_js_s","value":3.6,"profile":"clean grouped run, 149s wall"}
{"metric":"child_spawns","value":140,"inert_preload_ms_each":54}
{"metric":"select_function_change","value":95,"file":"src/vs/base/common/color.ts"}
```


## First replay: the miss count on two VS Code commits (2026-10-26)

`packages/core/scripts/replay.mjs` already implemented the oracle the plan asked for, so this is a
run, not a build: base `743b7f93`, commits `25f764ab` and `61877c27` (13 platform files), recording
at `granularity: group`, `--include src/vs/platform`, transpile per checkout (~6 s).

| | |
|---|---|
| coverage misses | **0** |
| missed failures | **0** |
| new tests (unselectable from the base map) | 18 |
| new failures (full run, unknown to the base map) | 14 |
| subset-only failures | 0 |
| load failures / unverified | 0 / 0 |
| `P(all)` | **50%** (1 of 2 steps) |
| r(count) | 99.97% |
| S(count) | 0.02% |

**The zero is vacuous.** Both steps selected essentially the whole suite: one escalated to `all`
on three files the map had never seen (`e2e/suites/changesetSuite.ts`,
`protocol/sessionDiffs.integrationTest.ts`, and a deleted e2e YAML capture), and the other selected
16,006 of 16,007 because its single changed file,
`src/vs/platform/agentHost/common/agentHostPolicySupport.ts`, is not in `seen` — the file is
lazily loaded and the recorded run never executed it, so the load rule credits every test.

That is the safe direction and the rules are doing what they say. But it means this commit shape
cannot measure selection safety, and it contradicts the first pass's synthetic all-rate (0/20
function-interior changes): **real commits touch test infrastructure and lazily loaded files, and
those escalate.** A two-commit sample is not a rate — `P(all)` needs a real range, and the range
that matters is the target suite, not VS Code's platform scope.

Cost per step: ~6 s transpile + ~150 s recorded full run + a subset run that, when the answer is a
near-full subset, costs the same again. A 20-commit window on this clone is ~1.5-2 h, most of it
spent on steps whose answer is `all`.

```jsonl
{"metric":"replay_commits","value":2,"misses":0,"missed_failures":0,"new_tests":18,"new_failures":14}
{"metric":"replay_P_all","value":0.5,"sample":2}
{"metric":"replay_r_count","value":0.9997}
```

## Miss count: replay on the target suite (2026-10-26)

`packages/core/scripts/replay.mjs` was already the oracle the plan asked for. Three things had to
be fixed before it measured the product: it did not read the repository's `cbd.config.json` (so
grizzly's `unknownPolicyFor: tools/** -> ignore` was invisible and 20 of 20 steps escalated to
`all`); it handed the runner an empty selection when the selector answered "nothing reaches this";
and its coverage oracle used the default test-file globs rather than the configured ones. The
wiring for grizzly (symlinks, patch, command) is in `.explore/replay-grizzly.md`.

### VS Code, two commits

Base `743b7f93`, commits `25f764ab`, `61877c27`. Miss 0, missed failures 0, 18 new tests, 14 new
failures (classified apart), 0 subset-only failures — **but vacuous**: one step escalated on three
test-infrastructure files the map never saw, the other selected 16,006/16,007 through the load
rule for a lazily loaded file. `P(all) 50%`, `r(count) 99.97%`.

### Grizzly `sdk-unit`, a 20-commit window near HEAD

Base `51251724`..`d355df79`. `P(all) 5%`, `r(count) 5%`, 0 misses — **also vacuous, in the other
direction**: 19 of the 20 commits' cumulative diffs touch only `typescript/tools/dev-cli`, which
the config ignores, so the correct answer was "run nothing"; the one relevant step escalated to
`all` on an unknown `typescript/libs/test-kit/src/registry.ts`. A rate over a window with no code
changes in scope measures nothing.

### Grizzly `sdk-unit`, per-commit windows

Five of the last ten first-parent commits touching `sdk/src` can be replayed; the older five
predate `typescript/sdk/bin/test.ts`, so there is no base runner and no map. Per commit
(`base = commit^`, `--include typescript/sdk/src`):

| commit | sdk files | selected | required | miss | missed failures | new tests |
|---|---|---|---|---|---|---|
| `ed689c70` | 3 | 157/164 | 28 | 0 | 0 | 0 |
| `350261ba` | 1 | 157/164 | 0 | 0 | 0 | 0 |
| `6721c1ad` | 1 | 157/164 | 24 | 0 | 0 | 0 |
| `3b332828` | 9 | 152/164 | 41 | 0 | 0 | 5 |
| `09ba96f4` | 2 | 152/159 | 11 | 0 | 0 | 0 |

**Miss 0, missed failures 0, subset-only failures 0 over 104 required tests.** The safety number
is clean on this sample; the sample is five commits, not the twenty the gate wanted.

**The payoff is not there.** `r(count)` is 92.7-95.7%, `S(count)` 4-7%, and `S(time)` ~0 because a
subset run loads every spec file anyway (1.7 s either way). The reason is visible in a single
commit's selection reasons: `09ba96f4` changes two files, matches three functions (2, 2 and 1
tests), and *also* carries hunks outside every function — including `RestAdminStore.ts` line 2,
an import. The map has the file in `@load`, so the module-scope rule names every test that loaded
it: 159 of 159, because one process runs the whole suite and every test shares the module
instance. TypeScript commits are mostly imports and type-level edits, so this is the common case,
not the edge.

That is the honest shape of the target suite as wired: with one process and shared module state a
module-scope edit really can affect any test, so the escalation is right — and it means selection
has almost nothing to remove. Making the suite narrower needs process isolation per file, or a
file-level selection that stops the runner importing the rest; neither is a selector change.

```jsonl
{"metric":"replay_vscode","commits":2,"misses":0,"missed_failures":0,"p_all":0.5,"r_count":0.9997,"vacuous":"unknown files"}
{"metric":"replay_grizzly_window","commits":20,"scored":20,"p_all":0.05,"r_count":0.05,"vacuous":"19 steps had no in-scope code change"}
{"metric":"replay_grizzly_per_commit","commits":5,"misses":0,"missed_failures":0,"required":104,"new_tests":5}
{"metric":"replay_grizzly_r_count","value":[0.957,0.957,0.957,0.927,0.956]}
{"metric":"replay_grizzly_s_time","value":0,"why":"subset run loads every spec file"}
```
