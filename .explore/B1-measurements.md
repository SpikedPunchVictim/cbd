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
