---
type: Architecture Decision
title: "ADR-0015: Mutation testing is a Stryker integration over the coverage map"
description: Offer mutation testing as an optional StrykerJS runner that selects tests from CBD's map, with the safety ladder in core.
status: deprecated
tags: [mutation, adapters, integration, architecture]
generated: { by: process:cbd-spike-design, at: 2026-10-19T00:00:00Z }
sources:
  - id: map
    resource: /packages/core/src/map.ts
    title: The function index, testsForLine, and the seen/load/between/teardown buckets
  - id: select
    resource: /packages/core/src/select.ts
    title: The safety ladder selection already applies to changed files
  - id: env
    resource: /packages/core/src/env.ts
    title: CBD_SELECTION, the adapter selection contract
  - id: adapters
    resource: /CBD.md
    title: Section 7, the adapters and how each narrows a run
  - id: bead
    resource: bead:cbd-0ro
    title: The spike this decision schedules
---

> **Superseded by [ADR-0016](0016-mutation-selection-is-generic.md).** The Stryker
> prototype established `mutantTests` and the runner mechanics; the project chose a generic
> selector with drivers owning mutation, and the Stryker dependency was removed.

# Authors and the team

The spike author, with Claude Code. The spike is tracked as `cbd-0ro`; this record is the design it
executes and the decision it must confirm or reject.

# Context and problem you want to solve

Mutation testing asks, once per mutant, a question CBD already answers per change: **which tests can
observe code executing at this file and line?** CBD's map holds, for every source function, the line
range and the tests that executed it [^map]. The expensive half of mutation testing — discovering
the test set per mutant — is therefore already recorded for a commit.

The question is not whether CBD can *answer* the query; it can. The question is whether the answer is
precise and cheap enough to justify a package, and where that package should end. A mutation engine
must generate mutants, apply them, run tests, classify outcomes, handle timeouts and flakiness,
report, and support incremental runs. StrykerJS already does all of it. Reimplementing that would be
a second product with a worse operator set, not a CBD feature.

The design therefore separates two concerns:

- **Selection** is CBD's: map a mutant location to the tests that could kill it, and hand those
  titles to whichever runner the project uses. Every supported adapter already consumes
  `CBD_SELECTION`, so this half is framework-neutral [^env] [^adapters].
- **Mutation** is Stryker's: mutant generation, sandboxing, application, scheduling, classification,
  reporting and incremental state. CBD should integrate at Stryker's test-runner seam, not replace it.

# Functional and non-functional requirements you want to address

- **No under-selection.** The candidate set must contain every test that executed the mutated line.
  Over-selection is acceptable; a missed killer is not.
- **The safety ladder is part of the answer.** A line in `@load`, `@teardown`, `@between`, an unknown
  file, or a file the map has seen but no test reaches must not silently produce an empty set. The
  rules `select` already applies to a changed file must apply to a mutant location [^select].
- **One package for every supported runner.** No runner-specific code in the mutation package; japa,
  mocha, Vitest, Jest and `node:test` narrow through `CBD_SELECTION` and their existing adapters.
- **No recording during mutation runs.** A mutation run sets `CBD_SELECTION`, never `CBD_SHARD`;
  recording every mutant would fill `.cbd/shards` with windows for code that never existed.
- **Green baseline.** The map only contains passing test windows. Mutation results are meaningless
  against a red baseline, and a test omitted from the map could be the killer. Refuse to start, or
  require a separate `includeNonGreen` map with an explicit warning.
- **Correct classification.** Killed, survived, no coverage, timeout and infrastructure error must be
  distinguishable. An infrastructure failure reported as a kill inflates the score silently.
- **Safe application.** Mutants are applied in Stryker's sandbox; the original tree and `.cbd` are
  untouched. Concurrent mutants must not share one selection file.
- **Measurable.** The spike must produce numbers for under-selection, over-selection, score parity
  and per-mutant wall clock before a package is built.
- **Bounded v1.** In-process code only. A mutant in a separately started service would require a
  recompile and restart per mutant; that is a different problem.
- **Small stable surface.** `mutantTests` belongs on the core package root (Tier 1); the Stryker
  runner and CLI belong in the optional package.

# Potential critical user journey (CUJ) the decision impacts

A developer has a green Vitest suite and a CBD map for the commit. They run Stryker with the CBD
runner over `src/**/*.ts`. For each mutant, the runner asks the map which tests reach the mutated
range, writes those titles to a per-mutant selection file, runs the project's normal test command
with `CBD_SELECTION` set, and reports the exit status. The mutation score matches a full Stryker
`perTest` run, but the per-mutant test set is a fraction of the suite. The same setup works for
japa, mocha, Jest or `node:test` by changing only the test command.

# Overview of the key options

1. **A standalone mutation engine.** Generate and apply mutants, run tests, report. Rejected: it
   duplicates Stryker's operator set, scheduling, sandboxing, incremental state and reporters, and
   its first version would be worse at all of them.
2. **Add mutation to `cbd` itself.** Rejected: it makes a heavy optional dependency part of the core
   CLI and couples the command's release cycle to a mutation engine. Keep mutation optional.
3. **A StrykerJS integration package** (`@spikedpunch/cbd-mutate`) with a custom `TestRunner`, plus a
   `mutantTests` helper in core. Accepted.
4. **Library helper and documentation only.** Rejected as the product answer, but the helper is
   kept regardless: it is the safe way for any mutation tool to ask the map.
5. **A mutation package with its own generic process-per-mutant loop.** Deferred as a fallback only
   if Stryker's runner API proves unsuitable; it reimplements scheduling and reporting.

# Your decision and reasons behind the accepted choice

Build **`@spikedpunch/cbd-mutate`** as an optional StrykerJS `TestRunner` integration, and add
**`mutantTests(map, target, policy)`** to `@spikedpunch/cbd` as the one implementation of the safety
ladder.

Stryker owns mutation; CBD owns selection. The package depends on `@spikedpunch/cbd`, has
`@stryker-mutator/core` as a peer, and imports no test framework. The project supplies a test
command; the package supplies the selection file and the environment. That is what makes the same
package work with every adapter: the adapters already know how to narrow a run from
`CBD_SELECTION` [^adapters].

The package is optional. A project that does not mutate tests never installs Stryker, and the core
never learns what a mutant is beyond a file and a line range.

## The `mutantTests` contract

```ts
export interface MutantTarget {
  /** Repository-relative path, as the mutator reports it. */
  file: string
  /** 1-based, inclusive. A mutator may report a range. */
  startLine: number
  endLine?: number
}

export interface MutantPolicy {
  /** Repository root for a relative target.file. Default: process.cwd(). */
  root?: string
  /** Mirrors select's betweenPolicy. Default 'all'. */
  betweenPolicy?: 'all' | 'ignore'
  /** Mirrors select's unknownPolicy. Default 'all'. */
  unknownPolicy?: 'all' | 'ignore'
}

export type MutantWhy =
  | 'unknown-file'
  | 'load'
  | 'teardown'
  | 'between'
  | 'untested'
  | 'function'
  | 'file'
  | 'test-file'

export interface MutantSelection {
  mode: 'all' | 'subset' | 'none'
  why: MutantWhy
  /** Empty for all/none; resolved `{ title, file }` entries for subset. */
  tests: TestEntry[]
}
```

`file` is canonicalized (realpath) and resolved against `policy.root` before lookup, because map
keys are the absolute paths a recorded process reported. A range selects the union over its lines; a
single-line mutant is the common case.

## The safety ladder

The helper applies the same order as `select`'s per-file rules [^select]. **Per-test function
evidence wins over the file-level buckets.** A module is often in `@load` because a test file
imported it at start-up; a mutant inside one of its functions is still killable by the tests that
executed that function in their own windows. The buckets answer a location the function index cannot
place.

| Condition | Answer |
| --- | --- |
| The file is a test file | `none` (`test-file`) — mutating the oracle is not mutation testing. Stryker's `mutate` globs should exclude test files; the helper refuses one if asked. |
| Every line in the range is inside at least one mapped function | `subset` (`function`) — the union of those functions' tests. Nested functions contribute all their tests, as in `testsForLine`. Load/between/teardown do not override this. |
| Otherwise, the file is in `map.load` or `map.teardown` | `all` — top-level or teardown code can affect any test that loads the module. |
| Otherwise, the file is in `map.between` and `betweenPolicy` is `all` (default) | `all` — the map cannot attribute the test that caused the execution. |
| Otherwise, the file has mapped functions | `subset` (`file`) — every test that touched the file; a top-level mutant can be read by any of them. |
| Otherwise, the file is in `map.seen` | `none` (`untested`) — no test reaches it; report it as no coverage rather than running the suite. |
| Otherwise (unknown file) | `unknownPolicy`: `all` by default, otherwise `none`. |

Two cases are deliberately not folded into `testsForLine`: `testsForLine` returns `[]` for a file not
in `map.files`, and it does not consult `load`/`between` at all. The helper exists so callers cannot
get those rules wrong [^map].

## The runner protocol

The Stryker runner receives each mutant with its file and range. For one mutant it:

1. Resolves the sandbox path back to the repository-relative path and asks `mutantTests`.
2. Writes `{ "titles": [...] }` to a **per-mutant** selection file under the state directory (for
   example `.cbd/mutate/<mutant-id>.json`). Stryker may run mutants concurrently, so one shared file
   would race.
3. Builds an environment with `CBD_SELECTION` set and `CBD_SHARD` **removed**; the run must select,
   not record. Correlation variables are irrelevant here.
4. Spawns the project's test command (a configuration value, not a package assumption) and waits.
5. Classifies: exit 0 is survived; a test failure is killed; no selected tests is no-coverage; a
   timeout is timeout. Infrastructure errors are not kills.
6. Removes the selection file and returns the result to Stryker, which owns reporting and the score.

The command is run through the platform shell because projects express it as a string
(`pnpm vitest run`, `NODE_OPTIONS=... mocha`, …). It is trusted configuration, not untrusted input.

## Package surface and configuration

The primary entry point is the Stryker runner:

```json
// stryker.conf.json
{
  "testRunner": "@spikedpunch/cbd-mutate/runner",
  "coverageAnalysis": "off",
  "mutate": ["src/**/*.ts", "!src/**/*.spec.ts"]
}
```

The project's test command and the selection policy live in a separate, optional
`cbd-mutate.json` at the repository root (a section in `cbd.config.json` would be rejected by its
strict key list, and mutation is not a selection-config concern):

```json
{
  "testCommand": "pnpm vitest run",
  "betweenPolicy": "all",
  "selectionDir": ".cbd/mutate"
}
```

`CBD_MUTATE_TEST_COMMAND` overrides `testCommand` for CI experiments. A `cbd-mutate` CLI wrapper is
**not** part of v1: it would only re-expose Stryker's own command, and the spike should first show
that the configuration is the obstacle.

**Exit-code ambiguity is the main correctness risk.** A runner that exits nonzero for a missing test,
a worker crash, or a configuration error would look like a kill. The spike measures how often this
happens on the fixture and evaluates a per-framework report (Vitest/Jest JSON, mocha JSON,
`node:test` TAP) as a follow-up. v1 classifies by exit code only if the baseline validates the
command and the selected run's stderr matches a known test-failure shape; otherwise it reports an
infrastructure error.

## Application, source and services

Stryker applies mutants in its sandbox. The map is keyed by the original checkout's realpaths, so the
runner must translate the mutant's sandbox path to the repository-relative path before lookup. That
is also what keeps a stale map from being used against a different file: the map's commit is the
base commit, and a mutant changes one token within it.

- **In scope:** runners that transform TypeScript at run time (Vitest, Jest) or execute it directly
  (`node:test` with Node's type stripping).
- **Out of scope for v1:** a japa/mocha project that tests a built `dist/`. Mutants would have to be
  applied and rebuilt per mutant; Stryker's build hook is not per-mutant. The spike records the
  limitation rather than papering over it.
- **Out of scope for v1:** mutants in a separately started service. The service would need to be
  rebuilt and restarted per mutant, and its coverage is recorded through a different source.

## Performance model

For each mutant the cost is:

```
process start + selected test execution + classification
```

The map lookup is negligible. The two things that decide whether this is useful are:

- **the over-selection factor** — selected tests per mutant divided by Stryker's per-test set. CBD's
  evidence is function-level, so a mutant inside a large function selects every test that entered
  the function. It is a safe superset, but mutation testing multiplies it across hundreds of
  mutants.
- **process startup per mutant** — a filtered Vitest/Jest run still starts a worker pool; a
  `node:test` subset run starts the runner and, from the adapter, an extra process per test file.

The spike measures both, separately from test execution time. If startup dominates, the answer is a
deeper Stryker runner integration (keep the runner warm), not a different map.

## Spike plan

Tracked as `cbd-0ro` [^bead]. The fixture uses the existing CBD fixture project or a small copy with
2–4 source files and 20–50 tests. **Vitest** is the first runner; **`node:test`** is the second and
is required for the go decision, because the package's central claim is that the adapters' existing
`CBD_SELECTION` contract makes mutation selection runner-neutral. No external service, no compiled
`dist/`.

1. Record a green, full map for the fixture (`cbd collect --no-select -- …`) so every test window is
   present.
2. Implement `mutantTests` with the ladder above and unit tests for each row.
3. Enumerate mutants with Stryker and compute candidate sets. Compare with Stryker's
   `coverageAnalysis: 'perTest'` set per mutant: `perTest ⊆ candidates` must hold for every mutant.
4. Implement the Stryker `TestRunner` prototype and run the fixture twice: once with Stryker's
   `perTest`, once with the CBD runner and `coverageAnalysis: 'off'`.
5. Compare killed/survived/no-coverage/timeout per mutant and the mutation score.
6. Measure median and p95 selected tests per mutant, over-selection factor, per-mutant wall clock,
   and process-startup share.

**Decision gates (proposed, to be confirmed by the measurements):**

- **Correctness:** zero under-selection against Stryker's per-test set. Any miss is a no-go until
  explained.
- **Score parity:** identical killed/survived classification. A difference is a bug in the runner,
  not a tuning choice.
- **Precision:** median selected tests per mutant at most **25%** of the suite on the fixture. Above
  that, function-level selection may not pay for itself.
- **Speed:** wall clock no worse than **2×** Stryker's per-test run. If it is worse, either the
  process-per-mutant design is the problem or function-level over-selection is; the spike reports
  which.
- **Robustness:** at least one deliberate infrastructure error (bad command, missing file) is
  classified as an error, not a kill.
- **Runner neutrality:** Vitest and `node:test` both narrow through the same `CBD_SELECTION`
  mechanism with no runner-specific code in the mutation package. One runner alone does not answer
  the package-shape question.

The spike ends with a go/no-go appended to this record and, on go, follow-up beads for the package,
the core helper and the docs. On no-go, the helper still ships with the measurements attached.

## Spike results — first pass (2026-10-19)

The prototype and the exact commands are in [`packages/mutate/SPIKE.md`](../../packages/mutate/SPIKE.md).
`mutantTests` is implemented and tested in core (`cbd-0ro.1`); the Stryker runner is in
`packages/mutate/src/runner.ts`.

| Gate | `node:test` / JS | Vitest / TS |
| --- | --- | --- |
| Mutation score vs full-suite oracle | 92.06% vs 92.06% | 93.15% vs 93.15% |
| Per-mutant status parity | 63/63 | 73/73 |
| Selected tests per mutant | median 2 of 25 (8%) | median 0; 53/73 forced `all` |
| Wall clock vs full suite | 24.2 s vs 15.9 s | 43.0 s vs 38.0 s |
| Under-selection vs Stryker `perTest` | not measurable (no node:test perTest) | not measurable |

**The shape works.** Stryker loads the plugin, passes each mutant, and accepts the runner's
classification. The missing pieces were learned rather than guessed: the active mutant is activated
by `__STRYKER_ACTIVE_MUTANT__`, Stryker's internal line numbers are 0-based (the report is 1-based),
and the dry run needs a non-empty test result even when coverage analysis is off. Both fixture runs
matched the full-suite killed/survived set exactly.

**The Vitest precision gate is blocked by a core bug, not by this design.** `cbd-x2j`: the build
indexes the on-disk source file as the generated script. Vitest's TypeScript transform is longer
than the source (`add` is at offsets 748-785 in a 597-byte file), so offsets clamp to the last line
and every function resolves to line 31. The Vitest score still matched because 53 mutants fell back
to `all`; the selection was safe and useless. `node:test` on plain JavaScript has correct ranges,
which is why it is the precision measurement here.

**Stryker's own `perTest` runner reported every mutant as survived** on the Vitest fixture while
the command runner killed 68. It is not usable as the per-test oracle in this environment until that
is explained; the full-suite command runner is the score oracle.

**Speed is not yet demonstrated.** On a 25-test, 2-file fixture, per-mutant process startup
dominates: ~2 selected tests per mutant ran slower than the full suite (24.2 s vs 15.9 s), and the
`node:test` adapter's selection re-exec adds a process per selected test file. The precision result
is real (median 8% of the suite) but the speed claim needs a fixture with many test files where a
mutant selects few of them.

**Decision: conditional go.** Keep the package shape and the core helper. Do not claim Vitest/Jest
mutation support until `cbd-x2j` is fixed and the Vitest numbers are re-run. Re-run the speed gate on
a larger fixture before making the performance claim. The spike remains open on `cbd-0ro`; `cbd-x2j`
blocks the measurement task.

## Risks and open questions

- **Stryker TestRunner API fit.** The spike validates the version and the lifecycle. If the API
  cannot receive mutant locations and sandbox paths cleanly, the fallback is a command-based runner,
  not a new engine.
- **Exit-code ambiguity.** Killed vs infrastructure error is the correctness risk; see above.
- **Flaky tests.** Every mutant is a fresh run; a flaky failure becomes a false kill. Baseline
  validation and a documented retry policy are prerequisites, not polish.
- **Function-level precision.** The over-selection factor is the product decision; measure it on a
  real suite, not just the fixture.
- **Line stability.** Token-replacement mutants keep line numbers; a mutant that inserts or deletes
  lines shifts them. The runner must use the base file's coordinates.
- **Same-title tests.** `cbd-gkj` means two same-named tests in one file can share a map entry.
  Selection over-selects both, which is safe; kill attribution would be ambiguous.
- **Map freshness.** Use a map for the base commit, refuse a dirty or stale map, and require the
  baseline to be green. A map built from a red run is not evidence.
- **Test-file mutants.** Excluded by policy; mutating assertions changes the oracle rather than the
  program.
- **Selection mechanics per adapter.** japa filters bare titles, mocha builds a grep, Vitest skips in
  `beforeEach`, Jest sets `testNamePattern`, `node:test` re-executes with a name pattern. All are
  existing, tested behavior; the mutation package must not add a second selection path.

# Consequences

- **New optional package:** `@spikedpunch/cbd-mutate`, with a Stryker `TestRunner` and no
  test-framework dependencies; a separate CLI is deferred until the spike justifies it.
- **Core addition:** `mutantTests` on the package root, with the ladder tested against the same
  cases as `select`.
- **No CLI change:** `cbd` stays a selection tool. Mutation is a separate binary/package.
- **No core dependency on Stryker:** the dependency edge points from the optional package to core.
- **Documented limits:** in-process code only in v1; compiled `dist/` and separately started
  services are explicit follow-ups, not silent gaps.
- **If no-go:** the measurements and the helper remain; the record says why a package was not built.

[^map]: `packages/core/src/map.ts` — `CoverageMap.files`, `testsForLine`, `seen`, and the
    `load`/`between`/`teardown` buckets.
[^select]: `packages/core/src/select.ts` — the per-file ladder and the `betweenPolicy` /
    `unknownPolicy` defaults.
[^env]: `packages/core/src/env.ts` — `CBD_SELECTION` and `SelectionFile`.
[^adapters]: CBD.md §7 — how japa, mocha, Vitest, Jest and `node:test` narrow a run.
[^bead]: `cbd-0ro` — the spike, its questions and its acceptance criteria.
