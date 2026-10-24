# Changelog

All packages share a version. Dates are release dates; the working tree is `unreleased`
until a tag is pushed and the publish workflow runs.

## Unreleased

- **Diff parsing matches real path names.** git appends a TAB to a `---`/`+++` line when the
  path contains a space, and the parser kept it: with an `include` of `src/**/*.ts` a change to
  `src/my file.ts` matched no glob and was dropped as out of scope. The `diff --git` header is
  now split where both sides agree, so a path containing `" b/"` is no longer cut in the middle.
  Untracked names from `ls-files -z` are no longer trimmed, which rewrote a name whose last byte
  is a space.
- **A killed run no longer poisons later builds.** The default `cbd build` parses every shard
  under the state directory, and a footerless shard from another commit failed the build before
  the commit filter could skip it. The header's commit is read from the first line first; a
  shard for another commit is skipped, and one for *this* commit is still refused.
- **The collector stops inheriting another run's state.** An exported `CBD_SELECTION` no longer
  narrows a `--no-select` or "run everything" collect — reproduced as a 2-test suite recording
  one test and rewriting the map. `--shard` must name a `.ndjson` file, because that extension
  is how `cbd build` finds shards; the previous silent outcome was a valid shard nobody built.
  An inherited `CBD_INSPECT` now goes through the same target and collector-lock checks as
  `--target`.
- **Request ids reach ESM named imports; the hello names its header.** `Correlator.install`
  patched the default export of `node:http`, so `import { request } from 'node:http'` kept
  calling the original and its requests were attributed by time (measured). It now syncs the
  builtin ESM exports on install and on release. The instrument's hello reports the header it
  is correlating for, and the collector skips its `correlate` op only when the names match —
  a bare `correlating: true` was read as agreement to whatever the collector asked for.
- **Lost evidence reaches the shard's health record.** `rescanningSocketSource` reported no
  `generatedMissing` and swallowed a dead target's lost window without counting it, so a shard
  with missing generated text or a lost window looked clean and the map never became partial or
  unhealthy. It now forwards nested ids in the shard's pid namespace, and a new optional
  `Source.lostTakes()` carries per-target losses the recorder has no rejection left to count.
  `inProcessSource` reports missing generated text too, a socket it gives up on is announced
  once on stderr, and Node's empty-string `sourceMapURL` ("no map") is no longer read as a map —
  which had marked plain scripts' files partial whenever their text could not be fetched.
- **Titles containing ` > ` are matched, not skipped.** node:test and Jest translate CBD titles
  into the runner's name space by splitting on ` > `, which cannot tell a separator from literal
  text; a selected test whose title contained one was filtered out and silently never ran. The
  shared `titlePartReadings` admits every reading, which can only over-select.
- **A window left open says what happened.** node:test and Vitest refused the *next* test as
  "running concurrently" when a consumer `afterEach` had thrown and stopped the hook chain
  before the adapter's own hook. The run is still refused (the boundary is lost either way), but
  the message names both causes.
- **Mutation selection follows select's safety ladder.** It ignored `partial`/`unhealthy` (now
  `all`), `opaque`/`reads`/`dirReads` (now added to every subset), and counted the whole-file
  `<module>` entry as a function, so a top-level mutant answered with its importer alone instead
  of the file-wide set.
- **Robustness batch.** `select` warns when no change matched any recorded touch (a clean
  `verify` with `checked: 0` was indistinguishable from a pass), a library `select` honours the
  map's own `dirty`, `gc` tolerates entries that vanish mid-prune, `collect` removes its
  selection file on every exit including a failed build, paths that do not exist yet are
  canonicalized through their nearest existing ancestor (so a later creation still matches a
  symlinked root), Vitest honours `CBD_SELECTION` without `CBD_SHARD`, japa closes its sources
  even when a drain rejects, and a recorder step that throws inside an unawaited lifecycle hook
  is reported rather than becoming an unhandled rejection. `CBD_SNAPSHOT_MS` above the timer
  limit is clamped instead of wrapping to a 1 ms interval, and a second `runStart` on one
  Recorder starts from zero.
- **Attaching to a target that has just started waits for its pid.** A process attached to on its
  `Debugger listening` line answers `Runtime.evaluate('process.pid')` with `undefined` until its
  bootstrap installs the global — not with an error — so the source refused an attach that was
  perfectly valid, which is the ordinary case for a service someone has just brought up. It now
  repeats the question until the pid arrives or the caller's timeout expires, and the refusal it
  can still make names both readings: still starting, or not a Node process.
- **`cbd collect --target` attaches.** `inspectorSource` had no caller outside tests, so a run
  against a service whose environment cannot carry the instrument could not be asked for. The
  flag takes a `ws://` debugger URL, `host:port`, or a bare port (`--allow-remote` for a
  non-loopback one), refuses a target another collector already holds, and hands the value to the
  test command in `CBD_INSPECT` (`CBD_INSPECT_ALLOW_REMOTE` with the flag). The japa plugin opens
  the service recorder from it through the same shard, pid and `role: 'service'` path it uses for a
  socket directory, and refuses both variables set at once. A target that cannot be read is a
  usage error; a held target is one `cbd:` line with exit 1, checked before the suite starts
  rather than surfacing as a runner stack trace.
- **`inspectorSource` attaches.** The CDP client behind the fallback source is built:
  it discovers a target through `/json/list` (or takes a `ws://` URL directly),
  opens one WebSocket, enables the `Profiler` and `Debugger` domains, and serves
  `take()`, `scripts()`, `generated()` and `prepare()` over the existing contract.
  It is a `QueuedSource`, so the `Recorder` can drive it: `dispatch()` sends a
  boundary in the tick it is called and its handle resolves in dispatch order, and
  `drift()` reports the round-trip each boundary cost. The target's own pid is read
  over CDP (`Runtime.evaluate`), because a shard header that named the collector
  instead would credit the service's execution to the wrong process.
  It refuses a target another collector holds, through a lock keyed by the target
  origin in the OS temp directory; a lock whose owning pid is gone is reclaimed.
  The `/json/list` reply is data from the target, so its debugger URL goes through
  the same loopback rule as a caller-supplied one. Coverage begins at the attach,
  so a process's start-up is outside the first window. This needs the global
  `WebSocket`, so the minimum Node version is now 22 (`engines` bumped).
- **Snapshot recovery is scoped to one run.** Take ids restart at 1 per client and
  a snapshot window was accepted on its take id or boundary timestamp alone, so a
  later run could substitute an earlier run's execution for a lost window and skip
  the loss report. A source now names a run session in the hello, the instrument
  tags every window with the session that produced it, and recovery only accepts a
  window carrying this run's session. Windows whose collector connection has closed
  are dropped from later snapshots, and `close` clears the unacked state. Two
  collectors against one service no longer share take numbers or acknowledgements.
  An older instrument does not echo the session, and then a lost window is reported
  as a loss instead of being recovered.
- **A failed generated-text fetch makes the affected file partial.** When the
  end-of-run `generated` request could not produce a transformed script's text, the
  build indexed the file on disk as if V8 had compiled it, so offsets converted
  against the wrong bytes. The generated reply now names the script ids it could
  not produce, the recorder writes a `health` record before the footer, and the
  build marks a missing script's file partial when that file has a source map
  (carried on the row, declared, or beside it). A script with no map is its own
  source and still falls back to disk. Shards without a health record keep the old
  behaviour.
- **A window that could not be taken makes the map unhealthy.** A throwing
  `takeSync` or a queued reply lost with no snapshot substituted an empty capture,
  and the shard still looked well-formed. The recorder counts failed takes into the
  same `health` record, the build writes `CoverageMap.unhealthy`, and `select` runs
  everything for an in-scope change. `cbd stats` reports the reasons. An empty
  window could have covered any file, so this is a map-level flag rather than a
  path-level `partial`.
- **`verify` accepts identity-aware ground truth.** Title-keyed ground truth kept
  the first match, so a duplicate title in another file or ordinal could hide a
  miss. `verify` now also accepts `{ id?, file, title, ordinal?, touches }[]`,
  matching the map's identity exactly. Title-keyed input is still supported: when a
  title is duplicated, every matching test is required and the verification warns,
  so a bare title over-reports rather than masking a miss.

- **Map test ids are stored relative to the map's root.** A test's id is
  `<file>::<title>`, but only `file` was made relative when the map was saved; the
  id kept the absolute path of the checkout that recorded it. A map copied to
  another worktree, sandbox or CI checkout therefore carried ids naming the
  recording machine. `saveMap` now rewrites the id with the same relative path it
  stores the file under, and `loadMap` resolves it back, so in-memory ids are
  unchanged and the stored map is portable. Matching on file and title, as
  grizzly does, was unaffected; printing or comparing ids was not.
- **A config change names only the config file.** A range-wide `configChanged`
  flag forced all and labeled every changed file `config-changed`, skipping their
  own reasons. It now forces all once, names the config, and leaves the other
  changed files their normal diagnosis. A config change reported only by a base
  leg still produces the single reason naming the config.
- **Body-skipped `node:test` tests are recorded on Node 22.** Node 22 does not
  call `afterEach` for a test whose body calls `t.skip()`. The window stayed open,
  so a following test looked concurrent and refused the file, and a skipped last
  test vanished from the shard. The adapter closes that window at the next
  `beforeEach` or at the file's `after`, and refuses the shard if a non-skipped
  window is still open when the file ends. Node 24 was unaffected.
- **A failed instrument says so.** The injected instrument used to swallow a failed inspector attach,
  a failed profiler start, or a socket it could not bind or open. A lane server then started normally,
  the tests passed, and the map looked complete while carrying no server-side coverage — measured with
  a 116-byte socket path past macOS's 104-byte limit. Node 22 can even report a successful bind for
  such a path and create the socket somewhere else, so the instrument now also checks that the file
  the collector will open exists. The failure is a warning naming the socket or the error and saying
  the process records no coverage. It still does not keep the host alive or stop it from starting, and
  a successful instrument writes nothing.
- **Empty CBD variables mean unset.** `CBD_SHARD=""` is no longer opened as a path by the japa
  plugin, the mocha adapter, or this repository's test entries; an empty `CBD_COMMIT` records
  `unknown`, and an empty `CBD_SELECTION` is no selection. A consumer can pass the variables
  through without the 0.0.1-era workaround of unsetting them.
- **`cbd stats` says how fresh the map is.** It lists the test directories the map covers with their
  test counts, counts the in-scope files changed since the map's commit, and names the changed files
  the map has never seen — the ones a selection must answer with `all`. The JSON result carries the
  same fields as `suites` and `changed`.
- **Per-suite selection files.** `select --emit-selection-dir <dir> --suite <name>=<glob,...>`
  (repeatable) writes a v2 selection per suite, omits a suite with no selected tests, and removes
  that suite's stale file. Selected tests that match no suite go to `_other.json`, so the union of
  the files is the unsplit answer. A mode-all or empty answer removes every file the command
  manages. A consumer that splits one selection by suite no longer has to.
- **Non-JS inputs are declared feeds.** No new key: an `alwaysSelect` entry with a `when` glob and
  a bare test-file locator selects every test the map knows in that file, including when a file is
  added under a listed directory. The SQL-migration shape is documented, and a test covers an
  added migration outside `include` selecting the declared suite. Reads at spec load and directory
  listings remain observed; an input no recorded process opened needs this declaration.
- **`cbd flaky` reads the maps' history.** It compares adjacent maps in recording order and reports
  a test whose status flips only when neither map's touched files nor the test's own file changed
  between their commits. The report names the two commits and statuses, and tests added or removed
  between maps are not compared. It reports; it does not quarantine.
- **Selection and diff-input fixes.** Git-quoted paths (non-ASCII names) are decoded instead of
  silently ignored; `--no-worktree` diffs from the map commit to HEAD instead of the reverse; a
  load-only helper that defines tests hands off to the load rule rather than selecting nothing;
  incremental carries poison base bucket-only files and propagate a dirty base; directory listings
  survive a file `include` that rejects the directory itself; and module-scope widening reads each
  hunk's own line-count change instead of the file-wide total. Regression tests cover each shape.
- **Collect and map integrity.** Collect detects derived per-file and service shards, plus a
  same-path rerun that recorded fewer bytes, using a size+mtime stamp scoped to the run's stem; it
  writes a per-run selection file. A new recording truncates its shard, and a shard with two
  headers is refused. Map writes are atomic. Declared reads are realpath-canonicalized, an explicit
  `--root` is canonicalized, and an empty or escaping `stateDir` is rejected before `gc` can touch
  the repository.
- **Adapter and config surface fixes.** Jest reads the v2 selection both writers emit; a value flag
  refuses a following flag instead of swallowing it; globs accept brace alternatives, character
  classes, and either path separator; an empty `include`/`exclude` is rejected rather than matching
  nothing; empty projection/relocation environment values are unset; `serviceShardPath` recognizes
  Windows separators; and per-suite output sweeps a suite that disappeared from the invocation via
  a manifest.
- **Correlation correctness.** The patched `fetch` preserves a `Request`'s headers; the
  `http.request(url, undefined, callback)` overload keeps its callback; correlated request coverage
  carries the owner's ordinal and is merged into the owner's real test entry instead of inventing a
  passing one; and the collector refuses an instrument whose wire protocol differs instead of
  misreading it.
- **Verification and history.** `verify` reads the new-side hunks and insertion points its ground
  truth is recorded in; `stats` survives maps larger than the argument limit; and `flaky` treats a
  changed read or listed directory, and any opaque dependency, as a relevant change, so a
  fixture-driven flip is not called flaky.
- **An empty recovered window is acknowledged.** A snapshot window that matched a take but carried
  no coverage was treated as missing: its script rows were dropped and the snapshot kept offering
  it. It is now returned, absorbed and acknowledged; only a window with no match and no fallback
  reports a loss.

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
- **Stale shards are diagnosed, not guessed.** Each script row carries a SHA-256
  of the bytes it was recorded against. When a suite rebuilds its own output, a
  changed mtime with identical content is accepted; a real byte change is still
  refused. `cbd collect` builds only the shards this run wrote — including the
  per-test-file and service shards — so an older shard for the same commit cannot
  poison the rebuild.
- **Changelogs ship.** Every published package generates `CHANGELOG.md` from the
  repository changelog in a `prepack` step and includes it in its tarball.
- **`cbd explain … | head` exits quietly.** A reader that closes the pipe early
  raised an unhandled `EPIPE` and printed a stack trace; the bin now treats it as
  a normal end of output.
- **Incremental recording.** `cbd build --incremental` and `cbd collect
  --incremental` carry a previous map's tests forward when their evidence still
  describes the same bytes. A touched function in a changed file is carried when its
  line range maps exactly through the diff; reads and directory listings are
  path-level and survive a change. Anything the change overlaps is marked `partial`
  — a later change to one runs everything. The marker survives a chain of incremental
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
- **A load-touched file with a read answer still selects its loaders.** A re-export
  barrel has a load touch but no function index; a change to it selected only the
  tests that read it as data and skipped the load observers, so removing an export
  could leave every other test that imported the module unselected. The load answer
  now runs alongside the read answer and unions the two; deleting a load-touched
  module gets the same treatment. Maps without `loadShards` still fall back to
  `mode: all`.
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
