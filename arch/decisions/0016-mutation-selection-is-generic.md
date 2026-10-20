---
type: Architecture Decision
title: "ADR-0016: Mutation selection is generic; drivers own mutation"
description: Ship mutant-to-candidate-test selection as a library and CLI with no mutation engine, so Grizzly and other drivers apply mutants and run tests.
status: draft
tags: [mutation, grizzly, integration, architecture]
generated: { by: process:cbd-spike-pivot, at: 2026-10-19T00:00:00Z }
sources:
  - id: mutate
    resource: /packages/core/src/mutate.ts
    title: mutantTests, the safety ladder applied to a mutant range
  - id: map
    resource: /packages/core/src/map.ts
    title: The function index, testsForLine, and the load/between/teardown buckets
  - id: select
    resource: /packages/core/src/select.ts
    title: The per-file safety rules the helper mirrors
  - id: pkg
    resource: /packages/mutate/README.md
    title: The generic selector package and its command
  - id: adr15
    resource: /arch/decisions/0015-mutation-testing-is-a-stryker-integration.md
    title: The Stryker prototype this record supersedes
---

# Authors and the team

The spike author, with Claude Code. This record replaces ADR-0015's Stryker integration with the
generic shape the project wants: CBD answers which tests can observe a mutant; the driver owns the
mutation.

# Context and problem you want to solve

ADR-0015 proposed a StrykerJS `TestRunner` and produced a working prototype. It also showed that the
selection half is the valuable half: both fixture runs matched a full-suite oracle's killed/survived
set while selecting a median of two tests per mutant on `node:test`. The mutation engine itself was
never CBD's problem, and a Stryker dependency brings a large, opinionated framework into a tool whose
value is framework neutrality.

Grizzly already has a mutation driver. `typescript/tools/dev-cli` and
`.agents/review-feedback/scripts/mutate.mjs` own mutation specs (`*mutants*.json`), `find`/`replace`
application, builds, lane restarts, baseline checks and kill verification. What it lacks is a way to
answer "which tests should I try for this mutant?" without hand-authoring a killer list. That is
exactly CBD's question.

The design must also keep working outside Grizzly: a plain script, a different harness, or a future
driver should be able to consume the same answer without adopting CBD's process model.

# Functional and non-functional requirements you want to address

- **No mutation engine dependency.** No Stryker, no framework, no process model in the package.
- **One answer, as data.** Given a mutant at a source file and line, return candidates as JSON or a
  typed result.
- **Source coordinates are separate from the applied file.** A driver may apply a mutant to
  `dist/...` while the map and the source line live in `src/...`; the descriptor carries both.
- **Candidates, not killers.** The map records which functions a test executed, not which branch.
  The candidate set is a superset; a mutant is killed when **any** candidate fails. A driver that
  requires every candidate to fail would reject correct kills.
- **Safe modes are explicit.** `all` (run everything), `subset` (candidates) and `none` (no coverage)
  remain distinguishable; the driver decides how to execute `all`/`none`.
- **Grizzly compatibility.** A spec row can carry the source location; `mutate.mjs` can call the
  selector per row and keep its existing apply/build/restart/lane logic.
- **No map, no guess.** A missing or stale map is an error or an `all` answer, never an empty
  selection.
- **Generated coordinates never cost a window.** A transformed script's offsets are converted with
  line starts recorded in the shard; the source supplies them after the last window, never at a
  boundary (the drift measurement catches the alternative).
- **No recording during mutation.** Selection reads a map; a mutation run must not append shards.
- **The core helper stays in core**, so drivers that link the library do not need the CLI.

# Potential critical user journey (CUJ) the decision impacts

A developer adds `"select": { "file": "api/auth-server/src/handlers/Validate.ts", "line": 42 }` to
a mutant row in a Grizzly spec instead of hand-writing `killers`. `mutate.mjs` asks
`cbd-mutate select` for candidates, baselines them on the unmutated tree, applies the mutant,
restarts the lane, runs the candidates, and records a kill when one fails. The rest of the spec —
`find`, `replace`, `target`, `restart`, lanes, timing and restore checks — is unchanged. The same
row can be run by any other driver that reads the JSON.

# Overview of the key options

1. **Stay with the Stryker integration.** Rejected by direction: it makes a heavy mutation engine a
   dependency, and the prototype already showed the selection is the CBD-shaped part. Its per-test
   analysis also reported every Vitest mutant as survived in the spike environment.
2. **A generic selector library plus CLI, with drivers owning mutation.** Accepted.
3. **A full generic mutation runner (apply, build, restart, run, report).** Rejected: it duplicates
   Grizzly's existing machinery and every other driver's, and it turns CBD into a mutation product.
4. **Core helper only, no package/CLI.** Insufficient: Grizzly is a process boundary and should not
   need a TypeScript import to ask one question; a CLI keeps the contract language-neutral.

# Your decision and reasons behind the accepted choice

Option 2. `mutantTests` stays in core. `@spikedpunch/cbd-mutate` provides:

- the same function for library callers, re-exported;
- `cbd-mutate select --file <source> --line <n> [--end-line <n>] [--format json]`, which loads the
  map for the nearest commit (or `--commit`), applies the safety ladder, and prints
  `{ mode, why, titles, tests }`.

There is no mutation engine, no Stryker dependency, no test-framework import and no recording path.
The package's only dependency is `@spikedpunch/cbd`.

## Candidate semantics

This is a contract, not advice:

- `subset` is a superset of the tests that can kill the mutant. The driver runs the candidates; a
  mutant is **killed** if at least one fails. Candidates that pass are not failures of the selector.
- `all` means the map cannot place the mutant (`load`, `between`, an unknown file). The driver must
  run the whole suite or report that it cannot; it must not run no tests.
- `none` means no test reaches the mutant (an untested file or a test file). The driver reports no
  coverage; it must not treat the mutant as killed.

A driver may keep a hand-authored killer mode beside this one. In Grizzly, rows with `killers` keep
"every named killer must fail"; rows with `select` use "any candidate may kill".

## Grizzly integration contract

A spec row gains an optional source location:

```json
{
  "id": "N2",
  "file": "api/auth-server/dist/handlers/Validate.js",
  "select": { "file": "api/auth-server/src/handlers/Validate.ts", "line": 42 },
  "find": "if (now > validUntil) {",
  "replace": "if (...) {"
}
```

- `file`, `find` and `replace` still describe **application**.
- `select.file`/`line` describe **selection** in the map's source coordinates. They may be omitted
  for a clone row whose applied file is already the source; the explicit form is required when the
  applied file is built output.
- `mutate.mjs` calls `cbd-mutate select` (or imports `mutantTests`) with the repo root and state
  directory, and uses `titles` as the candidate list.
- The baseline is the candidate union; after mutation, candidates run under the existing `test`
  template (`{killer}`), and `died` becomes the actual killer list. `lived` is informational.
- Intended survivors require that **no** candidate dies.
- `mode: "all"` needs a spec-level all-tests command (or a refusal); `mode: "none"` is reported as
  no coverage. `mutate.mjs` must not silently run zero tests.
- Lanes, restarts, builds, restore verification and timings are untouched. The map must include
  server-side coverage (japa + the instrumented service), because a candidate for a server mutant
  comes from the test that drove the request.

## Map prerequisites

- Record a green, full run with the japa plugin and the lane's server instrument:
  `cbd collect --no-select -- …`.
- The map commit must be the base the spec mutates. A stale or dirty map follows the existing
  warnings; a mutation driver should refuse `all`/stale answers or use them explicitly.
- The service's deployed copy is relocated to checkout paths (`CBD_RELOCATE_FROM`/`TO`), so the spec
  can name a source file.
- **Transformed scripts carry generated coordinates.** ts-node, Vitest and Jest compile in memory;
  V8's offsets index that generated text, not the file. The shard records the generated text's line
  starts in an optional `generated` field, written as an end-of-run update row, and the build indexes
  those instead of the file (`cbd-x2j`). Untransformed scripts omit the field and keep the file
  index. Sources prepare the data after the last window (`Source.prepare`), so no source read
  lengthens a boundary.

## Spike results — Grizzly first row (2026-10-19)

The generic selector and the `mutate.mjs` integration were validated in the Grizzly measurement
clone on the int-cli `unit` suite:

- Recorded map: **1082 tests, 74 files**. `cbd-mutate select --file src/manifest.ts --line 349`
  returned exactly one candidate, the test named for `removeManifest`.
- Row G1 (`select`): **killed by at least one candidate**. Row G1h (the same mutant, hand-named
  killer): **killed by every named test**. Both restored the file byte-for-byte and exited 0.
- Candidate precision on the same map: `src/manifest.ts:348` → 1 test, `:165` → 84, `:221` → 390
  of 1082. The function-level superset is visible: a narrow function selects one test, a popular
  utility selects hundreds.
- The mutant rethrows `removeManifest`'s swallowed error; the single candidate is the test that
  asserts a missing manifest does not throw. This is the kill-parity case the integration needed.

**Decision: go** for the generic selector and the Grizzly integration. The caveats are production
work, not design unknowns: `mode: all` needs a spec-level `testAll`; candidate runs were one process
per test (ts-node startup dominated the 4 s row); a larger suite was not yet measured; service
coverage must be present in the map for server rows; and `PLAIN_VERDICTS` must stay in step with
`dev-cli`'s digest. The first two and the measurement are closed below.

## Spike results — one-process candidates and `mode: all` (2026-10-20)

`cbd-wrp` closed the two gaps the first row left:

- A spec may name `testSelected`; a subset row then runs the whole candidate set in **one process**
  through `CBD_SELECTION`, and **any** failure is the kill. A row opts out with
  `"testSelected": null`, which is how the two paths are compared below.
- A row whose selection is `all` runs the spec's `testAll` once, after mutation and restart. A
  missing `testAll` fails the spec before any file is mutated.
- Both paths re-run a kill on the restored tree, as the named-killer path already did.

Measured on the same 1082-test / 74-file map (`spike-cbd-measure.json`, five rows, serial clone):

| row | selection | mutation | candidates | killers s | verdict |
|---|---|---|---|---|---|
| M1 | `manifest.ts:349` | `removeManifest` rethrow | 1 | 6 | killed by at least one candidate |
| M2 | `manifest.ts:168` | handle ring → uid | 84 | 10 | killed by at least one candidate |
| M3 | `manifest.ts:1` (load → all) | `removeManifest` rethrow | full suite | 15 | killed by the full suite |
| M4 | `verify/index.ts:232` | `readableIds` drops one | 6, per candidate | 46 | killed by at least one candidate |
| M5 | same as M4 | same | 6, one process | 6 | killed by at least one candidate |

Phase split for the run (`MUTATE_TIMINGS=1`): **selection 1.24 s** (0.25 s per row), **baseline
80.2 s** (ten unmutated runs), **rows 83.4 s**, total 164.9 s. Killers seconds cover the mutated run
plus the confirming re-run on restored code; baseline is deliberately excluded from them.

Wall clock of one suite invocation on this clone, medians of three: **4.8 s** for one selected test,
**6.0 s** for 6, **7.3 s** for 84, **8.3 s** for the full 1082. ts-node/japa loads and compiles every
spec file before the filter applies, so selection saves execution time, not registration. That is
why the one-process change is the decisive one: M4's six candidates cost 46 s one process each and
6 s as one run, with the same verdict. A per-candidate M2 would be roughly 84 × 5 s per pass plus
the confirmation runs; it was not run and that figure is extrapolated from the measured per-process
cost.

**Speed decision: go.** The selector's own cost is negligible (0.25 s per mutant). The one-process
path makes wide selections affordable (7–8× on the measured row) and preserves the kill verdict.
Selection versus the full suite depends on the suite: a clear win where test execution dominates,
and about a 1–2 s saving on this startup-bound suite, where the full suite already runs in 8 s. The
speed claim is supported for the one-process design and for large suites, not for startup-bound
suites.

# Consequences

- ADR-0015 is deprecated; the Stryker runner and its dependencies are removed. The Stryker prototype
  remains a measurement in the log and this record's history.
- The core keeps `mutantTests`; the optional package adds a CLI and re-exports. The package is
  publishable without a peer dependency.
- Grizzly's `mutate.mjs` gains a selection path and candidate verdict; its mutation engine,
  scheduling and lanes stay where they are.
- The candidate set can be large for a hot function; the driver's baseline and candidate runs are
  the cost. It can now run the whole set through `CBD_SELECTION` in one command (`cbd-wrp`), which
  is the measured 7–8× case.
- Test-file mutants, untested files and test-title matching remain the driver's responsibilities;
  the selector reports `none`/`all` and the bare map titles rather than guessing.

# Risks and open questions

- **Transformed-script coordinates are resolved** (`cbd-x2j`): a script row may carry `generated`
  line starts, and an end-of-run update row supplies them after the teardown boundary settles. The
  remaining risk is a service running an instrument older than the `generated` op; it falls back to
  the file, which is safe but imprecise for transformed code.
- **Map title spelling.** The japa adapter records bare titles, which is what `--tests {killer}`
  expects; a different driver's filter may need its own title mapping.
- **Server coverage completeness.** A map that missed the instrumented service would return
  `all` for server mutants, which is safe but defeats selection.
- **Over-selection.** Function-level evidence can select many candidates for a large function; the
  driver measures whether that is cheaper than the full suite.
- **Named killers still matter.** A hand-authored killer is evidence a human chose; a candidate that
  dies is discovered evidence. The spec should retain the died list so the next run can start there.
- **`all` execution.** A spec needs a defined `testAll` command; the driver now refuses a spec
  without one before mutating anything, rather than running nothing.
