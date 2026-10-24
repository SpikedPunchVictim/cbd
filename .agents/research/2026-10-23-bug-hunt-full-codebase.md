# Bug Hunt Report: CBD full codebase

**Date:** 2026-10-23
**Scope:** Full codebase — core (sources, instrument, recorder, shard, map, select, resolve, changes, normalize, trackers, factory, config, env), CLI, and all five framework adapters plus mutate. Prioritized by consequence: coverage sources and attribution first, then the map/selection/diff layers, then recorder/shard/factory, then CLI, then adapters.
**Lenses Applied:** all 9 (assumptions, state machines, boundaries, data lifecycle, error paths, time & concurrency, environment divergence, cross-implementation divergence, write/read asymmetry)
**Runtime context:** Server (Node >= 22) only; no browser, no SQL/migrations/DB. `dist/`, `node_modules/`, fixtures and tests excluded from audit.
**Files read in full:** five full-read passes (sources + instrument; map/select/diff; recorder/shard/factory/config; CLI + japa seam; mocha/vitest/jest/node-test/mutate). Every finding below was then re-read and re-checked in the main thread against its cited lines and the guard map.

## Guard Map

Guard locations consulted during verification and refutation (Step 2):

- migrations: none (no DB, no schema files)
- API/input schemas: `packages/core/cbd.config.schema.json`, `packages/core/src/config.ts`, `packages/core/src/args.ts` (flag allowlists + validators)
- validation modules: `packages/core/src/env.ts` (empty-vs-unset, selection reader), `packages/core/src/shard.ts` (`parseShard` version/footer/second-header), `packages/core/src/source/inspector.ts` (`isLoopbackHost`, collector lock), `packages/core/src/types.ts` (Source contract)
- middleware/guards: none; framework hooks live in `packages/{japa,mocha,vitest,jest,node-test}/src`
- config defaults/limits: `cbd.config.schema.json`, `config.ts`, `SHARD_VERSION`, `MAP_VERSION`, `INSTRUMENT_PROTOCOL`, `ATTACH_ATTEMPTS`
- shared constants: `contract.ts`, `instrument-protocol.ts`, `CORRELATION_HEADER`
- sibling implementations: four `Source`s (`in-process`, `socket`, `rescan`, `inspector`); five adapters (japa, mocha, vitest, jest, node-test); v1/v2 shard readers
- tests: `packages/*/tests/**` (used to distinguish intended behavior from defects)

## Summary

| Status | Count |
|--------|-------|
| Bugs Found | 17 |
| Fragile Code | 20 |
| OK (Already Guarded) | 12 |
| Needs Review | 12 |
| Killed in Refutation | 7 |

## Issue Rating Table

All BUG and FRAGILE findings, sorted by Urgency then ROI.

| # | Finding | Lens | Confidence | Urgency | Risk: Fix | Risk: No Fix | ROI | Blast Radius | Fix Effort |
|---|---------|------|-----------|---------|-----------|--------------|-----|--------------|------------|
| 1 | mocha/src/auto.ts:75,84-95 — every node child under the inherited preload truncates the run's one shard | Env/Cross-impl | Confirmed (empirical) | 🔴 CRITICAL | ⚪ Low | 🔴 Critical | 🟠 Excellent | 1 file | Trivial |
| 2 | cli/src/collect.ts:151-162 — stale ambient `CBD_SELECTION` silently narrows `--no-select` / mode-all runs | Write/Read | Confirmed (empirical) | 🔴 CRITICAL | ⚪ Low | 🔴 Critical | 🟠 Excellent | 1 file | Trivial |
| 3 | core/src/source/rescan.ts:388-477 — no `generatedMissing`; failed generated fetch silently indexes wrong bytes | Cross-impl | Traced | 🟡 HIGH | 🟡 Medium | 🔴 Critical | 🟠 Excellent | 1 file (+prefix mapping) | Small |
| 4 | core/src/source/rescan.ts:219-251 — lost per-target window is swallowed, so the shard looks healthy | Error path | Traced | 🟡 HIGH | 🟡 Medium | 🔴 Critical | 🟠 Excellent | 3 files (contract addition) | Medium |
| 5 | core/src/changes.ts:351 — git's trailing TAB on spaced paths is kept, so the change is ignored | Boundaries | Confirmed (empirical) | 🟡 HIGH | ⚪ Low | 🔴 Critical | 🟠 Excellent | 1 file | Trivial |
| 6 | core/src/changes.ts:255 — `diff --git` split at the first `" b/"` corrupts paths containing that substring | Boundaries | Confirmed (empirical) | 🟡 HIGH | ⚪ Low | 🟡 High | 🟠 Excellent | 1 file | Trivial |
| 7 | core/src/factory.ts:604-616 — every shard is parsed before the commit filter, so one killed run poisons `cbd build` | Data lifecycle | Confirmed (empirical) | 🟡 HIGH | ⚪ Low | 🟡 High | 🟠 Excellent | 1 file | Small |
| 8 | cli/src/collect.ts:230-231,251 — non-`.ndjson` `--shard` is written but never counted or built | Boundaries | Confirmed (empirical) | 🟡 HIGH | ⚪ Low | 🟡 High | 🟠 Excellent | 1 file + docs | Trivial |
| 9 | core/src/correlate.ts:133-195 — ESM named `http.request` is never patched (no `syncBuiltinESMExports`) | Cross-impl | Confirmed (empirical) | 🟡 HIGH | ⚪ Low | 🟡 High | 🟠 Excellent | 1 file | Trivial |
| 10 | core/src/mutate.ts:116 — `<module>` entry makes every line "covered", defeating the outside-function rule | Cross-impl | Traced | 🟡 HIGH | ⚪ Low | 🟡 High | 🟢 Good | 1 file | Trivial |
| 11 | core/src/mutate.ts:114 — partial/unhealthy/opaque/reads are ignored, so killers are reported survived | Data lifecycle | Traced | 🟡 HIGH | ⚪ Low | 🟡 High | 🟢 Good | 1 file | Small |
| 12 | node-test/src/install.ts:127-149; vitest/src/install.ts:111-132 — a throwing consumer afterEach aborts the adapter's, refusing the next test | State machine | Confirmed (empirical, node-test) / Traced (vitest) | 🟡 HIGH | 🟡 Medium | 🟡 High | 🟢 Good | 2 files | Small |
| 13 | node-test/src/identity.ts:77-80; jest/src/config.ts:48-51 — a title containing ` > ` mis-splits and the selected test is silently skipped | Cross-impl | Confirmed (empirical) | 🟡 HIGH | 🟡 Medium | 🟡 High | 🟢 Good | 2 files | Small |
| 14 | core/src/source/in-process.ts:35-81 — never reports `generatedMissing`; a failed text fetch falls back silently | Error path | Traced | 🟢 MEDIUM | ⚪ Low | 🟡 High | 🟢 Good | 1 file | Small |
| 15 | core/src/source/socket.ts:657-682 — an unanswered `correlate` rejects and leaves the socket open | Error path | Traced | 🟢 MEDIUM | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 16 | core/src/select.ts:778 — `map.dirty`/`map.distance` ignored when `mapInfo` is omitted | Write/Read | Traced | 🟢 MEDIUM | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| 17 | core/src/source/rescan.ts:145,287-290 — two timeouts write a live target off for the whole run, silently | Time/concurrency | Traced | 🟢 MEDIUM | ⚪ Low | 🟡 High | 🟢 Good | 1 file | Small |
| F1 | core/src/instrument.ts:780 + socket.ts:657-661 — `correlating` is a boolean, not the header name | Cross-impl | Traced | 🟢 MEDIUM | 🟡 Medium | 🟢 Medium | 🟡 Marginal | 3 files (wire field) | Small |
| F2 | core/src/recorder.ts:725-737 — `runStart` leaks `#testCount`/`#ordinals`/`#loadCaptured` between runs | State machine | Traced | 🟢 MEDIUM | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Small |
| F3 | core/src/recorder.ts:463-478 + japa/src/adapter.ts:220-227 — a sink throw escapes the unawaited emit path | Error path | Traced | 🟢 MEDIUM | 🟡 Medium | 🟢 Medium | 🟡 Marginal | 2 files | Small |
| F4 | core/src/read-tracker.ts:96-113, record.ts:72-83 — a not-yet-existing path is not canonical under a symlinked root | Env/Write-Read | Traced | 🟢 MEDIUM | ⚪ Low | 🟢 Medium | 🟢 Good | 2 files | Small |
| F5 | core/src/shard.ts:313-318 — `FileSink.reset()` truncates with no ownership; two writers interleave | Data lifecycle | Traced | 🟢 MEDIUM | 🟡 Medium | 🟢 Medium | 🟡 Marginal | 1 file + design | requires design work |
| F6 | cli/src/collect.ts:119-127 — a corrupt nearest map makes collect refuse to run the suite | Error path | Confirmed (empirical) | 🟢 MEDIUM | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Small |
| F7 | cli/src/collect.ts:339-344 — selection file left behind when the post-run build fails | Data lifecycle | Confirmed (empirical) | ⚪ LOW | ⚪ Low | ⚪ Low | 🟢 Good | 1 file | Trivial |
| F8 | cli/src/gc.ts:79,88-95 — unguarded `statSync`/`rmSync` aborts the whole gc | Time/concurrency | Traced | ⚪ LOW | ⚪ Low | ⚪ Low | 🟢 Good | 1 file | Trivial |
| F9 | cli/src/collect.ts:281-286 — two collects with the same explicit `--shard` share one selection file | Time/concurrency | Traced | ⚪ LOW | ⚪ Low | 🟢 Medium | 🟡 Marginal | 1 file | Trivial |
| F10 | core/src/factory.ts:764-771 + select.ts:565 — a rename out of `include` is dropped before rule 8 | Data lifecycle | Traced | 🟢 MEDIUM | 🟡 Medium | 🟡 High | 🟡 Marginal | 2 files + rule | requires design work |
| F11 | core/src/changes.ts:141 + select.ts:922 — `mergeChanges` concatenates `newHunks` from different coordinate spaces | Write/Read | Traced | ⚪ LOW | 🟡 Medium | 🟢 Medium | 🔴 Poor | 2 files + contract | requires design work |
| F12 | core/src/select.ts:957 — `verify` can answer a clean verdict with `checked: 0` | Assumptions | Traced | 🟢 MEDIUM | ⚪ Low | 🟡 High | 🟢 Good | 1 file | Trivial |
| F13 | core/src/changes.ts:391 — `.trim()` rewrites whitespace-significant untracked names | Boundaries | Traced | ⚪ LOW | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| F14 | core/src/resolve.ts:266 — equal mtime skips the hash, so same-size/mtime edits are accepted | Time/staleness | Traced | 🟢 MEDIUM | 🟡 Medium | 🟡 High | 🟡 Marginal | 1 file + perf trade | requires design work |
| F15 | core/src/source/socket.ts:773-775,818-833 — a dead target is re-probed every boundary when recovery returns null | Time/concurrency | Traced | ⚪ LOW | ⚪ Low | 🟢 Medium | 🟡 Marginal | 1 file | Small |
| F16 | core/src/source/socket.ts:906-909 + instrument.ts:790-817 — generated text is fetched for every recorded script | Cross-impl | Traced | 🟢 MEDIUM | ⚪ Low | 🟢 Medium | 🟢 Good | 2 files | Trivial |
| F17 | vitest/src/install.ts:58-59 — a selection-only handoff is ignored without `CBD_SHARD` | Env/Cross-impl | Traced | ⚪ LOW | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| F18 | japa/src/adapter.ts:229-256 — `close()` is skipped when a drain rejects (service socket stays open) | Error path | Traced | 🟢 MEDIUM | ⚪ Low | 🟢 Medium | 🟢 Good | 1 file | Trivial |
| F19 | cli/src/collect.ts:159-161 — an inherited `CBD_INSPECT` attaches without the CLI's preflight | Env/Write-Read | Traced | ⚪ LOW | ⚪ Low | 🟢 Medium | 🟡 Marginal | 1 file | Trivial |
| F20 | core/src/instrument.ts:94-100 — `CBD_SNAPSHOT_MS` above INT32_MAX is clamped by Node to 1 ms | Boundaries | Confirmed (empirical) | 🟢 MEDIUM | ⚪ Low | 🟡 High | 🟢 Good | 1 file | Trivial |

## Fix Plan & Interactions

**Ships-with sets** (never split across phases):
- #3 + #4 + #14 — one change to the `Source` health seam: `generatedMissing` in rescan (with pid prefixes) and in-process, and the lost-window count that makes rescan's swallow honest. Splitting them leaves #4's fix reporting a loss without #3's ids, or vice versa.
- #10 + #11 — same file (`mutate.ts`), same "select's safety ladder" premise; two edits, one review.
- #12 (node-test) + #12 (vitest) — one state-machine shape; fix both together so the guard matrix stays level.
- #5 + #6 — same parser, one patch with one test file.

**Ordering constraints:**
- #2 before F9 — the selection-file lifecycle is touched by both; unsetting the env first means a leaked file is only an untidy file, never a silent filter.
- #8 before #1 — validating `--shard` removes one way to produce an unfindable shard, so the mocha fix is tested against a sane path.
- #13 after #12 — the title fix changes what `beforeEach` receives; land the hook-robustness change first so the pattern change is tested on a run that cannot abort.

**Shared work:**
- #5 + #6 + F13 — one pass over `changes.ts` header/path parsing: strip the git-appended TAB, split `diff --git` by matching both sides, drop `.trim()` on `-z` output. One test file with spaced, ` b/`, and trailing-space names.

**Deferred to design work:**
- F5 — needs an ownership/lock mechanism for a shard path, or unique per-process paths; a one-line guard cannot tell two legitimate writers from one rerun.
- F10 — needs a rule for "a file moved out of scope" (treat as deletion of `from`), which is a selection-policy decision, not a bug fix.
- F11 — `mergeChanges` cannot reconcile coordinates without deciding which end-commit the merged set describes; verify must either receive per-leg changes or a stated coordinate.
- F14 — always hashing every recorded script is a build-time cost the mtime fast path exists to avoid; the choice is a flag or a documented accepted risk.

**Suggested phases:**
1. Phase 1 — data loss and silent under-selection, isolated files: #1, #2, #5, #6, #7, #8, #9, #15, #16, F7, F8, F13, F20.
2. Phase 2 — source health accounting: #3, #4, #14, #17.
3. Phase 3 — adapters: #12 (both), #13 (both), F17, F18.
4. Phase 4 — mutate: #10, #11.
5. Phase 5 — fragility batch: F1, F2, F3, F4, F12, F15, F16, F19.

## Detailed Findings

### 1. `packages/mocha/src/auto.ts:75,84-95` — every node child truncates the run's shard
**Lens:** environment divergence / cross-implementation
**Confidence:** Confirmed (empirical)
**Assumption:** the process that loads `@spikedpunch/cbd-mocha/auto` is the run's only writer of `CBD_SHARD`.
**Violation scenario:** the documented setup puts the preload in `NODE_OPTIONS`, and `cbd collect` puts `CBD_SHARD` in the child environment. Both are inherited by every `node` process a test spawns (and by mocha `--parallel` workers). Each such process runs `auto.js`, which opens `FileSink(CBD_SHARD)` and calls `recorder.runStart()` → `FileSink.reset()` → `writeFileSync(path, '')`.
**Consequence:** the parent's whole recording is erased and replaced by a header-only shard owned by the child. The build then refuses the run (no `end`), or, if the child's own footer lands, the map describes the child.
**Current code:**
```ts
const shardPath = process.env.CBD_SHARD || undefined
...
recorder = beginShard({ source, sink: new FileSink(shardPath), ... })   // runStart() resets it
```
**Verified fix** (all eight checks pass — no arithmetic; mirror path is japa's own `delete process.env.CBD_SHARD` at `packages/japa/bin/test.js:23-25`; no existing data; caller contract unchanged; no interaction beyond #8):
```ts
const shardPath = process.env.CBD_SHARD || undefined
// The runner owns this path for this process only. A child spawned by a test
// inherits both the preload and the variable, and would reset the shard we are
// writing (measured: one `node -e` child replaced a complete parent shard with
// its own header). The value has been read; removing it makes every descendant
// inert, exactly as the japa entry point does.
delete process.env.CBD_SHARD
```
**Fix notes:** mocha `--parallel` still records nothing from workers after this (they were corrupting before); parallel support needs per-process shard paths — a follow-up, not part of this fix.
**Evidence:** `CBD_SHARD=/tmp/mocha-shard.ndjson NODE_OPTIONS="--import …/dist/src/auto.js" node -e 'console.log("child done")'` left `/tmp/mocha-shard.ndjson` as one header line with the child's pid (`wc -l` = 1), replacing a valid 2-line file.

### 2. `packages/cli/src/collect.ts:151-162` — a stale ambient `CBD_SELECTION` narrows the run
**Lens:** write/read asymmetry / environment divergence
**Confidence:** Confirmed (empirical)
**Assumption:** the child's selection is only what this `collect` wrote.
**Violation scenario:** `CBD_SELECTION=/old/selection.json cbd collect --no-select -- npm test`, or any mode-`all` run in a shell/service that exports it. `childEnv` spreads `process.env` and only assigns `CBD_SELECTION` for a subset; the "run everything" paths leave the inherited value in place, and the adapter's `readSelection(process.env)` narrows to it.
**Consequence:** a 2-test suite records a 1-test shard, exit 0, and the post-run build replaces the full map with a 1-test map (silent under-selection from then on). If the stale path is gone, the child dies at adapter install instead.
**Current code:**
```ts
if (titles !== undefined) env[SELECTION_ENV] = selectionPath
```
**Verified fix** (checks: no arithmetic; the only writer of the per-run file is this command; caller contract is env-only):
```ts
// The environment is inherited from the shell. A stale CBD_SELECTION from an
// earlier run is not a selection this run asked for: a mode-all or --no-select
// run must not be narrowed by it. Only the file this command wrote may remain.
if (titles !== undefined) env[SELECTION_ENV] = selectionPath
else delete env[SELECTION_ENV]
```
**Evidence:** with a v2 selection naming one of two tests exported, `cbd collect --no-select --no-build` exited 0, logged the stale path as `CBD_SELECTION`, and wrote exactly 1 test record.

### 3. `packages/core/src/source/rescan.ts:388-477` — failed generated fetch is invisible
**Lens:** cross-implementation divergence / write-read asymmetry
**Confidence:** Traced
**Assumption:** every source implements `generatedMissing?()`.
**Violation scenario:** a service's end-of-run `generated` op fails or names scripts it could not produce (older instrument, socket dying at teardown). The nested `socketSource` records the ids in its own `missingGenerated` (`socket.ts:905`), but `rescanningSocketSource` has no `generatedMissing`, so the recorder writes no `health` record (`recorder.ts:933`) and `resolve.ts:473-488` adds no partial file.
**Consequence:** the build indexes the on-disk file as the generated text for a script V8 compiled differently, so byte offsets resolve to wrong source lines — silent wrong attribution, both directions.
**Current code:** the returned object has `scripts`, `generated`, `prepare`, `drift`, `close` — no `generatedMissing`.
**Verified fix** (checks: mirror of `prepare`'s first-colon split at `rescan.ts:421-437`; ids in the shard rows are `${pid}:${id}` at `rescan.ts:213`, so they must be prefixed here; no caller contract change — the method is optional):
```ts
generatedMissing: () =>
  targets.flatMap((target) =>
    (target.source.generatedMissing?.() ?? []).map((id) => `${String(target.pid)}:${id}`),
  ),
```
**Evidence:** traced against `recorder.ts:930-948`, `resolve.ts:474-487`, `map.ts:366-369`, `select.ts:578-584`; `socket.ts:905` and `inspector.ts:891` are the guarded siblings.

### 4. `packages/core/src/source/rescan.ts:219-251` — a lost window is counted as an ordinary empty one
**Lens:** error path / cross-implementation
**Confidence:** Traced
**Assumption:** the recorder's `failedTakes` sees every source failure.
**Violation scenario:** one target dies mid-run with no recoverable snapshot. The nested `socketSource` reports the loss on stderr and throws (`socket.ts:831-832`); `takeFrom` converts the rejection into a *resolved* empty capture (`rescan.ts:245-250`) so one dead service cannot blank the lane's coverage in the same window.
**Consequence:** `Recorder`'s `failedTakes` (`recorder.ts:536-544`) is never incremented, no `health` record is written, and `select` does not `forceAll('unhealthy')` (`select.ts:591-593`) — the map looks complete while a window is missing. The swallow is deliberate; losing the *accounting* with it is not.
**Current code:**
```ts
() => ({ coverage: [], ids: [], requests: [] }),   // rejection → empty, uncounted
```
**Verified fix** (three files; see ships-with): a `lostTakes?(): number` on the `Source` contract, incremented by rescan's rejection handler and added to the recorder's counter:
```ts
// types.ts
/** Windows this source settled with no evidence, for its own reason. */
lostTakes?(): number
// rescan.ts — in the rejection handler, after swallowing the coverage
lost += 1
// recorder.ts — both window implementations
failedTakes: () => failedTakes + (source.lostTakes?.() ?? 0)
```
**Fix notes:** the alternative — rejecting the window — would discard other targets' coverage in the same boundary, which is under-selection; the contract member is what lets the count travel without the coverage.

### 5. `packages/core/src/changes.ts:351` — a spaced path keeps git's trailing TAB
**Lens:** boundaries
**Confidence:** Confirmed (empirical)
**Assumption:** `line.slice(4)` is the path.
**Violation scenario:** git appends a TAB to `---`/`+++` when the path contains a space. `src/my file.ts` (modified) parses to `src/my file.ts\t`, and `from` stays clean, so it also reads as a rename.
**Consequence:** with an include glob ending in a literal segment (`src/**/*.ts`), the tabbed path fails the glob and the factory drops it into `ignored` — a subset that silently omits the changed file.
**Current code:**
```ts
} else if (line.startsWith('+++ ')) {
  const path = unquoteGitPath(line.slice(4))
```
**Verified fix** (checks: only unquoted lines are affected — a path with a TAB is always C-quoted, so the first TAB on an unquoted line is the separator; no arithmetic; total for every input length):
```ts
const rawHeaderPath = (line: string): string => {
  const raw = line
  // git writes `--- a/x y<TAB>` (an optional timestamp follows) when the name has
  // a space. A quoted name is handled by unquoteGitPath and never has this form.
  return raw.includes('\t') && !raw.startsWith('"') ? raw.slice(0, raw.indexOf('\t')) : raw
}
const path = unquoteGitPath(rawHeaderPath(line.slice(4)))
```
**Evidence:** `git diff` parse on a temp repo returned `{"path":"src/my file.ts\t","from":"src/my file.ts","status":"M"}`.

### 6. `packages/core/src/changes.ts:255` — `diff --git` split inside a path
**Lens:** boundaries
**Confidence:** Confirmed (empirical)
**Assumption:** the first `" b/"` separates old from new.
**Violation scenario:** a path containing ` b/`, e.g. `x b/del.ts`. Deleted, the header is `diff --git a/x b/del.ts b/x b/del.ts`; the split lands inside the old name.
**Consequence:** `{path:"del.ts b/x b/del.ts", from:"x", status:"D"}` — rule 8 never matches the map key and the change falls outside include, so the tests that reached it are not selected.
**Verified fix** (checks: split where both sides are equal (a non-rename), else the first occurrence — total, no offsets):
```ts
const boundary = (index: number): number => index
let split = -1
for (let i = rest.indexOf(' b/'); i !== -1; i = rest.indexOf(' b/', i + 1)) {
  if (rest.slice(2, i) === rest.slice(i + 3)) { split = i; break }
}
if (split === -1) split = rest.indexOf(' b/')
return { oldPath: rest.slice(2, split), path: rest.slice(split + 3) }
```
**Evidence:** temp-repo parse returned `{"path":"del.ts b/x b/del.ts","from":"x","status":"D"}`.

### 7. `packages/core/src/factory.ts:604-616` — a foreign killed shard poisons every default build
**Lens:** data lifecycle
**Confidence:** Confirmed (empirical)
**Assumption:** the commit filter can be applied before parsing.
**Violation scenario:** a `cbd collect` killed mid-run leaves a footerless shard; a v1 shard survives an upgrade. The default glob reads every shard and calls `parseShard` first, which throws for the whole file before `header.commit !== commit` can skip it.
**Consequence:** every later `cbd build` (the CI path) fails until the file is removed or `--partial` is passed — even though the shard belongs to another commit and could not contribute.
**Verified fix** (checks: read only the first line; a first line that is not JSON or not a header falls through to `parseShard`, preserving today's error; a same-commit v1 shard still throws, which is right):
```ts
const text = readFileSync(path, 'utf8')
if (options.shards === undefined) {
  const first = firstRecord(text)
  if (first?.type === 'shard' && first.commit !== commit) {
    skipped.push(`${basename(path)} (commit ${first.commit})`)
    continue
  }
}
const records = parseShard(text, path, { allowIncomplete: options.partial === true })
```
**Evidence:** with a complete shard at HEAD plus a footerless `deadbeef` shard, `cbd build` exited 1 (`has no end record`); `--partial` exited 0.

### 8. `packages/cli/src/collect.ts:230-231,251` — a non-`.ndjson` shard is invisible
**Lens:** boundaries / write-read asymmetry
**Confidence:** Confirmed (empirical)
**Violation scenario:** `--shard custom/run.txt` (or `custom/run`). `FileSink` writes exactly that path; `shardSizes`/`shardsWrittenSince` and `factory.shardFiles` accept only `.ndjson`.
**Consequence:** collect reports "no tests ran; nothing recorded", skips the build, and exits with the child's 0, while a valid shard sits on disk that `cbd build` can never find.
**Verified fix** (checks: the constraint is read from `factory.ts:484`; CLI-only, one file + help):
```ts
// args.ts, after `shard` is read:
if (shard !== undefined && !shard.endsWith('.ndjson')) {
  throw new UsageError(
    `--shard must name a .ndjson file: cbd build finds shards by that extension, ` +
      `so "${shard}" would be written and then never read`,
  )
}
```
**Fix notes:** the alternative — teach discovery the explicit path — leaves `cbd build` unable to find it later; rejecting the flag is the honest contract.
**Evidence:** `cbd collect --shard custom/run.txt` exited 0 with "no tests ran; nothing recorded"; `custom/run.txt` existed.

### 9. `packages/core/src/correlate.ts:133-195` — ESM named `http.request` is not patched
**Lens:** cross-implementation divergence
**Confidence:** Confirmed (empirical)
**Violation scenario:** a test or dependency does `import { request } from 'node:http'` before the plugin installs. The default export is patched; the named binding is a snapshot and stays unpatched.
**Consequence:** those requests carry no correlation header, so the service attributes them by time — the cross-window misattribution the correlator exists to remove, with no warning.
**Verified fix** (checks: mirror is `read-tracker.ts:175,187`, which calls it; release must sync too or the patched functions survive the run):
```ts
import { syncBuiltinESMExports } from 'node:module'
patch(http, 'request'); patch(http, 'get'); patch(https, 'request'); patch(https, 'get')
// Named ESM imports of a builtin are snapshots; without this the default export
// is patched and `import { request } from 'node:http'` is not.
syncBuiltinESMExports()
...
this.#release = () => {
  for (const undo of restore.reverse()) undo()
  syncBuiltinESMExports()
}
```
**Evidence:** after `Correlator.install()`, `http.request === namedRequest` was `false`; after adding `syncBuiltinESMExports()` in a standalone probe it was `true`. `fs.readFileSync` (read-tracker) was already `true`.

### 10. `packages/core/src/mutate.ts:116` — `<module>` defeats the outside-function rule
**Lens:** cross-implementation divergence
**Confidence:** Traced
**Violation scenario:** a dynamically imported module records a `<module>@0` entry whose range spans the whole file. `entries` includes it, so `everyLineCovered` is always true and `intersecting` is never empty.
**Consequence:** a mutant outside every real function answers `{mode:'subset', why:'function'}` with only the module's importer, instead of the file-wide answer — killers are missed and the mutant is reported survived.
**Verified fix** (checks: sibling guard is `select.ts:304`, which filters `<module>` from the same check; `testsOf` keeps the module entry for the file-level answer at line 146):
```ts
const entries = Object.entries(functions)
  .filter(([key]) => !key.startsWith('<module>'))
  .map(([, entry]) => entry)
```
**Evidence:** `select.ts:303-304` comment names this exact failure ("would call every hunk inside a function and re-open the straddle miss"); `packages/core/tests/select.spec.ts:456` pins it for select.

### 11. `packages/core/src/mutate.ts:114-160` — the safety ladder stops at functions
**Lens:** data lifecycle
**Confidence:** Traced
**Violation scenario:** `mutantTests` reads `files`, `load`, `between`, `teardown`, `seen`, `tests` — never `partial`, `unhealthy`, `opaque`, `reads`, `dirReads`, all of which `select` uses (`select.ts:578-584,601-609,731-737`).
**Consequence:** (a) an incremental map that marks the file partial forces `all` in select but yields a subset for a mutant; (b) a `recordOpaque` test selected by any in-scope change is never a mutation candidate; (c) a text-oracle reader is omitted — mutants reported survived that would be killed.
**Fix** (checks: additive reads of existing map fields; keep the documented order):
```ts
if (map.partial?.some((entry) => samePath(entry, file))) return { mode: 'all', why: 'partial', tests: [] }
if (map.unhealthy?.some((entry) => samePath(entry.file, file))) return { mode: 'all', why: 'unhealthy', tests: [] }
// opaque/reads/dirReads: union their tests into every non-'none' answer
```
**Fix notes:** the exact reason labels are a contract for `MutantWhy`; confirm them with the CLI's renderer before widening the union type.

### 12. `packages/node-test/src/install.ts:127-149`; `packages/vitest/src/install.ts:111-132` — a throwing afterEach refuses the next test
**Lens:** state machine
**Confidence:** Confirmed (empirical, node-test); Traced (vitest)
**Violation scenario:** a consumer `afterEach` throws. Both runners run afterEach chains innermost-first and stop at the throw, so the adapter's own afterEach never decrements `open`. The next `beforeEach` sees `open > 0`, sets `refused`, and throws.
**Consequence:** a test that would pass is failed with "cbd: … running tests concurrently", and the file's shard has no `end` record, so the build refuses the whole run. A cleanup assertion is a normal source of a throwing afterEach.
**Verified fix** (checks: hooks cannot be ordered around the consumer's, so make the adapter's own hook independent — close in `afterEach` and in a `beforeEach` fallback, and only refuse on a *truly* overlapping window):
```ts
hooks.beforeEach((context) => {
  // An afterEach that threw before ours left the previous window open; that is a
  // lost boundary, not concurrency. Close it with what the runner knows.
  if (pending !== null) { recorder.testEnd(pending.title, statusOf(pending.context)); open -= 1; pending = null }
  ...
})
```
**Evidence:** `node --test` probe with a throwing consumer afterEach printed `consumer afterEach` for both tests and never `adapter afterEach`; `pass 0, fail 2`.

### 13. `packages/node-test/src/identity.ts:77-80`; `packages/jest/src/config.ts:48-51` — a title containing ` > `
**Lens:** cross-implementation divergence
**Confidence:** Confirmed (empirical)
**Violation scenario:** a recorded title `outer > a > b` where the literal title is `a > b`. `title.split(' > ')` cannot tell separators from literal text, so the pattern becomes `^outer a b$` while the runner matches `outer a > b`.
**Consequence:** the selected test is filtered out, runs nothing, and enters no shard — silent under-selection, the direction this project refuses.
**Verified fix** (checks: no arithmetic; the widened set only adds plausible readings (over-selection, the safe direction); cap the ambiguity at 8 occurrences (256 alternatives) so a pathological title cannot explode):
```ts
// Every reading of the title: each ` > ` is either the separator or literal text.
// The runner's matching name is one of these; adding the others can only widen
// the pattern, never narrow it.
function readings(title: string): string[] { /* generate all splits, cap at 8 */ }
```
**Fix notes:** the durable fix is carrying the runner's own full name in the selection file; until then, widening is safe.
**Evidence:** with a test `describe('outer') / it('a > b')`, `--test-name-pattern='^outer a > b$'` ran it; `'^outer a b$'` (the CBD pattern) did not.

### 14. `packages/core/src/source/in-process.ts:35-81` — failed text fetch falls back silently
**Lens:** error path / cross-implementation
**Confidence:** Traced
**Violation scenario:** `Debugger.getScriptSource` errors (script dropped by V8 in a long run) for a script that has a map. `generateFor` returns `undefined`; `prepare` skips it; `generatedMissing` is absent.
**Consequence:** the build indexes the file on disk as the generated text — the wrong bytes — and no partial flag protects the file.
**Verified fix** (mirror of `socket.ts:905`):
```ts
const missingGenerated = new Set<string>()
// in prepare, where generatedFor returned undefined for a script with a map:
if (value !== undefined) info.generated = value
else missingGenerated.add(scriptId)
...
generatedMissing: () => [...missingGenerated],
```
**Evidence:** `prepare` gates on a map (`in-process.ts:77`) so only transformed scripts are fetched; the signal is simply never recorded, unlike both siblings.

### 15. `packages/core/src/source/socket.ts:657-682` — an unanswered `correlate` leaks the socket
**Lens:** error path
**Confidence:** Traced
**Violation scenario:** `correlationHeader` is set and the target answers hello, then stops answering. `client.request('correlate')` rejects at `timeoutMs`; the call sits outside `openOne`'s try/catch.
**Consequence:** `socketSource` throws with the `net.Socket` still open and referenced, so a recording run can print its summary and hang — the failure `recorder.ts:965-980` warns about.
**Verified fix** (checks: `close()` is idempotent; no caller holds the client after the throw):
```ts
try {
  const reply = await client.request('correlate', undefined, options.correlationHeader)
  if (!reply.ok) { /* existing refusal */ }
} catch (error) { client.close(); throw error }
```
**Evidence:** `#send`'s timeout (`socket.ts:289-292`) rejects without `#fail`, so `gone` stays false and the socket is never destroyed; `openOne` closes only on its own errors.

### 16. `packages/core/src/select.ts:778` — `map.dirty` ignored by the library API
**Lens:** write/read asymmetry
**Confidence:** Traced
**Violation scenario:** `select(map, changes, { strict: true })` with `loadMap(...).map.dirty === true` and no `mapInfo`. `info.dirty` falls back to `false`; `distance` to `0`.
**Consequence:** `strict` promises a full run for an untrustworthy map; the caller gets a subset with no warning.
**Verified fix** (checks: the map field is written by every build at `map.ts:549`; `MapInfo` is only an override):
```ts
const info: MapInfo = {
  commit: mapInfo?.commit ?? map.commit,
  distance: mapInfo?.distance ?? 0,
  dirty: mapInfo?.dirty ?? map.dirty === true,
  builtAt: mapInfo?.builtAt ?? map.builtAt,
}
```
**Evidence:** `map.ts:91-93` documents `dirty` as "`select` warns when it is true"; `factory.ts` always supplies `mapInfo`, which is why the CLI never hits it.

### 17. `packages/core/src/source/rescan.ts:145,287-290` — two timeouts write a target off silently
**Lens:** time & concurrency
**Confidence:** Traced
**Violation scenario:** a suite-started service blocked longer than `timeoutMs` during boot fails hello twice; `failures.get(path) >= ATTACH_ATTEMPTS` then skips it at every later boundary.
**Consequence:** that service's coverage is omitted from the map for the whole run with no durable signal (the `catch` is bare; nothing reaches stderr or `health`).
**Fix** (checks: no arithmetic; counts are per path; keep the give-up for terminal errors):
```ts
// A timeout is a busy target, not a leftover socket. Count it separately and
// announce the write-off once, so a missing service is never silent.
catch (error) {
  const timeout = /within \d+ms/.test(String((error as Error).message))
  ...
}
```
**Fix notes:** a warning alone leaves the map under-selected but visible; a retry-budget change is a policy decision — report both, land the warning first.

## Fragile Code (Works Now, May Break Later)

### F1. `packages/core/src/instrument.ts:780` + `socket.ts:657-661` — `correlating` is a boolean
Hello says the process correlates for *some* header; the collector skips the op when it is true. **Breaks when:** a caller passes a `correlationHeader` other than the one the service inherited (already a public option). Fix: echo the header name in hello and skip only on a match (optional wire field; older instruments fall through to sending the op).

### F2. `packages/core/src/recorder.ts:725-737` — `runStart` resets only the sink
`#testCount`, `#ordinals`, `#loadCaptured`, `#open`, `#spec` and the read sets survive. **Breaks when:** any caller drives one Recorder through two runs (watch mode, a driver that reuses it), which the docblock anticipates. The footer count accumulates and the second run's import phase is filed as `@between`. The window strategy holds its own counters too, so the full fix is a documented per-run reset.

### F3. `packages/core/src/recorder.ts:463-478` + `packages/japa/src/adapter.ts:220-227` — a sink throw escapes
`FileSink.append` is `appendFileSync` inside a japa listener japa does not await. **Breaks when:** ENOSPC/EACCES, or the shard path is removed mid-run — the throw becomes an unhandled rejection, no footer, no health record. Wrap the hook bodies and count the loss.

### F4. `packages/core/src/read-tracker.ts:96-113`, `record.ts:72-83` — not-yet-existing paths under a symlinked root
`pathOf`/`absolute` fall back to `resolve()` when `realpath` fails, while the build's root is canonical. **Breaks when:** a test asserts absence of a file under `/var/...` on macOS (canonical `/private/var/...`) and the file is created later — the read is dropped by `keepRead`. Fix: realpath the nearest existing ancestor and rejoin the tail.

### F5. `packages/core/src/shard.ts:313-318` — `FileSink.reset()` has no owner
Two writers at one path truncate and interleave; one footer makes it parse as complete. **Breaks when:** concurrent collects share an explicit `--shard`, or two vitest setup evaluations share the `pid-threadId` fallback. Requires an ownership mechanism (lock file, same pattern as the inspector lock) or unique paths.

### F6. `packages/cli/src/collect.ts:119-127` — a corrupt nearest map refuses the run
Only "no map" is treated as the first-run case; `cbd.select()` throws on an unreadable map and collect exits before spawning. **Breaks when:** map.json is truncated or from an older schema — the one command that could rebuild it refuses. Fix: warn and run everything (never under-selects) rather than propagate.

### F7. `packages/cli/src/collect.ts:339-344` — selection file left on a build failure
The single `rmSync` is after the `if (failure !== null) return failure`. **Breaks when:** a subset run's shard is unparsable. Move cleanup into a `finally`.

### F8. `packages/cli/src/gc.ts:79,88-95` — unguarded `statSync`/`rmSync`
**Breaks when:** any entry disappears between `readdirSync` and `statSync` (another gc, a concurrent collect) — the whole gc aborts. `collect.ts:232-238` already guards the identical race.

### F9. `packages/cli/src/collect.ts:281-286` — selection path derived from the shard stem
**Breaks when:** two collects are given the same explicit `--shard` — one overwrites or deletes the other's selection. Add a pid/random suffix independent of the shard name.

### F10. `packages/core/src/factory.ts:764-771` + `packages/core/src/select.ts:565` — rename out of `include`
**Breaks when:** `git mv src/a.ts scripts/a.ts` with `include: ["src/**"]` and similar content: the change is dropped before rule 8, and the tests the map knows for the old path do not run. `factory.stats` already checks `include(change.from)` (`factory.ts:1014`), showing the intended rule.

### F11. `packages/core/src/changes.ts:141` + `select.ts:922` — mixed coordinate spaces
`mergeChanges` concatenates `newHunks` from a base→map leg and a map→worktree leg into one field documented as one end-commit. **Breaks when:** `cbd select --since <base older than the map>` output is fed to `cbd.verify`. The selector itself only compares counts, so selection is unaffected.

### F12. `packages/core/src/select.ts:957` — `verify` can answer cleanly with nothing checked
A caller passing repo-relative changes gets `{misses: [], checked: 0, ranEverything: false}`. **Breaks when:** a library caller uses `changesSince` output directly. Warn (or refuse) when `checked === 0` and changes were given.

### F13. `packages/core/src/changes.ts:391` — `.trim()` on `-z` output
**Breaks when:** an untracked path has a leading/trailing space — the name is rewritten, and if the trimmed name is a known map file its tests are selected instead of the unknown-file escalation.

### F14. `packages/core/src/resolve.ts:266` — mtime equality skips the hash
**Breaks when:** a tool rewrites a same-size file while preserving mtime (`cp -p`, `rsync -t`, some codegen). The shard is accepted against different bytes. Always hashing is the correctness choice; the fast path is the performance choice — decide explicitly.

### F15. `packages/core/src/source/socket.ts:773-775,818-833` — dead target re-probed every boundary
`fallbackTaken` is set only when recovery returns a window. **Breaks when:** the target is SIGKILLed with a periodic snapshot that has no `untaken` — every later boundary pays a write to a destroyed socket plus a read+parse of the snapshot. Throttle the re-probe once `client.gone` and a probe returned null.

### F16. `packages/core/src/source/socket.ts:906-909` + `instrument.ts:790-817` — generated text for every script
`prepare` forwards every recorded id and the instrument fetches `getScriptSource` for each, while the contract says only travelling maps need it (in-process filters at `in-process.ts:77`). **Breaks when:** a big service's script table is large — end-of-run cost, a timeout that marks everything missing (every mapped file partial), and a blocked host loop. Filter ids to rows carrying `sourceMapURL`.

### F17. `packages/vitest/src/install.ts:58-59` — selection-only handoff ignored
`installVitest` returns before `readSelection` when `CBD_SHARD` is unset. **Breaks when:** `cbd select --emit-selection` output is used with vitest and no recording — the whole suite runs (over-selection, but the narrowing is lost).

### F18. `packages/japa/src/adapter.ts:229-256` — `close()` skipped on a rejected drain
The `.finally` ends correlation only. **Breaks when:** runEnd/drained rejects (sink I/O) — the service socket/CDP connection stays open and the process hangs. Move `recorder.close()` into the finally.

### F19. `packages/cli/src/collect.ts:159-161` — inherited `CBD_INSPECT` skips the preflight
Passing the lane's `CBD_INSPECT` through is the intended handoff, but the CLI validates only `--target`. **Breaks when:** an ambient target is held or malformed — the refusal arrives as a runner stack trace after setup instead of one `cbd:` line. Preflight the env value when no `--target` is given.

### F20. `packages/core/src/instrument.ts:94-100` — `CBD_SNAPSHOT_MS` above INT32_MAX
Node clamps a delay > 2 147 483 647 to 1 ms with `TimeoutOverflowWarning`. A user asking for "effectively never" gets a snapshot write every millisecond. Clamp to the platform maximum.

## Already Guarded (Reference)

Candidates cleared by verification — cite the guard:
- `packages/core/src/source/socket.ts:443-448` — snapshot windows are accepted only with the run's session and pid (foreign-run substitution is refused).
- `packages/core/src/instrument.ts:512-519` — the periodic snapshot is written atomically (tmp + rename).
- `packages/core/src/source/inspector.ts:319-329` — the lock release is token-guarded; stale takeover is a documented, accepted race.
- `packages/core/src/shard.ts:380-386` — a second shard header is refused (two appended runs).
- `packages/core/src/source/rescan.ts:213` + `421-437` — pid namespacing is symmetric across coverage, scripts, and `prepare`.
- `packages/core/src/env.ts:158-160` — an empty env value is unset in every reader.
- `packages/core/src/recorder.ts:536-544` — a rejected queued window is counted in the sync source path.
- `packages/japa/src/plugin.ts:177-186` — a configured service that cannot be reached is an error, not a silent empty map.
- `packages/mocha/src/auto.ts:76-79` — the selection is validated before the recorder is opened.
- `packages/core/src/map.ts:712-728` — `partial` markers survive incremental builds.
- `packages/jest/src/environment.ts:157-164` — the window closes on `test_done`, which jest-circus emits even after a hook error.
- `packages/core/src/source/inspector.ts:148-156` — `isLoopbackHost` fails closed, including `0.0.0.0`.

## Refutation Log

Findings and sub-claims killed or corrected in Step 5:

- "in-process `take()` lacks the outstanding-window guard the other sources have" — **Refuted**: each promise is bound to its own inspector call, so no reply can be attributed to the wrong window.
- "`LineSplitter` can split a multi-byte character" — **Refuted**: both ends `setEncoding('utf8')`, so the stream layer never splits a code point.
- "take/settle ordering relies on the transport" — **Refuted**: explicit tails in `socket.ts:836-851` and `inspector.ts:842-851`; the ordering is a property of the file.
- "inherited `CBD_INSPECT` is itself the bug" — **Corrected**: the inheritance is the documented dev-cli handoff; only the missing preflight is the defect (F19).
- "mutate's `everyLineCovered` is always true" — **Corrected**: only when a dynamically imported module contributed a `<module>` entry; the consequence (wrong `why`/subset) stands.
- "`--partial` accepts a torn shard" — **Verified as refusal, not bug**: `parseShard` throws on invalid JSON regardless of `allowIncomplete`; refusing is the safe direction (moved to Needs Review).
- "the lock's stale-takeover check-then-act window is a bug" — **Refuted**: documented and accepted; the token makes the release exact.
- "`instrument`'s `close` op enables a two-collector bug" — **Refuted as unreachable**: no production code sends it.

## Needs Human Review

- `packages/core/src/instrument.ts:969-995` + `socket.ts:519-535` — the socket is bound with umask permissions and chmod'ed 0600 after; the directory is not checked for ownership. A pre-created world-writable `CBD_SOCKET_DIR` plus a forged `pid-N.sock` supplies fabricated coverage that shapes selection. Local-only threat; decide whether to refuse a non-owned directory.
- `packages/core/src/shard.ts:346-393` — `allowIncomplete` does not accept a torn final line; `cbd build --partial` refuses the very shape it exists for. Safe direction; decide if partial should accept a truncated tail.
- `packages/jest/src/environment.ts:98-115`, `packages/vitest/src/install.ts:134-150` — the footer is written with a window still open; node-test refuses. Decide whether a complete-but-missing shard is worse than a refused one.
- `packages/vitest/src/install.ts:83,120` — `specStart` gets Vitest's raw path while test windows use realpaths; under a symlinked root the load reads fall back to every test (over-selection).
- `packages/mocha/src/adapter.ts:136-145` — `finish` never drains or closes; harmless for the CLI process, a leak in a programmatic host.
- `packages/vitest/src/install.ts:74-89` — the selection is read after the per-file shard is created; a bad selection leaves a header-only shard that the build then reports instead.
- `packages/jest/src/config.ts:64-67` — `withCbd` overwrites any `testNamePattern`, and Jest's CLI `-t` overrides the config, narrowing below the CBD selection with no warning.
- `packages/cli/bin/cbd.js:31-48` — the bin answers `--version` before validators, so `cbd build --version` exits 0 where `run()` exits 2, and `cbd --version --format xml` is accepted silently.
- `packages/cli/src/collect.ts:303` — `spawnSync` without a shell cannot run `npm.cmd` on Windows. If Windows is a target, resolve `.cmd` or use a shell; `shell: true` with an argv array is not the fix.
- `packages/core/src/source-maps.ts:85` — `decodeDataUri` can throw on a malformed non-base64 data URI and abort `buildMap`; loud, narrow.
- `packages/core/src/factory.ts:912` — `reaches` includes `<module>` in the outside-every-function check while `testsForLine` excludes it (sibling of #10).
- `packages/core/src/map.ts:seen` — omits `reads`/`dirReads` despite its docstring, so `stats`/`explain` call read-only files unknown while `select` answers them (reporting only).

## Post-report fix pass (2026-10-24)

All five phases were implemented; `pnpm -r test` is green (core 442, cli 86, mocha 9, japa 73,
jest 12, node-test 12, vitest 8, mutate 4, fixture 42+1 skipped).

**Corrected during the pass.**
- #12's first fix (close the leftover window and continue) weakened the concurrency refusal and
  contradicted its e2e. The shipped change keeps the refusal and only makes the message name
  both causes — the two states are indistinguishable from the hook.
- F15 (throttle the snapshot re-probe once `client.gone`) was implemented and **reverted**: a
  throttle cannot tell a take that was never served from one whose reply was lost, so it skipped
  recovery of numbered windows. Under a six-way concurrent run of the japa suite it turned a
  rare lost reply into lost coverage. The original per-boundary recovery stands; the wasted read
  is the price of not guessing.
- A new defect surfaced while fixing #3/#4: Node reports `sourceMapURL: ""` for a script with no
  map. The instrument copied it, `resolve` read "defined" as "has a map", and every plain
  script's file became `partial` whenever its generated text could not be fetched. Fixed in both
  places (instrument omits the empty value; `resolve` treats it as no map).

**Fixture flake, not a regression.** `own-service-e2e` ("recordNote is attributed to the test
that drove it") fails occasionally when several copies of the japa suite run at once. Measured
in controlled rounds of six concurrent copies, *after* the fix pass: `HEAD` fails 4/18 and the
fixed tree 4/18, so the load sensitivity predates this work. It did not reproduce with the suite
run alone. The mechanism visible in the failing shard is a take whose connection closed mid-run
and whose recovery found no snapshot — the child process is still alive — which is worth its own
investigation rather than a fix-by-guess.

**New follow-ups, filed for the next release** (the "coverage for what the recorder cannot
observe" epic): harvesting a short-lived child's exit snapshot, tracking reads inside a service
process, and a policy for tests whose behaviour depends on their neighbours.
