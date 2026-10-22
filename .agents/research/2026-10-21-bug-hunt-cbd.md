# Bug Hunt Report: CBD full codebase (Node server)

**Date:** 2026-10-21
**Scope:** Full codebase, prioritized by consequence: selection/diff/map correctness (`packages/core/src`), runtime instrumentation and sockets (`recorder`, `instrument`, `source/*`, `correlate`, trackers, `env`), CLI (`packages/cli/src`), and the five adapters (`japa`, `jest`, `vitest`, `mocha`, `node-test`). Tests, fixtures, generated `dist`, and docs are guard-map material, not sources.
**Lenses Applied:** All 9 — assumptions, state machines, boundaries, data lifecycle, error paths, time/concurrency, environment divergence, cross-implementation divergence, write/read asymmetry.
**Runtime context:** Node server only (CLI, libraries, instrumented service processes, test-runner adapters). Node >= 20, macOS/Linux primary; Windows code paths exist and are treated as live where the code explicitly branches on `win32`.
**Files read in full:** 43 — all core source modules named below, all CLI modules, all adapter sources, plus guard tests/config/schema/ADRs (read in full by the three candidate passes; every BUG below was re-read in the main thread at the cited lines).

## Guard Map

- **Config schema / defaults:** `packages/core/cbd.config.schema.json`, `packages/core/src/config.ts`, `packages/core/src/glob.ts`.
- **Validation / canonicalization:** `packages/core/src/projection.ts`, `relocate.ts`, `normalize.ts`, `line-index.ts`, `source-maps.ts`, `packages/core/src/record.ts` (`absolute`), `packages/cli/src/args.ts`.
- **Sibling implementations:** five adapters (`japa/src/{plugin,adapter}.ts`, `jest/src/{config,environment}.ts`, `vitest/src/install.ts`, `mocha/src/{auto,selection}.ts`, `node-test/src/{install,register,identity}.ts`); sources `in-process.ts`, `socket.ts`, `rescan.ts`, `inspector.ts`; sinks; v1/v2 selection readers.
- **Behavior tests:** `packages/core/tests/{select,changes,factory,map,resolve,shard,recorder,recorder-e2e,correlate,read-tracker,socket-source,rescan-source,in-process,instrument,config,env,projection,relocate,normalize}.spec.ts`; `packages/cli/tests/{cli,collect,scenarios-e2e}.spec.ts`; adapter e2e suites.
- **Design intent:** `CBD.md`, `README.md`, `arch/decisions/0001–0017`.

## Summary

| Status | Count |
|--------|-------|
| Bugs Found | 25 |
| Fragile Code | 7 |
| OK (Already Guarded) | 5 |
| Needs Review | 4 |
| Killed / Corrected in Refutation | 6 |

## Issue Rating Table

| # | Finding | Lens | Confidence | Urgency | Risk: Fix | Risk: No Fix | ROI | Blast Radius | Fix Effort |
|---|---------|------|-----------|---------|-----------|--------------|-----|--------------|------------|
| 1 | `changes.ts:203,296-303,340` — git-quoted paths never unquoted; non-ASCII files silently ignored | Boundary | Confirmed (empirical) | 🔴 Critical | ⚪ Low | 🔴 Critical | 🟠 Excellent | 1 file | Small |
| 2 | `changes.ts:374` — `--no-worktree` emits `git diff HEAD <since>` (reverse); hunks are HEAD-side | Boundary | Confirmed (empirical) | 🔴 Critical | 🟡 Medium | 🔴 Critical | 🟠 Excellent | 1 file | Trivial |
| 3 | `select.ts:347-387,597-613` — a load-only helper that defines tests selects none and skips the load escalation | Assumption | Confirmed (empirical) | 🔴 Critical | 🟡 Medium | 🔴 Critical | 🟠 Excellent | 1 file | Small |
| 4 | `map.ts:744-747` — `carryMap` keeps base `seen` but drops its load/between/teardown; later change answers `untested` | Data lifecycle | Confirmed (empirical) | 🟡 High | 🟡 Medium | 🟡 High | 🟠 Excellent | 1 file | Small |
| 5 | `map.ts:262-277,338-347,387-396` + `factory.ts:620` — dirReads filtered by `include`; `src/**` never matches `src` | Write/read | Confirmed (empirical) | 🟡 High | ⚪ Low | 🟡 High | 🟠 Excellent | 2 files | Trivial |
| 6 | `select.ts:309-323` — module-scope widening uses file-wide line totals; compensating hunks cancel it | Boundary | Confirmed (empirical) | 🟡 High | 🟡 Medium | 🟡 High | 🟠 Excellent | 1 file | Small |
| 7 | `select.ts:806-831` — `verify` matches new-side ground truth against old-side hunks and skips insertions | Assumption | Confirmed (empirical) | 🟡 High | 🟡 Medium | 🟡 High | 🟠 Excellent | 1 file | Medium |
| 8 | `collect.ts:251,266` — `wroteShard` checks only the base path; Jest/Vitest/node:test write derived shards; map never built | Cross-impl | Confirmed (code) | 🔴 Critical | ⚪ Low | 🔴 Critical | 🟠 Excellent | 1 file | Small |
| 9 | `jest/src/config.ts:24-27` — Jest reads only v1 `{titles}`; both writers emit v2; collect→Jest subsets abort | Cross-impl | Confirmed (empirical) | 🔴 Critical | ⚪ Low | 🔴 Critical | 🟠 Excellent | 1 file | Small |
| 10 | `config.ts:184-186` + `cli/src/gc.ts:108-122` — `stateDir:""` accepted; gc deletes repo-root `shards/`/`maps/` | Boundary | Confirmed (code) | 🔴 Critical | ⚪ Low | 🔴 Critical | 🟠 Excellent | 2 files | Trivial |
| 11 | `args.ts:207-216` — a value flag swallows a following flag (`--commit --partial`) | Boundary | Confirmed (empirical) | 🟡 High | ⚪ Low | 🟢 Medium | 🟠 Excellent | 1 file | Trivial |
| 12 | `glob.ts:17-26` — glob translation assumes `/`; on Windows `src\**\*.ts` misses and `src\*.ts` over-matches | Environment | Confirmed (empirical) | 🟡 High (Win) | ⚪ Low | 🟡 High (Win) | 🟢 Good | 1 file | Small |
| 13 | `config.ts:312-318` + `glob.ts` — empty `include: []` and brace globs compile to "match nothing"; zero-test subset, exit 0 | Boundary | Confirmed (empirical) | 🟡 High | ⚪ Low | 🟡 High | 🟠 Excellent | 2 files | Small |
| 14 | `correlate.ts:164-166` — patched `fetch` replaces a `Request`'s headers with an empty list; auth headers vanish during recording | Write/read | Confirmed (empirical) | 🟡 High | ⚪ Low | 🟡 High | 🟠 Excellent | 1 file | Small |
| 15 | `recorder.ts:672` + `map.ts:316` — correlated windows hard-code `status:'passed'`; the failed owner record is dropped, so a failed test enters the map as passing | State machine | Confirmed (code) | 🟡 High | 🟡 Medium | 🟡 High | 🟢 Good | 2 files | Medium |
| 16 | `recorder.ts:662-676`, `correlate.ts:56-59` — correlated records lack `ordinal`; duplicate titles merge into ordinal 0 | Data lifecycle | Confirmed (code) | 🟡 High | 🟡 Medium | 🟡 High | 🟢 Good | 2 files | Medium |
| 17 | `recorder.ts:703-712` + `shard.ts:303-345` — shards are appended; two runs at one path parse as one run (first header, last footer) | Data lifecycle | Confirmed (code) | 🟡 High | ⚪ Low | 🟡 High | 🟢 Good | 2 files | Small |
| 18 | `correlate.ts:203-207` — `http.request(url, undefined, cb)` becomes `(url, {headers}, undefined, cb)`; callback never runs | Boundary | Confirmed (empirical) | 🟡 High | ⚪ Low | 🟡 High | 🟠 Excellent | 1 file | Trivial |
| 19 | `collect.ts:229-251` — same `--shard` path rerun with fewer bytes is reported "nothing recorded" | Boundary | Confirmed (code) | 🟡 High | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Small |
| 20 | `record.ts:71-76` — declared reads use `resolve`, not `realpath`; symlinked dependency keys never match | Write/read | Confirmed (code) | 🟢 Medium | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 21 | `args.ts:453-458` — explicit `--root` is not realpath'd; symlinked root drops all changes (0 tests, exit 0) and sends suite output to `_other` | Environment | Confirmed (code) | 🟡 High | ⚪ Low | 🟡 High | 🟢 Good | 1 file | Trivial |
| 22 | `socket.ts:410-417,165` — snapshot recovery matches take id/`sentAtUs` only; take ids restart per client, snapshot survives | Time/concurrency | Traced | 🟡 High | 🟡 Medium | 🟡 High | 🟢 Good | 2 files | Medium |
| 23 | `collect.ts:194-231` — concurrent collects share `selection.json` and the shard snapshot; cross-merge and false "incomplete shard" | Time/concurrency | Confirmed (code) | 🟡 High | 🟡 Medium | 🟡 High | 🟢 Good | 1 file | Medium |
| 24 | `map.ts:889-901` — `saveMap` writes in place; a crash leaves a truncated map and destroys the commit's good copy | Data lifecycle | Traced | 🟢 Medium | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 25 | `factory.ts:493` — `stats` spreads one number per mapped function into `Math.max`; ~125k functions throws | Boundary | Confirmed (empirical) | 🟢 Medium | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 26 | `env.ts:49-52` — empty `CBD_PROJECTION_*`/`CBD_RELOCATE_*` are accepted as real rules; keys degrade to `all` | Environment | Confirmed (code) | 🟢 Medium | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 27 | `japa/src/plugin.ts:141-146` — `serviceShardPath` finds `/` only; Windows path without extension inserts `.service` in a directory name | Environment | Confirmed (code) | 🟢 Medium (Win) | ⚪ Low | 🟢 Medium (Win) | 🟢 Good | 1 file | Trivial |
| 28 | `cli/src/cli.ts:229-231,269-288` — per-suite emit removes stale files only for suites named in the current invocation | State machine | Traced | 🟢 Medium | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Small |
| F1 | `flaky.ts:61-73,142-151` — flaky relevance ignores `reads`/`dirReads`; changed fixtures are called flakes | Write/read | Traced | 🟢 Medium | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Small |
| F2 | `select.ts:811-814` — `verify` keys ground truth by bare title; duplicate titles mask misses | Cross-impl | Traced | 🟢 Medium | 🟡 Medium | 🟢 Medium | 🟡 Marginal | 2 files + API | Medium |
| F3 | `map.ts:734-739` — `carryMap` discards `base.dirty` while relocating its ranges | Data lifecycle | Traced | 🟢 Medium | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| F4 | `socket.ts:440` — an empty recovered window returns `null`; false loss warning, unacked snapshot grows, script rows not absorbed | Error path | Traced | ⚪ Low | ⚪ Low | 🟢 Medium | 🟡 Marginal | 1 file | Small |
| F5 | `socket.ts:839-853` + `resolve.ts:299-313` — `generated` failure silently falls back to the on-disk file for a transformed script | Error path | Traced | 🟢 Medium | 🟡 Medium | 🟢 Medium | 🟡 Marginal | 2 files | Medium |
| F6 | `socket.ts:353-362` — `hello.protocol` is never compared by the collector; version skew is misread | Cross-impl | Traced | 🟢 Medium | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Small |
| F7 | `in-process.ts:129-145` + `recorder.ts:452-461` — `takeSync` failure substitutes an empty capture; no health flag; silent under-selection | Error path | Traced | 🟢 Medium | 🟡 Medium | 🟢 Medium | 🟡 Marginal | 2 files | Medium |

## Fix Plan & Interactions

**Ships-with sets (never split):**
- #1 + #2 — both are `changesSince` input canonicalization; one test file.
- #4 + F3 — both `carryMap`; write the incremental carry rules once.
- #8 + #19 + #23 — one collect run-isolation/detection change (mtime-aware snapshot + per-run state/selection), or the fixes conflict.
- #15 + #16 + F2 — attribution identity/status and verify identity are one model change: a test must be keyed by `(file,title,ordinal)` and a correlated record must not invent an outcome.
- #14 + #18 — both `correlate.inject`; one overload-preserving merge.
- #10 + #21 + #26 — path/config canonicalization and empty-value validation in one pass.

**Ordering constraints:**
- #8 before any adapter bridge work (#9): a collect that never builds a map hides the Jest failure.
- #15/#16 before trusting `verify` on correlated runs (F2).
- #22 before closing/reusing instruments across runs; the stale-snapshot window is a cross-run hazard.

**Shared migration/deploy constraints:** none (no database). Contract changes: #15/#16 (`ShardTest` gains identity/status semantics or an `attributed` marker), #22 (protocol/session epoch), #23 (state directory layout).

**Deferred to design work:**
- #15/#16 — needs a map-merge model for attributed windows (status precedence, ordinal threading); Step 6 checks 3 (existing shards) and 7 (record API) fail for a one-line patch.
- #22 — needs a session/generation epoch in the snapshot and a close path; checks 1/5/7.
- #23 — needs locking/per-run directories; checks 6/7.
- F2 — `verify` ground-truth identity API change.
- F5/F7 — health semantics for transformed/synchronous sources.

**Suggested phases:**
1. Diff and selector under-selection: #1, #2, #3, #4, #5, #6, F3.
2. Collect/map integrity: #8, #19, #23, #17, #24, #20, #21, #10.
3. Adapter/config surface: #9, #11, #12, #13, #26, #27, #28.
4. Attribution and recovery: #14, #15, #16, #18, #22, F4, F5, F6, F7.
5. Verification/history: #7, F2, #25, F1.

## Detailed Findings

### 1. `packages/core/src/changes.ts:203-209,296-303,340-344` — Git-quoted paths are never decoded
**Lens:** Boundary. **Confidence:** Confirmed (empirical).
Git's default `core.quotePath=true` emits `diff --git "a/src/caf\303\251.ts" ...`, `--- "a/..."`, and `ls-files` quotes its output too. `pathsFromHeader` bails on `"`; the `---`/`+++` handlers strip `a/`/`b/` from a leading quote; `untrackedChanges` keeps the raw spelling. The parsed path is `"b/src/caf\303\251.ts"`, which matches neither `include` nor the map. **Reproduced:** temp repo with `src/café.ts` (modified) and `src/naïve.ts` (untracked) → `changesSince` returned `["\"b/src/caf\\303\\251.ts\"","\"src/na\\303\\257ve.ts\""]`; `include('/root/src/**')` was false for both; the selection would be subset with zero tests and exit 0.
**Fix (8 checks):** disable git quoting and use NUL separation at the source: add `-c core.quotePath=false` to `git diff`/`ls-files` args, and `-z` for `ls-files` (split on `\0`). No parser arithmetic; total for UTF-8 names. Mirror path: both diff and untracked use the same change function; rename/copy lines benefit. Existing data: maps recorded from quoted paths contain no entry for those files (`seen` absent) → unknown-file/all, safe. Caller impact: none. Empirical re-test: café/naïve must appear as `src/café.ts`, `src/naïve.ts`.

### 2. `packages/core/src/changes.ts:374` — `--no-worktree` diffs in the reverse direction
**Lens:** Boundary. **Confidence:** Confirmed (empirical).
`args.splice(1, 0, 'HEAD')` produces `git diff [opts] HEAD <since>`. For a map at `<since>` and HEAD ahead, `hunks` are HEAD's (new) side and `newHunks` are the map's side; statuses invert. **Reproduced:** A→B with a file added in B → `changesSince({since:A, worktree:false})` reported that file as `D` and hunks from the B side. Select reads `hunks` against A's ranges: wrong function, or no test.
**Fix (8 checks):** append HEAD exactly as the two-commit branch does: `args.push('HEAD')` (or set `to:'HEAD'`). Boundary: empty range when map==HEAD stays empty. Mirror: worktree path already compares map→worktree; this makes HEAD the same direction. Caller: only the factory's head leg; tests at `cli.spec.ts:585` currently use map==HEAD and are blind. Add an A→B drift test.

### 3. `packages/core/src/select.ts:347-387,597-613` — A load-only helper that defines tests answers zero
**Lens:** Assumption. **Confidence:** Confirmed (empirical).
`testFileChange` runs before `noTouches`. For a seen helper with no registry tests and `definesTests(path)` true, it chooses `testsTouchingFile(path)`. A helper imported at spec load is in the `@load` bucket and `seen`, but has no `map.files` entry, so that list is empty; it returns true, skips the load escalation, and selects nothing. **Reproduced:** `{reason:'test-file', tests:[], warning:'a test it adds…'}` for a changed load-only helper.
**Fix (8 checks):** when `indirect && tests.length === 0`, treat the file through the load rule: union `loadShards` observers (as `selectLoadObservers` does) or force `all` with a `load` reason. Pass the observer helper into `testFileChange`; no new public surface. Existing tests give the helper a `files` entry and miss this shape. Caller impact: none. Add a load-only-helper test.

### 4. `packages/core/src/map.ts:744-747` — `carryMap` keeps a base `seen` it can no longer answer for
**Lens:** Data lifecycle. **Confidence:** Confirmed (empirical).
The carried map takes `load`/`between`/`teardown` from `next` but unions `base.seen` into `seen`. A file that was only in a base bucket survives in `seen`, so `noTouches` returns `untested` (zero tests) instead of `all`. The docblock claims dropping the buckets escalates. **Reproduced:** carried `seen` contains the load-only file, `load: []`, `partial` absent; selecting a change to it → subset, `tests: []`, `untested:[file]`.
**Fix (8 checks):** for every base-seen file absent from `next`, if the base had a bucket reference or no per-test evidence, add it to `partial` (poison → `all`) instead of leaving it silently `seen`. Alternative: carry the bucket refs with relocation. Existing-data: old carried maps cannot be retro-detected; the fix applies to new carries, and `partial` is already the documented poison. Caller: none.

### 5. `packages/core/src/map.ts:262-277,338-347,387-396` + `factory.ts:620` — Directory listings are filtered by `include`
**Lens:** Write/read asymmetry. **Confidence:** Confirmed (empirical).
`readPaths` applies `keepRead` to directories too. The factory's `keepRead` is `inside(root) && include(path)`; an include glob `src/**` does not match the directory `src` (no trailing segment), so `dirReads` is dropped. `resolve.ts:423-429` deliberately keeps directories unfiltered, and CBD.md says the same. **Reproduced:** `mergeShards` with `keepRead = matchesAnyGlob(p, ['/repo/src/**'])` and `dirReads:['/repo/src']` → `dirReads: {}`; `matchesAnyGlob('/repo/src','/repo/src/**')` is null.
**Fix (8 checks):** give directories their own path function: keep them when under the root and not `node_modules`, without the file `include` predicate (the build still filters listed files). Mirror: observed reads (files) keep the current include rule. Existing maps: none carry such dirs under glob includes; re-record. Add a fixture with `include: ['src/**']`.

### 6. `packages/core/src/select.ts:309-323` — Compensating hunks cancel module-scope widening
**Lens:** Boundary. **Confidence:** Confirmed (empirical).
`lineCountChanged` sums old/new lines across the whole file. One hunk deleting a line inside f and another inserting above g cancel, so the hunk containing g's first line does not widen; tests that observe module scope through another function are missed. **Reproduced:** with functions f(1-6)/g(8-10)/h(12-14) and test indexes 0/1/2, compensating hunks selected `[0,1]`; the control selected `[0,1,2]`. (A synthetic `<module>` entry with the third test masked it; real static imports live in `load`, not `files`.)
**Fix (8 checks):** use the per-hunk `Change.hunkEdits` pair (`oldCount`/`newCount`) instead of file totals: a hunk containing a function's first line widens when its own counts differ. `hunkEdits` is already emitted by the parser and used by incremental relocation. Boundary: a hunk with no paired edit falls back to file totals (legacy callers). Caller: internal only. Add the compensating pair test.

### 7. `packages/core/src/select.ts:806-831` — `verify` uses old-side hunks and ignores insertions
**Lens:** Assumption. **Confidence:** Confirmed (empirical).
`Change` documents `newHunks` as the oracle's coordinates ("a coverage oracle does the opposite… using old-side numbers would measure the oracle with the selector's own arithmetic"), but `verify` filters on `change.hunks` and skips changes with `hunks.length === 0`. **Reproduced:** insertion-only change + truth → `{misses:[], checked:0}`; a change with `hunks:[{5,5}]`, `newHunks:[{9,9}]` and truth at 9 → `checked:0`. The guard reports success without checking.
**Fix (8 checks):** match `newHunks`/`newInsertions` when present, falling back to `hunks` only for legacy caller-built changes (and warn). Include insertion points with the same point-in-range test as the selector. Identity is separately F2. Test the two empirical shapes. Caller impact: the public `verify` gets more true results, no throw/timing change.

### 8. `packages/cli/src/collect.ts:251,266` — Collect never sees the derived shards three adapters write
**Lens:** Cross-implementation. **Confidence:** Confirmed (code).
`wroteShard` is `existsSync(base) && (new || size > before)`. Jest, Vitest and node:test always write `<stem>.<file>.<hash>.ndjson` (`shardPathFor`), never the base path. `wroteShard` is false, collect prints "no tests ran; nothing recorded", and `buildAfterRun` is skipped. The CLI tests use a fake runner that writes the base path.
**Fix (8 checks):** compute `written` from the shard-directory snapshot (`shardsWrittenSince`) plus an mtime check on the base path, not from one file. Same function covers #19. Existing data: none. Add an integration probe with a derived-path writer and a real adapter.

### 9. `packages/jest/src/config.ts:24-27` — Jest reads v1 selections only
**Lens:** Cross-implementation. **Confidence:** Confirmed (empirical).
Both writers (`writeSelection` in core and the CLI's `emitSelection`) emit `{version:2,tests:[...]}`. Jest's CJS config reads only `parsed.titles` and throws otherwise. **Reproduced:** a v2 file → `cbd: the selection must contain { "titles": string[] }`. Collect→Jest subsets and `--emit-selection`→Jest both abort.
**Fix (8 checks):** accept v2: if `tests` is an array, validate `{file,title}` entries and map to titles (the adapter matches by title; duplicates run together, over-selecting). Keep v1. Empty v2 still throws. This mirrors `readSelection`; because config is CJS, duplicate the small validation (or export a CJS helper from jest). Test both shapes.

### 10. `packages/core/src/config.ts:184-186` + `packages/cli/src/gc.ts:108-122` — Empty `stateDir` lets gc delete repository directories
**Lens:** Boundary. **Confidence:** Confirmed (code).
`stateDir` is only checked for being a string; `mapsDir` is checked non-empty. `stateDir:""` makes `join(root, '', 'shards')` → `<root>/shards`; gc removes every entry not kept in that pool. A typo or templated config turns gc into a repository cleaner and collect writes state at the root.
**Fix (8 checks):** reject `stateDir` that is empty or resolves to the root (and require it be a relative path). Same validation as `mapsDir`'s non-empty rule. Existing data: configs already committed with `""` would now fail loudly, the safe direction. Test parse + gc with a decoy `shards/`.

### 11. `packages/cli/src/args.ts:207-216` — Value flags swallow the next flag
**Lens:** Boundary. **Confidence:** Confirmed (empirical).
`takeFlag` takes `argv[index+1]` unconditionally. `cbd build --commit --partial` yields `commit:'--partial', partial:false`; `select --since --strict` yields `since:'--strict', strict:false` and a git error instead of exit 2. **Reproduced** with the built parser.
**Fix (8 checks):** when no inline value and the next token starts with `-`, throw `--name needs a value` (require `--name=-x` for a literal leading dash). Caller: none. Test every value flag with a following flag.

### 12. `packages/core/src/glob.ts:17-26` — Glob translation assumes forward slashes
**Lens:** Environment. **Confidence:** Confirmed (empirical).
`*` becomes `[^/]*` (crosses `\`), and the `**/` branch needs `/`. Config globs are built with `join`; changed paths with `resolve`; both use `\` on Windows. **Reproduced:** `C:\repo\src\a.ts` vs `C:\repo\src\**\*.ts` → false; `C:\repo\src\deep\a.ts` vs `C:\repo\src\*.ts` → true.
**Fix (8 checks):** normalize both path and pattern with `replaceAll('\\','/')` at the matcher boundary (and in `canonicalProjectionRules`/config globs for consistency), preserving drive letters. Add Windows-string tests. Existing maps: stored paths are relative with OS separators; normalize on load if maps cross OS (separate concern).

### 13. `packages/core/src/config.ts:312-318` + `glob.ts:10-36` — Empty include and brace globs silently match nothing
**Lens:** Boundary. **Confidence:** Confirmed (empirical).
`include: []` builds a predicate that is false for every path; `src/**/*.{ts,tsx}` is translated literally and matches no `.ts`. Either produces a subset with zero tests, exit 0, and every change in `ignored`.
**Fix (8 checks):** reject an empty `include`/`exclude` array at config load; either implement brace/char-class expansion or reject patterns containing `{`/`[` with a clear error rather than compiling them literally. Existing configs with literal braces (rare) would fail loudly. Test both shapes.

### 14. `packages/core/src/correlate.ts:164-166` — The fetch patch drops a `Request`'s headers
**Lens:** Write/read asymmetry. **Confidence:** Confirmed (empirical).
`new Headers(init?.headers)` ignores the headers of a `Request` input; the patched call passes `{...init, headers}` and replaces them with correlation-only. **Reproduced:** local server saw only `x-cbd-correlation` inside the window; the control saw `authorization` and `x-custom`. Requests fail or change behaviour only while recording.
**Fix (8 checks):** seed the header list from `input instanceof Request ? input.headers : undefined`, merge `init.headers` without overwriting caller values, and when input is a Request clone it (`new Request(input, {headers})`) so method/body/signal survive. Add a Request-with-headers test; keep `fetch(url)` unchanged.

### 15. `packages/core/src/recorder.ts:672` + `map.ts:316` — A failed test can enter the map as passing
**Lens:** State machine. **Confidence:** Confirmed (code).
Correlated windows are written as `type:'test'` with `status:'passed'` and only the server-side touches. `mergeShards` drops the owner's real `failed` record (default `includeNonGreen:false`) and admits the fabricated passing one. The comment claiming the owner's record "still carries its real outcome" is false once the map is built.
**Fix: requires design work.** A correlated record must not invent an outcome; add an `attributed` marker (or status `unknown`) and make `mergeShards` include its touches while taking status from the owner's ordinary record, or exclude it from `map.tests` but keep the touches in `files`. Existing shards already contain fabricated passing records; a rebuild cannot distinguish them without a marker — ship the marker with a shard-version-compatible default. Checks 3 and 7 fail for a one-line patch.

### 16. `packages/core/src/recorder.ts:662-676`, `correlate.ts:56-59` — Correlated records lose the ordinal
**Lens:** Data lifecycle. **Confidence:** Confirmed (code).
The correlated record is keyed by `title\0file`; map identity is `title\0file\0ordinal`. A duplicate title's server touches merge into ordinal 0. Selection of the second occurrence under-selects.
**Fix: requires design work** (with #15): thread the recorder's open-window ordinal through `Correlator.begin`/`ownerOf`, and key correlated records by `(file,title,ordinal)`. Caller contract changes in `CorrelatedTest`. Existing shards lack the field; treat absent as 0 (current behavior) and re-record.

### 17. `packages/core/src/recorder.ts:703-712` + `shard.ts:303-345` — Two runs at one path parse as one
**Lens:** Data lifecycle. **Confidence:** Confirmed (code).
`runStart` appends a header through an append-only sink; `parseShard` checks only that the first record is a header and the last an end. A rerun at the same path concatenates and is accepted, merging old and new tests and masking an interrupted footer.
**Fix (8 checks):** truncate the shard at `runStart` (sink create/truncate) or have `cbd collect` remove the target and derived shards before spawning; additionally reject a second header in `parseShard`. Existing data: none. Add a two-run parse test.

### 18. `packages/core/src/correlate.ts:203-207` — `http.request(url, undefined, cb)` loses the callback
**Lens:** Boundary. **Confidence:** Confirmed (empirical).
`inject` sees `second === undefined` and returns `[url, {headers}, ...args.slice(1)]` → `[url, {headers}, undefined, cb]`; Node reads the third argument as options and ignores the fourth. **Reproduced:** the callback did not fire within 500 ms inside a correlation window.
**Fix (8 checks):** distinguish `(url)` from `(url, undefined, cb)`: for the latter return `[url, {headers}, cb]` (drop the absent options slot), or splice the options object into `args` at position 1 and remove the undefined. Preserve all documented overloads with a table test.

### 19. `packages/cli/src/collect.ts:229-251` — A smaller rerun at the same shard path is invisible
**Lens:** Boundary. **Confidence:** Confirmed (code).
Written detection is `size > sizeBefore`. A complete second run that records fewer bytes is reported "no tests ran"; the map is not rebuilt.
**Fix:** with #8, compare `(size, mtimeMs)` and treat an mtime at/after the run start as written, or remove the shard before spawning. Test a 5-test then 1-test run at one path.

### 20. `packages/core/src/record.ts:71-76` — Declared reads are not canonicalized
**Lens:** Write/read asymmetry. **Confidence:** Confirmed (code).
`absolute` uses `resolve` only. The fs tracker and build root use `realpathSync`, and selection joins on exact keys. A helper declaring a dependency through a symlink stores a key no change matches.
**Fix (8 checks):** `realpathSync` when the path exists, falling back to `resolve`; mirror the read tracker. Caller: none. Add a symlinked read test.

### 21. `packages/cli/src/args.ts:453-458` — `--root` is not canonicalized
**Lens:** Environment. **Confidence:** Confirmed (code).
`parseArgs` resolves but does not realpath the explicit root; the factory/config canonicalize. Under a symlinked root, `--patch`/`--change` paths and `relative(parsed.root, test.file)` use the link spelling while include/map keys use the realpath; every change is ignored (0 tests, exit 0) and per-suite output falls to `_other.json`.
**Fix (8 checks):** run the same `realpathSync` with a resolve fallback on the explicit root (as `defaultRoot`/config already do) before returning `ParsedArgs`. Add a symlinked-root test.

### 22. `packages/core/src/source/socket.ts:410-417,165` — Stale snapshot recovery
**Lens:** Time/concurrency. **Confidence:** Traced.
Recovery accepts a snapshot window when `takeId` or `sentAtUs` matches, but take ids restart at 1 per client, `startedAtUs` is never read, and no production path closes/clears the snapshot or the instrument's unacked map. A later run can substitute an earlier run's execution and skip the loss report.
**Fix: requires design work** — add a session/generation epoch to hello and snapshot, compare it in recovery, and close/clear on run end; checks 1/5/7 fail for a local patch. Test with two clients against one instrument.

### 23. `packages/cli/src/collect.ts:194-231` — Concurrent collects share selection and shard snapshot
**Lens:** Time/concurrency. **Confidence:** Confirmed (code).
One `<state>/selection.json` and a whole-directory snapshot; no lock. Run B can merge A's in-progress shard (exit 1 on a missing footer) while A builds a map containing B's coverage; subset runs can overwrite each other's selection between spawn and adapter read.
**Fix: requires design work** — per-run temp shard/selection names plus an atomic rename, or an exclusive lock; checks 6/7. Test with two overlapping collects.

### 24. `packages/core/src/map.ts:889-901` — `saveMap` is not atomic
**Lens:** Data lifecycle. **Confidence:** Traced.
`writeFileSync` truncates the only copy of the commit's map. A kill/disk-full during build destroys it; the next read throws (safe direction: no map → all/rebuild, but the map is lost).
**Fix (8 checks):** write `map.json.tmp` in the same directory and `renameSync` over the target; fsync optional. No caller change. Test a simulated partial write (write a tmp, rename).

### 25. `packages/core/src/factory.ts:493` — `Math.max(...values)` throws on large maps
**Lens:** Boundary. **Confidence:** Confirmed (empirical).
One number per mapped function; ~125k entries overflow the argument limit. **Reproduced:** 130k and 124k both `RangeError: Maximum call stack size exceeded`.
**Fix (8 checks):** a reduce loop for the maximum (and any other spread max). Add a synthetic 130k test.

### 26. `packages/core/src/env.ts:49-52` — Empty projection/relocation values become real rules
**Lens:** Environment. **Confidence:** Confirmed (code).
`scanFromEnv` accepts `''` for `CBD_PROJECTION_FROM/TO`/`CBD_RELOCATE_FROM/TO`, unlike `readSelection` and the japa `envValue`. An empty `from` canonicalizes to cwd, producing keys no diff can name and an `all`-forever selection.
**Fix:** treat empty as unset for both pairs (reuse an env-value helper). Test empty/one-sided values.

### 27. `packages/japa/src/plugin.ts:141-146` — `serviceShardPath` mishandles Windows extensionless paths
**Lens:** Environment. **Confidence:** Confirmed (code).
Only `/` is considered a separator; on Windows `C:\repo\.cbd\shards\run` gets `.service` inserted at the dot in `.cbd`, producing `C:\repo\.service.cbd\shards\run`.
**Fix:** use `path.dirname`/`basename`/`extname` or check both separators. Test the Windows string.

### 28. `packages/cli/src/cli.ts:229-231,269-288` — Per-suite output leaves stale files for dropped suites
**Lens:** State machine. **Confidence:** Traced.
Only suites named in the current invocation are swept. Renaming/removing a suite leaves its old file; a consumer still running that suite reads a stale subset.
**Fix:** write a manifest (`.cbd-suites.json`) in the output directory and remove files listed there that are not written this run; include it in the delete set for an all/empty answer. Test a suite rename.

### F1. `packages/cli/src/flaky.ts:61-73,142-151` — Flaky relevance ignores reads and directory listings
**Lens:** Write/read asymmetry. **Confidence:** Traced.
`touchedByTest` walks only `map.files`. A test that reads a fixture which changed between recordings is reported flaky with no relevant executed change, although selection treats reads as relevance. **Fix:** union `map.reads`/`dirReads` for the test and treat declared `opaque` as relevant (or suppress the claim); test a changed read-only fixture.

### F2. `packages/core/src/select.ts:811-814` — `verify` collapses duplicate titles
**Lens:** Cross-implementation. **Confidence:** Traced.
`indexOfTitle` keeps the first match; ground truth is title-keyed. A duplicate title's second occurrence can be missed without a report. **Fix requires design work:** key ground truth by `(file,title,ordinal)`/id, changing the public `verify` input; until then, document that duplicate titles make the count a lower bound.

### F3. `packages/core/src/map.ts:734-739` — `carryMap` drops a dirty base flag
**Lens:** Data lifecycle. **Confidence:** Traced.
The carried map keeps `next.dirty` only. A dirty base's ranges describe the dirty worktree at `base.commit`; relocating them across a later commit double-shifts ranges and the result claims clean. **Fix:** propagate `dirty:true` when either side is dirty, and/or refuse to relocate a dirty base's line ranges (mark `partial`). Test dirty base → carry → select.

### F4. `packages/core/src/source/socket.ts:440` — Empty recovered windows are discarded
**Lens:** Error path. **Confidence:** Traced.
A matched window with empty coverage and requests returns `null`: a false "coverage lost" warning, an unacked snapshot that persists, and script rows not absorbed. **Fix:** return the empty window (absorb script rows/ack) and distinguish a genuinely missing window from an empty one; test a service recorder's empty windows.

### F5. `packages/core/src/source/socket.ts:839-853` + `resolve.ts:299-313` — Generated-text failure silently falls back
**Lens:** Error path. **Confidence:** Traced.
A failed/unsupported `generated` op leaves no generated row; the build indexes the on-disk file even for a loader-transformed script. Offsets then map against the wrong text. **Fix:** mark the shard unhealthy/refuse for transformed scripts instead of falling back, or record `transformed:true` and fail at build; needs design for version skew.

### F6. `packages/core/src/source/socket.ts:353-362` — The collector ignores `hello.protocol`
**Lens:** Cross-implementation. **Confidence:** Traced.
The instrument sends it; the collector casts the take shape without comparing. A wire change is misread instead of refused (only snapshot recovery checks a protocol). **Fix:** compare `hello.protocol` to the collector's supported version and refuse with a rebuild message. Test a mismatched hello.

### F7. `packages/core/src/in-process.ts:129-145` + `recorder.ts:452-461` — `takeSync` failure becomes an empty window
**Lens:** Error path. **Confidence:** Traced.
A non-synchronous/closed inspector makes `takeSync` throw; `syncWindows` substitutes an empty capture, leaving earlier files in the map and a well-formed shard with silently reduced coverage. **Fix:** propagate a health flag/shape so the shard is refused or the map marked partial; test a throwing `takeSync`.

## Already Guarded (Reference)

- **`stats.untestedFiles` includes load-only/between-only files** — intentional and asserted (`factory.spec.ts:760-775`).
- **`commitsSince` returns 0 when git fails** — documented as intentional (`changes.ts:398-406`).
- **`normalize.scan` ordinal logic diverges from `resolve.ts`** — dead in the server/CLI path (no caller); not a live bug.
- **`localeCompare` ordering** — presentation only; it never changes the selected set.
- **`socketSource({socket})` does not apply the own-pid filter** — requires an explicit caller; over-selects rather than misses; accepted.
- **`dispatch`'s `gone && fallbackTaken` short-circuit** — cost/diagnostics only; recorded data is unaffected.

## Refutation Log

- **#6 with a `<module>` entry** — **Corrected:** a synthetic map containing `<module>@0` with the third test made the compensating case select all three; real static imports are in the `load` bucket, not `files`, so the no-`<module>` map is the representative one and the finding stands.
- **"Always `--no-worktree` is broken"** — **Refuted for map==HEAD:** both directions are empty, which is why the existing tests pass; the defect needs drift.
- **`serviceShardPath` for POSIX dotted directories** — **Not a bug** on POSIX: the last-dot rule intentionally declines to treat a dot after a separator as an extension.
- **`stats.untestedFiles` divergence from selection** — **Refuted** by the intentional test.
- **`normalize.scan` ordinal collision** — **Refuted as dead** in the shipping path.
- **`sourceMapSource` using `sources[0]` only** — **Unverified for bundles**, but the documented case (tsc declaration maps) is single-source; left in Needs Review, not BUG.

## Needs Human Review

- **`map.ts:196-213` `sourceMapSource` first source only** — multi-source bundles may under-record reads; no measured bundle case.
- **`rescan.ts:287-294` swallows the correlate-refusal error** — the run aborts with "no instrumented service" and loses the actionable "rebuild the package" message; diagnostics only.
- **Windows support policy** — findings #12 and #27 are confirmed on Windows path strings; if Windows is not a supported runtime, they drop to informational.
- **`--no-worktree` + `--since` combined semantics** — the factory unions a base leg and a HEAD leg; after #2, confirm the intended base-vs-HEAD union with the CLI docs.

## Follow-up

The two empirical harnesses used in refutation are reproducible in `/tmp` (git-quoted café/naïve repo; Node 22 phantom-bind socket). No source file was modified by this hunt.
