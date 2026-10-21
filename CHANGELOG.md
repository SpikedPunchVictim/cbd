# Changelog

All packages share a version. Dates are release dates; the working tree is `unreleased`
until a tag is pushed and the publish workflow runs.

## 0.0.4 — 2026-10-20

- **Reads are recorded.** The adapters wrap the test process's public
  `node:fs` / `node:fs/promises` read, stat, existence and directory-listing calls
  and attribute them to the open test window. The shard and map carry `reads` and
  `dirReads`; a change to a read file — or to any file under a listed directory —
  selects the tests that read or listed it, with reason `read`. Named ESM imports
  are covered via `syncBuiltinESMExports`; the recorder's own projection reads are
  suppressed. Reads are kept only for paths under the project root and inside
  `include`, and never under `node_modules`: a shard can record far more than a
  selection diff can ever reach. A read of a build output is also recorded at the
  source its sibling source map names, or at the path the same projection rules
  coverage uses produce, so a change to `src` selects a test that reads `dist`.
  A read made while a spec is importing is kept too: the adapters that know the
  file (Vitest, Jest) attribute it to the tests in that spec, and the others
  (japa, mocha, node:test, whose process imports several files) attribute it to
  every test in the shard.
  Reads through a captured reference before install,
  native addons, child processes, or a separately started service are not seen;
  `alwaysSelect` remains the escape hatch.
- **Spawned processes are dependencies.** The adapters wrap the test process's
  public `node:child_process` spawn, exec and fork calls and note an opaque
  dependency while a test window is open, so a test that runs a tool or starts a
  service is selected by any in-scope change instead of being silently omitted.
  Only the call is seen; what the child does is not. `CBD_TRACK_PROCESSES=0`
  disables the wrapper for tests that spawn something harmless.
- **`unknownPolicyFor`.** Per-glob overrides for a file the map has
  never seen, e.g. `[{ "paths": ["typescript/tools/**"], "policy": "ignore" }]`.
  The first matching entry wins, only `all`/`ignore` are accepted, a known file is
  unaffected, an ignored unknown file appears in `selection.ignored` with the
  matching entry named, and an entry whose globs match no file in the repository
  warns. A map without the new fields selects exactly as before.
- **Dogfooding.** `CBD_INCLUDE_SELF=1` lifts the self-root floor so a
  repository that records its own suites gets its `src` in the map instead of a
  map of test files. This repository now does exactly that: `cbd.config.json` at
  the root, the japa adapter in every package's runner (loaded only when
  recording or selecting), and `pnpm dogfood:record` / `pnpm dogfood:select`.
- **Adapter contract.** Tests have a runner-neutral id (`file::title`) in the map,
  the JSON answer and the selection file, which is now v2
  (`{ "version": 2, "tests": [...] }`); v1 title-only files are still read. Test
  helpers can declare facts coverage cannot see: `recordRead`, `recordDirRead`,
  `recordDependency` and `recordOpaque` are exported from `@spikedpunch/cbd`, and
  an opaque declaration selects the test on any in-scope change. The map now keeps
  each test's status and duration. `ADAPTER_CONTRACT_VERSION` is exported; the
  contract is window-based rather than `AsyncLocalStorage`-based, for the reason
  recorded in ADR-0017. An adapter whose runner overlaps test windows declines to
  record: `cbd-vitest`, `cbd-jest` and `cbd-node-test` refuse a concurrent run and
  leave the shard incomplete, rather than charging one test's coverage to another.
- **`cbd collect` accuracy.** A command that dies before the adapter records now
  reports "no tests ran; nothing recorded" instead of naming a shard that was
  never written, skips the build, and no longer prints a doubled `cbd: cbd:`
  prefix.
- **Changelogs ship.** Every published package generates `CHANGELOG.md` from the
  repository changelog in a `prepack` step and includes it in its tarball.
- **`cbd explain … | head` exits quietly.** A reader that closes the pipe early
  raised an unhandled `EPIPE` and printed a stack trace; the bin now treats it as
  a normal end of output.
- **Incremental recording.** `cbd build --incremental` and `cbd collect
  --incremental` carry a previous map's tests forward when every file they used is
  unchanged, and mark files whose evidence could not be carried as `partial` — a
  later change to one runs everything. The marker survives a chain of incremental
  builds, and a dropped test that declared an opaque dependency keeps that
  declaration (with no stale evidence attached), so an invisible dependency is
  never lost to a carry. Buckets and per-shard load attribution are
  not carried, so a module-scope change in a load-reached file also escalates.
- **Shared maps.** The `mapsDir` config key moves per-commit maps out of
  `<stateDir>/maps`; an absolute path lets worktrees and review sandboxes share one
  set while shards and the selection file stay local.
- **Read-only what-if selection.** `select --patch <file.diff>` and
  `select --change <path>:<start>[-<end>]` answer a prospective edit without
  touching the tree, through the same diff reader `--since` uses. A patch whose
  paths all fall outside `include` warns and names the path base: a diff made at
  the repository top level resolves one level too deep under a nested `--root`.
- **Batch reaches.** `reaches --batch <rows.json>` answers neutral mutant rows
  (`{file, lines}` or `{file, find}`, optional `killers`) with the tests that reach
  each and whether each named killer is among them.
- **One answer for a base ref.** `select --since <base>` now unions the named base's
  diff with the map commit's, instead of asking a consumer to call twice and merge.
  A base older than the map is read at the map commit's line numbers, so a function
  whose lines moved in between is found where the map recorded it. Answers can
  therefore differ from 0.0.3: tests that old-line matching missed are now selected,
  and a test selected only because a base line number happened to land on some
  function is not.
- **Cost, in one place.** Test status and duration are kept on the map; `select`
  reports the subset's recorded milliseconds against the whole map.
- **`--order impact`.** `select` can order the subset by how directly the change
  reaches each test — changed function, module scope, read, changed test file,
  opaque declaration, `alwaysSelect` — without changing the set, so a runner that
  follows the order fails on the closest cause first.
- **`--format summary`.** Mode, selected of total, reason counts, warnings, ignored
  files, map age and estimate in a few lines.
- **Capabilities and `--emit-selection`.** `cbd --version --format json` lists
  `adapterContract` and the supported features; `select --emit-selection <path>`
  writes the v2 file adapters read and removes a stale one when the answer is all
  or empty.

## 0.0.3 — 2026-10-21

Round-2 feedback from grizzly-sv T-29-015.

- **A straddling hunk now widens.** `functionsHit` classified a hunk only by whether it
  intersected a function, so a hunk containing module scope and a function's first
  line selected just that function's tests and could omit a test that compares a
  module-scope binding. A hunk is now checked for coverage: any changed line
  outside every function sets the file-level answer as well. A line-count-changing
  hunk that contains a function's first line also widens, because the new-side
  coordinates can move module scope; the module body's whole-file V8 entry is
  excluded from the coverage check while its tests still count as observers.
- **The root no longer comes from `cwd`.** The CLI uses the nearest directory upward
  with a `cbd.config.json` **within the git top level**, else the git top level, else
  (outside git) the nearest config or the working directory. A config above the
  repository cannot capture a nested repository. Roots are canonical, so a symlinked
  `tmpdir` does not split the config globs from the changed paths. `--root` still
  overrides.
- **A changed config forces all.** A change to the loaded config file is checked
  before `include` and produces `all` with reason `config-changed`; it is no longer
  listed as merely ignored. Real-path comparison covers a symlinked or
  differently-cased config, and a config outside `--root` is checked with a targeted
  git query.
- **`cbd --version`.** Prints the CLI and core versions and exits 0; the select JSON
  answer carries `cbdVersion`. The shipped bin answers before importing the CLI and
  core, so a broken or partial install can still report its version, and neither
  `--version` nor `--help` spawns git.
- Follow-ups filed: recording file reads as touches (a spike with a stated soundness
  boundary) and per-glob `unknownPolicy` or `file-importers`.

## 0.0.2 — 2026-10-20

Fixes from grizzly-sv T-29-015, all in the selection path. No API was removed; a map
recorded before this release still loads, with the safe fallback described below.

### Selection correctness

- **Untracked files are changes.** `git diff` never lists them, so a new file under
  `include` was invisible and `select` could answer with no tests while the suite was
  broken. Worktree-mode selection now reads `git ls-files --others --exclude-standard`
  and treats each as an addition; `--no-worktree` still asks about a commit only.
- **Module-scope changes select the process that loaded the module.** A test can compare
  a top-level binding without calling a function in the file, so the function index left
  it out. The map now records `shardTests` (the tests that can observe a shard's
  module state) and `loadShards` (per file, the shards that evaluated it), and a hunk
  outside every function selects those tests plus the function index's. A shard marked
  `role: 'service'` attributes load only to the tests that actually touched the
  service. Maps without the fields fall back to `mode: all`.
- **Helpers that define tests are test files.** A helper whose `test(...)` calls are made
  through a function a spec invokes is now detected by a static registration scan, so
  `testFilePolicy` applies and its added-test warning fires. Under `known` it selects the
  tests that executed code in the helper.
- **`alwaysSelect`.** New `cbd.config.json` key for tests that read sources as text and can
  never appear in coverage. Entries are `{ "tests": ["file" or "file > title"], "when":
  ["glob"]? }`, are added with reason `always`, and an unresolved entry forces `mode: all`
  with a warning. Malformed entries are rejected by the loader and the schema.
- **Maps are portable.** Paths are stored relative to the map's root and resolved on load,
  so a map recorded in one worktree gives the same answer in another checkout of the same
  commit. Absolute paths outside the root stay absolute.
- **Ignored changes are visible.** `Selection.ignored` names changed files outside
  `include` that no rule claimed (`alwaysAll` and `alwaysSelect.when` can still claim one).

### Docs

- CBD.md §8.2–§8.5 and the README describe the new rules, `alwaysSelect`, `ignored`, and
  the portable map format.
- `cbd.config.schema.json` accepts `alwaysSelect`.
