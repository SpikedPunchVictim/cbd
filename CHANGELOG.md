# Changelog

All packages share a version. Dates are release dates; the working tree is `unreleased`
until a tag is pushed and the publish workflow runs.

## Unreleased

- **A very large line from an instrumented process no longer stalls the collector.** The line
  splitter searched the whole buffered text again for every chunk, so one huge reply took time
  quadratic in its size (100 MB took 15 s, longer than the take timeout). Each chunk is now searched
  once.
- **A stale or unparseable exit snapshot is no longer re-read.** An unparseable snapshot was read
  again every 25 ms, and a file left in the socket directory by an earlier run was parsed on every
  run. A snapshot is now judged once per mtime, and one last written before the recording began is
  not credited to it, which also covers a leftover from before a reboot whose monotonic start time
  can look newer than this run.
- **The instrument's own look for a declared source map is no longer reported as a read.** It
  opened each script's file through the tracked `fs`, so every compiled file counted as a
  dependency of the tests that ran against the service and over-selected.
- **`cbd flaky` can now report a flip to a failure.** A map holds only green tests, so a test that
  failed was absent rather than failed and no pair of maps ever disagreed. A build now records each
  failed test by identity in a `nonGreen` list, which selection never reads and which adds no
  touches, and `flaky` compares it with the neighbouring map's green entry.
- **`select --change <path>:<line>` reads a relative path against `--root`**, as `--patch` and
  `explain` do, instead of against the working directory. From a subdirectory the same spelling
  named two different files.
- **mocha and japa record a spec reached through a symlink under its real path.** The map's keys are
  real paths and the other adapters already resolved the runner's spelling, so such a spec was
  recorded under a name selection never matched.
- **Building a map from thousands of tests that share functions is linear.** Each test added to a
  function scanned the tests already listed on it, so 8,000 tests over 200 shared functions took
  1.5 s and each doubling quadrupled it.
- **A socket path written off as stale is attached again when a new process binds it.** A
  `pid-N.sock` that failed twice was ignored for the rest of the run, so a later process that reused
  pid N was never read and its coverage was missing. The verdict now belongs to the file it judged:
  a different file under the same name starts over.
- **A dead process found through its stale socket is no longer dropped from the window.** The
  lifetime recovered from its exit snapshot arrived after the boundary had gathered its parts, and
  was lost whenever the snapshot scan had already skipped the file. It now lands in the window that
  found it.
- **A take on a socket whose service has gone fails at once.** It waited out the whole reply
  timeout, ten seconds by default, for an answer that could not come.
- **A mocha or Jest run whose selection runs no test now fails.** A selection naming titles the
  suite no longer has ended green having run nothing. Mocha exits 1 with a message, and
  `withCbd` adds a reporter that fails Jest the same way. Vitest and `node:test` do not check yet,
  because they have no run-level hook.
- **`mocha --parallel` with a recording warns that the shard will be empty.** The tests run in worker
  processes the recorder does not reach, so the shard was valid and empty with no sign of why.
- **A function's first line edited without changing the line count now widens.** Only an edit that
  changed the line count widened, so dropping `export` from `export function f() {` selected `f`'s
  tests alone and missed a test that reads the export. Any hunk containing a function's first line is
  now also answered at module scope. An edit inside the body, and an insertion after the first line,
  stay precise.
- **A change to a tsconfig now withdraws `emitCheck` for the entries it configures.** Both versions of
  a file are compiled under the tsconfig as it is now, so editing `target` or `verbatimModuleSyntax`
  in the range let a type-only edit be proved unchanged while the base had been emitted differently.
  A change to the entry's tsconfig, to a local file it extends, or to any `tsconfig*.json` or
  `jsconfig*.json` now gives no verdict and warns, and selection escalates as without the opt-in.
- **A script a loader transformed, with no source map, is no longer projected onto its file when the
  transform moved lines.** The generated text's lines are not the file's, so projecting them could
  place a function on the wrong lines and under-select. Such a script is now unresolvable: its file
  does not enter the map and a change to it escalates through the unknown-file rule. A transform that
  kept every line where it was (a loader that only appends a trailer) and an untransformed script
  with no map still project.
- **A `%` in a map's source path, or a malformed `data:` source map, no longer aborts the build.** A
  source such as `./100%zz.ts`, or a `data:` URL with a bad percent escape, threw a `URIError` out of
  `cbd build`. The source, or the script, is now unresolvable instead.
- **`http.request` with array `headers` keeps working inside a correlation window.** The recorder
  appended a `name: value` string to the array, which made a flat `[name, value, ...]` list invalid
  and put a junk entry in a `[[name, value], ...]` list. It now appends in the form the array uses,
  and recognises an id already present in either form.
- **`cbd build --partial` now accepts a shard whose last line was cut off.** A killed run is torn
  mid-record, and the torn final line was refused as invalid JSON, so the flag meant for that run
  still failed. The unreadable last line is dropped under `--partial`; a bad line anywhere else, or
  any bad line without the flag, is still refused.
- **A child spawned at import, or by a hook between tests, now leaves its opaque mark.** The process
  tracker's opaque note and a declared environment variable were kept only inside a test window, so
  a spec that spawned a server at import or in a `beforeAll` lost them and was not widened. They now
  fall back to the spec's import scope, then to the between-tests scope (the whole shard).
  `new Worker(...)` from `worker_threads` and `cluster.fork()` are marked opaque like a spawn.
- **A relative `CBD_SOCKET_DIR` now names one directory for every process.** It was resolved against
  each process's own working directory, so a child with another cwd listened elsewhere and was never
  collected. The instrument, the socket and rescan sources and the japa and vitest adapters now
  resolve it to an absolute path on first read and write that back to the environment.
- **An incremental build from a map recorded on a dirty tree no longer trusts evidence for files
  that were dirty then.** The map now records which files differed from the commit (`dirtyFiles`).
  A file that was edited at that recording, is not re-recorded by the new run, and has since been
  reverted or changed is marked partial, so a later change to it runs everything instead of
  selecting tests by line ranges from the old edit. A dirty map without the list is treated as if
  every file it saw was dirty. The carried tests are kept.
- **A narrowed `cbd collect` no longer replaces the map with just the tests that ran.** A run that
  selected a subset now builds incrementally from the map the selection read, so the skipped tests
  stay in the map and later selections still see them. `--incremental` with `--base` naming the
  commit being built carries from that commit's own map instead of ignoring `--base`.
- **A failing test run no longer overwrites the map.** When the test command exits non-zero,
  `collect` builds nothing, prints a warning and keeps the exit status; the failed tests are not
  recorded as passing, so a map built from that run would stop selecting them.
- **A failed `select` no longer leaves the previous `--emit-selection` or `--emit-selection-dir`
  files in place.** The managed files are removed before the error is raised, so a runner that
  ignores the exit code cannot run the previous run's subset.
- **A file with a lone `\r`, U+2028 or U+2029 no longer gets a wrong binding-read narrowing.**
  TypeScript breaks lines on those characters while git and the map break on `\n` only, so a hunk
  after one landed on the wrong statement and a side-effecting module-scope edit could be proved a
  pure const edit with no readers. `emitCheck` now gives no binding-read verdict for such a file and
  escalates as before. CRLF files are unaffected.
- **A file named `..something` under a listed or partial directory is no longer treated as outside
  it.** The containment checks read any relative path starting with `..` as an escape, so
  `dir/..hidden.ts` was dropped from the directory's coverage in `select`, and the same idiom
  misjudged paths in config, the CLI, `mutate`, the map and the japa narrowing. They now treat only
  `..` itself or `../` as leaving the directory.
- **A jest or node:test title with nine or more ` > ` separators can match again.** Past the reading
  cap the title was offered only as its split parts, never as the single stored title a runner may
  report; both readings are now offered.

- **`cbd gc` no longer deletes directories that are not maps.** Every directory under the maps
  directory was a prune candidate, so `"mapsDir": "."` with `cbd gc --keep 1` removed `src/`, `docs/`
  and `tests/`. `gc` now prunes only directories named like a full commit id that contain a
  `map.json`, and `cbd.config.json` rejects a `mapsDir` that is the repository root or a parent of it.
- **`cbd gc --keep` keeps a whole run.** Jest, Vitest and node:test write one shard per test file, and
  `--keep 10` counted files, so it deleted most of the newest run and the next `build` silently missed
  those tests. Shards are now grouped by run (the name up to the first dot) and kept or removed
  together, aged by the newest file in the group.
- **`strict: true` in `cbd.config.json` now takes effect for `cbd select`.** The CLI always passed
  `strict: false` when `--strict` was absent, overriding the config. The flag now overrides the config
  only when given; `--no-strict` turns a configured `strict` off.

- **`changesSince` ignores the user's diff configuration and `+++`/`---` body lines.** `diff.mnemonicPrefix`,
  `diff.srcPrefix`/`diff.dstPrefix` and `diff.<driver>.textconv` made the parsed paths keep a `c/`/`w/`
  prefix or the hunks come from converted text, so the change matched no include glob and its tests were
  not selected; the diff now pins `a/`/`b/` and `--no-textconv`. An added line `++ x` (printed `+++ x`) or
  a removed line `-- x` (printed `--- x`) was read as a file header and renamed the file; headers are only
  read before a file's first hunk. A quoted path containing a character outside the BMP (an emoji) is
  decoded whole instead of being replaced by U+FFFD.
- **A file renamed out of `include` still selects the old path's tests.** `git mv src/a.ts archive/a.ts`
  dropped the change at the scope filter because the new path is outside `include`, before `select`
  could treat the old path as a deletion; the change is now kept when either path is in scope.
- **`select --change` and `explain` no longer let `emitCheck` drop tests for a what-if.** A `--change`
  or `--patch` edits no file, so `emitCheck` compared a file with itself, found its module scope
  unchanged, and the `module-scope-unchanged` verdict suppressed the load-observer escalation: on the
  originating project `select --change driver.ts:99` chose 195 tests and left out the one that kills
  the mutant, against 2,630 without `emitCheck`. A caller-supplied change has no new text, so
  `emitCheck` now gives it no verdict (neither `module-scope-unchanged` nor `binding-read`) and selection
  escalates as it would without the opt-in.

- **`cbd explain <file>:<line>` reports what `select --change` would run for that line.** On a
  module-scope line explain listed only the tests that touched the file ("123 tests, outside every
  function: the whole file's tests") while select added every test of every shard that loaded the
  file, 2,628 on the originating project. Explain now runs the same selection for the line and prints
  `select would run N tests:` with each reason and its count (load observers, reads, opaque
  dependencies, `alwaysSelect`, `emitCheck`); `--format json` and `Cbd.explain` carry it as
  `selection`. A function line that select answers with the listed tests prints as before.

- **A load-observer reason names the shards that loaded the file.** `select` and `explain` printed
  the tests of every shard that loaded a module as `driver.ts (2628 tests)`, the same shape as the
  tests that touched the file, often beside `driver.ts (read by 8 tests)`. It now reads
  `driver.ts (loaded by 11 shards: 2628 tests)`, and the JSON reason carries `shards`.

- **`emitCheck` narrows an edit to a pure initializer that only functions read.** A module-scope hunk
  selected every load observer, so changing `const UNSTORABLE = /…/` (not exported, read inside one
  function) selected 2,630 tests of a 3,734-test suite. When the project's own `typescript`, resolved
  and pinned as `emitCheck` already does, proves that the hunks lie in the initializer of one
  unexported top-level variable, that the old and new initializers are side-effect free and cannot
  throw (literals, regular expressions, primitive templates, array and object literals, a few operators,
  earlier pure `const`s), and that no reference sits outside a function body (names are bound by
  symbol, so a shadowing parameter does not count), selection takes only the tests that ran a function
  containing a reference. The reason is `binding-read`, naming the binding; a reader that ran at load
  keeps the load rule. Anything unproven escalates as before. On the originating project's map the same edit
  selects 236 tests (8 read, 41 binding-read, 190 opaque) instead of 2,630, with the killer kept.

## 0.0.5 — 2026-10-26

- **A read shared by a whole shard is stored once in the map.** An import-phase read that a
  one-process suite cannot pin to a spec belongs to every test in the shard, and the map listed every
  test under every such file: on VS Code's `vs/platform` with no `include` that was 158 MB of a
  225 MB map. The map now holds one `readGroups` entry per shard (`tests`, `reads`, `dirReads`) and
  selection unions it with `reads`/`dirReads`, so selections are unchanged: the same build is 67 MB,
  builds in 6.8 s instead of 10.9 s, and selects in 0.5 s instead of 1.4 s. Carrying a map across
  builds renumbers a group and still poisons its files when a member is dropped. The map version is
  now 2: this build reads version 1 maps, and an older build refuses a version 2 map instead of
  under-selecting.
- **`recordRead`, `recordDirRead`, `recordDependency`, `recordEnv` and `recordOpaque` no longer drop
  a call made between tests.** Once the first test had started, a record call from a `beforeAll`,
  `afterEach` or other hook outside a test window reached no recorder and vanished without a word, so
  a change to the declared file or variable under-selected. Such a call, and one made after the last
  test, is now filed against every test in the shard (and `recordOpaque` marks every test opaque):
  it can over-select but no longer loses the dependency. A call made during
  spec import is filed against that spec's tests (or the whole shard when the adapter cannot name
  the file), for all five functions. A call after the run is closed is still ignored.
- **`emitCheck` stops erased TypeScript edits from selecting every test that loaded the file.** On a
  one-process suite the module-scope rule named every test for an edit to an import, interface or
  type alias, although the compiler erases them. The opt-in config key `emitCheck` maps globs to a
  `{ tsconfig, typescript }` pair, where `typescript` is the exact compiler version the tests run
  with (required: a bare tsconfig string is refused). For each modified matching file CBD transpiles
  the base and current version with the project's own `typescript` and that tsconfig, hollows out
  function bodies, and when the rest is identical the hunks outside every mapped function select
  nothing and the output says `module-scope-unchanged` with the compiler version. A resolved version
  that differs from the pin skips the check and adds a warning. It also applies to a file that ran
  only at load, between tests or at teardown (no function in the map), so such a file with an erased
  or never-run-function edit no longer selects every load observer; a hunk inside a function the map
  recorded in one of those buckets keeps its load, between or teardown rule, in a file that has
  function entries too. Function hunks, the unknown-file ladder and added, deleted or renamed files
  are unchanged, and an unresolvable
  `typescript` (including 7.x, which has no JavaScript transpile API), a transpile error or no
  matching glob keeps today's behaviour. The pin cannot vouch for a test runner that transpiles with
  swc or esbuild instead. Enums, namespaces, class static blocks, class field initializers and const enums always
  escalate: TypeScript wraps the first three in functions it synthesizes, and moves field initializers
  into the constructor, so these are not source functions and any edit to one counts as a module-scope change; a const enum's members are inlined
  into importing files by a type-checked emit, so editing one is never "unchanged". No new runtime
  dependency.
- **A config validation error names the file that was loaded.** With `--config /x/bad.json` the
  message named `<root>/cbd.config.json`.
- **Recording no longer breaks tests that `promisify` `exec` or `execFile`.** The process tracker
  replaced `child_process.exec` and `execFile` with plain wrappers, dropping the
  `util.promisify.custom` hook that makes `promisify(execFile)` resolve `{ stdout, stderr }`. Under
  recording such a call resolved a bare string, so `const { stdout } = await execFileAsync(...)` got
  `undefined`; on VS Code's `vs/platform` scope that failed 7 tests that pass unrecorded. The wrappers
  now carry the original's properties and a tracked copy of the hook, so a promisified spawn still
  works and is still recorded as opaque.
- **A japa subset run no longer imports the spec files it did not select.** The title filter is
  applied after japa has imported every spec file, so a subset cost as much as the full run and the
  time a selection saved measured as zero. When the selection names each test's file (the v2 file
  `cbd select --emit-selection` and `cbd collect` write), the plugin now sets japa's `filters.files`
  to those files before the planner imports anything. It narrows nothing, and loads every file as
  before, when any selected test has no file, a file is relative or missing, the selection is the
  older titles-only form, `only` is passed explicitly, or `--files` was already given. The replay
  harness now writes a v2 selection so its subset command is narrowed the same way. A narrowed run
  that ends having started no test (a selected file whose spelling matched nothing japa resolved)
  prints the files to stderr and exits 1 rather than passing with nothing run.
- **Function keys are numbered per build, not per process.** A key such as `<anonymous>@0` was an
  ordinal assigned inside one process, so two shards that executed different arrows of the same file
  both produced `<anonymous>@0`, and the merge unioned them into one function spanning both. A
  module-scope change between them then looked function-interior (under-selection) and unrelated
  changes inside the span over-selected. The same collision occurred when two scripts resolved to one
  source file. `mergeShards` now renumbers every key across all shards from `(file, name, range)`, and
  the within-window union keeps ranges apart. The shard format is unchanged, so existing shards do
  not need re-recording: rebuild the map with `cbd build` from them. Renumbering visits each distinct
  touch array once, so a group recording, where every test of a group shares one array, does not pay
  for it once per test.
- **`carryMap` no longer unions different functions that share a key.** The base and the new run
  were numbered by different builds, so an equal key could name two functions and their ranges were
  widened into one. A carried entry now reuses a key only for the same name and range (using the
  relocated lines) and otherwise takes the next free ordinal. It also reuses the key the new run's
  load, between and teardown buckets give that function, so a change to a carried function that ran
  at load still selects the load observers.
- **`granularity: "group"` records one window per runner group.** One take per test boundary cost
  489% on VS Code's `vs/platform` scope; one per group cut the takes from 32,039 to 1,226 and the
  overhead to about 47%. Every test in a group carries the group's union, so a group run
  over-selects within the group. There is no `@between` window between groups: hook and late async
  work is charged to the next group's tests. `cbd collect` passes the setting in
  `CBD_GRANULARITY`. The japa adapter and mocha's `auto` entry end groups; jest, Vitest and
  `node:test` warn and record per test. Shards are now version 3 (a `group` record was added), and
  0.0.4 refuses them rather than misreading them. This version still reads version 2 shards, so
  existing recordings keep building.
- **A changed function that ran at load selects its file's load observers.** A function that also
  executed during import may have computed a value later tests consume, so the tests that called it
  again were not the only ones that could observe the change. It now adds the load observers (all
  tests, for a map without per-shard attribution). Teardown is excluded.
- **An unseen code file escalates even when a read answered it.** A `.ts`/`.js` (and variants) file
  the map never saw, under a listed directory or read exactly, selected only its readers. Coverage
  missing a code file means the recording was incomplete, so it now reaches the unknown-file rule and
  `unknownPolicy`/`unknownPolicyFor` decide; non-code files (fixtures, schemas) keep their read
  answer. Code imported by the japa runner entry before the plugin installs is such a case: safe, but
  every change to it runs everything unless the new `register` preload (next entry) records it.
- **A japa preload records code imported before the plugin installs.** The plugin starts recording
  inside `configure`, so a shared test-kit or config module the runner entry imports above it ran
  unrecorded, was unknown to the map, and ran everything whenever it changed.
  `NODE_OPTIONS="--import @spikedpunch/cbd-japa/register"` starts recording before the entry's
  imports run; the `cbd()` plugin then joins that session instead of starting a second, and the
  early execution lands in `@load`. It is inert without `CBD_SHARD`, and a plugin-only setup behaves
  as before.
- **A declared environment variable selects the tests that read it.** A test that branches on
  `process.env.FLAG` has no file edge, so a flag flipped in CI or the shell left the selection
  answering for the old value. `recordEnv('FLAG')` names the variable; the shard and the map keep a
  16-hex hash of the value the recording saw, per test, and never the value; `select` compares the
  current environment against each test's own hashes, selecting that test with reason `env-changed`
  when none matches. Hashes are not pooled across tests, so one test recorded under `FOO=1` cannot
  hide a change from another recorded with `FOO` unset, and a test id recorded under several values
  (a CI matrix) keeps all of them. A call made during a spec's import phase is recorded for that
  spec's tests. A test with no hash for the variable is left alone rather than selected on every
  run, and an undeclared variable stays invisible, which is the same boundary as any unrecorded
  dependency. The hash is unsalted and truncated, so a low-entropy value (`1`, `true`, a region
  name) can be recovered by guessing; do not declare a variable whose value must stay confidential.
- **`sharedState` runs neighbours together.** A subset is not a smaller run when a test depends on
  module state another test mutates — a patched sleep, a seeded clock, a singleton wired in one test
  and read in the next. Coverage cannot see that dependency, so the new `select.sharedState` config
  key declares the files: when a change selects a test that touched a listed file, every test that
  touched it is added, with reason `shared-state`. The expansion repeats to a fixpoint, so a test
  pulled in through one file also pulls in its neighbours on another. A listed file that only ran at
  import (the load bucket) counts as touched by its load observers, and the rule runs after every
  other rule, so tests added by a changed environment variable are expanded too. It is opt-in and
  deliberately not inferred; a
  neighbour closure over every shared module collapses to the full suite, and `cbd verify` remains
  the measurement for what a subset missed.
- **A rename or a deletion is judged by what the old file did.** A renamed file was processed only
  by its new path, so with `unknownPolicy: 'ignore'` (or a matching `unknownPolicyFor`) the tests of
  the old path were never selected; the old path is now also treated as a deletion. A deleted file
  that ran only between test windows now honours `betweenPolicy` like a module-scope edit. Unseen
  `.vue`, `.svelte` and `.astro` files reach the unknown-file rule like other code files.
- **A file the service reads selects the test that drove it.** Read tracking ran only in the test
  process, so a service that read a routing table, a config keyed by line, or a fixture had no edge
  from that file to the tests that drove it — a change to the data did not select them. The
  instrument now installs the same tracker inside the target, drains the paths with each take, and
  the collector writes them into the test record's `reads`/`dirReads` alongside the test process's
  own, attributed to the boundary that closes the window exactly as coverage is. `settleTagged()`
  is now present on every queued source because it carries the reads as well as the correlation
  tags; an older instrument reports none, and the build's include filter still decides what counts.
  Reads a service makes outside any window (its startup config, a file read between tests, at
  teardown) ride the `load`/`between`/`teardown` record and select every test in the shard (a module the
  service's loader read and the shard also has coverage for keeps its function evidence instead); they
  are persisted with the unacknowledged window and the exit snapshot, so a lost reply, snapshot
  recovery and the exit harvest return them too. A take drains its reads before its coverage await,
  so a read is never charged to an earlier window than the code that ran with it. The instrument
  protocol stays at 1: the new fields are optional, and a bump would hard-fail older instruments.
- **A child that dies before it is attached is read from its exit snapshot.** A test that
  shells out to a Node CLI usually watches it exit inside the test window, and a normal exit
  unlinks the instrument's socket — so the re-scan that finds services a suite starts could not
  see the process at all, and its work was missing from the map (announced, after the previous
  batch, but not recorded). `rescanningSocketSource` now harvests `pid-N.coverage.json` once per
  process — the accumulator no take drained plus the script rows no reply delivered — and
  delivers it to the boundary that discovered the process, as a live target's first take is.
  Three conditions keep it this run's evidence: no collector session in the file, an exit write
  (`endedAtUs`), and a process born after the recording started. A pid already held through its
  socket is never harvested, so nothing is counted twice, even when the socket path and the
  snapshot path reach the same file in one boundary. A snapshot with no exit write yet belongs to
  a live process and is read again at later boundaries; a file of the wrong shape is skipped
  rather than thrown; a reused pid is a new process (bookkeeping is keyed by pid and start time).
  A harvested process's script rows stay in the source's table after delivery, so a
  loader-injected `sourceMappingURL` still resolves. `discoveryIntervalMs` lets a caller
  tune the look-for-new-targets interval. `instrument.stop()` now also restores the patched
  `node:fs` functions.
- **Group recording reaches mocha's programmatic entry and cannot crash a run.** Only
  `@spikedpunch/cbd-mocha/auto` reported suite ends, so `installMochaAdapter` with
  `granularity: 'group'` recorded no windows; it now wires `groupEnd` too. The mocha `suite end`
  and japa `group:end` listeners are guarded like the test boundaries: a recorder that cannot
  write is one line on stderr, not an uncaught exception. Group mode still has no `@between`
  net; CBD.md states the trade-off.
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

## 0.0.4 — 2026-10-21

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

## 0.0.3 — 2026-10-20

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
