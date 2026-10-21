# CBD — coverage-based test selection

**Run only the tests that reach the code you changed.**

CBD records which source functions each test *actually executes* while a suite runs, stores that as a
map for a commit, and answers the question a change raises: **which tests can be affected?** It then
runs those tests instead of the whole suite.

Selection comes from observed execution, not from an import graph. Dynamic imports, dependency
injection, route tables, and code running in a server the tests drive are all visible. When the map
cannot answer — an unknown file, a missing map, a stale shard — CBD says **run everything**, with the
reason. It never silently skips a test.

## Why

- **Observed coverage, not guesses.** V8 coverage is snapshotted at every test boundary, so the map
  reflects what ran, including code reached at runtime through imports no static tool can see.
- **Per-test attribution at function granularity**, mapped back to original TypeScript via source
  maps.
- **Safe by default.** A change the map cannot place escalates to a full run. Failed tests are not
  trusted as green windows. A stale shard is refused rather than misattributed.
- **Framework-neutral.** The core has no test-framework dependency; thin adapters translate lifecycle
  events into four calls (`runStart`, `testStart`, `testEnd`, `runEnd`).
- **In-process and out-of-process code.** The same mechanism can instrument a server the suite talks
  to, not just the test process.
- **Consumable by anything.** A CLI with JSON output, a library API, and per-runner adapters.
- **Stable ids and declared facts.** Every test is named `file::title` in the map and the selection
  file, and a helper can declare a read or an opaque dependency that coverage cannot see.

## Packages

| Package | What it is |
| --- | --- |
| [`@spikedpunch/cbd`](packages/core/README.md) | Core: coverage map, diff, selection, and the library API (`createCbd`). |
| [`@spikedpunch/cbd-cli`](packages/cli/README.md) | The `cbd` binary: `collect`, `build`, `select`, `explain`, `reaches`, `stats`, `gc`. |
| [`@spikedpunch/cbd-japa`](packages/japa/README.md) | japa plugin. |
| [`@spikedpunch/cbd-mocha`](packages/mocha/README.md) | mocha preload (`/auto`). |
| [`@spikedpunch/cbd-vitest`](packages/vitest/README.md) | Vitest setup file. |
| [`@spikedpunch/cbd-jest`](packages/jest/README.md) | Jest test environment and config helper. |
| [`@spikedpunch/cbd-node-test`](packages/node-test/README.md) | `node:test` preload (`/register`). |

## Requirements

- Node.js **20.16 or newer** (the `node:test` adapter needs `TestContext.fullName`; the core runs on
  Node 20).
- `git` on `PATH`.
- One supported test runner: japa, mocha, Vitest, Jest, or `node:test`.

## How it works

1. **Record.** Run the suite with an adapter. Every test window takes a V8 coverage snapshot, which
   is written as an append-only shard under `.cbd/shards/`.
2. **Build.** Merge a commit's shards into `.cbd/maps/<commit>/map.json`: tests, functions, source
   files, and the `@load` / `@between` / `@teardown` buckets.
3. **Select.** Diff the map's commit against the working tree (or another ref), find the changed
   functions, and return the tests whose recorded windows intersect them. The answer is either
   `subset` (a test list) or `all` (with the reason).

## Quick start

Install the core, the CLI, and the adapter for your runner. The Vitest example:

```sh
pnpm add -D @spikedpunch/cbd @spikedpunch/cbd-cli @spikedpunch/cbd-vitest
```

If pnpm refuses the version because of its `minimumReleaseAge` policy (a release published minutes ago can
fall inside the default window), add `@spikedpunch/*` to `minimumReleaseAgeExclude` or wait out the
window. That is pnpm policy, not a CBD failure.

Add the setup file once. **This is the complete config change** — there are no CBD variables to put
in it:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['@spikedpunch/cbd-vitest/setup'],
  },
})
```

Record a map for the current commit. `cbd collect` runs the suite with recording enabled and builds
the map afterwards; it sets `CBD_SHARD` and `CBD_COMMIT` for the child, so **you do not set either
variable yourself**:

```sh
pnpm exec cbd collect -- pnpm vitest run
```

A plain `pnpm exec vitest run`, without `cbd collect`, leaves the setup inert and is a normal Vitest
run. That is why the line above can be committed. The variables are read by the setup file at run
time, not configured in `vitest.config.ts`; manual recording is documented in the
[Vitest adapter README](packages/vitest/README.md).

After editing a source file, ask what to run:

```sh
pnpm exec cbd select
```

`select` exits **0** for a subset, **3** for "run everything", **1** for a failure and **2** for bad
arguments, so scripts can branch without parsing output. Use `cbd explain <file>:<line>` to see which
tests reach a line, and `cbd reaches <test> <file>` for the inverse.

`--patch` and `--change` answer what a prospective edit would select without applying it — no
checkout to restore, no `dist` to rebuild. Patch paths are read relative to `--root` (the coordinate
`--since` prints), so a diff made at a nested `--root` is the one that resolves. `--emit-selection`
writes the same v2 file adapters read, and removes a stale one when the answer is "all" or empty;
write it outside the repository or under the state directory, or the next `select` will see it as an
untracked change. `--format summary` prints the answer in a
few lines for an agent. `reaches --batch` takes a JSON array of `{file, lines}` or `{file, find}` rows
with optional `killers`, and answers what reaches each row — the query a mutation tool asks before a
slow run. `build --incremental` carries the tests a select-mode recording did not run forward from
the previous map, and marks any file it could not carry so a later change there runs everything.

### Library use

```ts
import { createCbd } from '@spikedpunch/cbd'

const cbd = createCbd({ root: process.cwd() })
const { selection, selected } = cbd.select({ since: 'origin/main' })

if (selection.mode === 'all') {
  console.log('run everything:', selection.reasons)
} else {
  console.log(selected.map((test) => test.title))
}
```

## Framework setup

Recording is triggered by `CBD_SHARD`, which `cbd collect` sets for the child run. It is an
environment variable, not a config key or an adapter option; without it the adapter does nothing,
so the setup snippets below can be committed.

**Vitest**

```ts
// vitest.config.ts
export default defineConfig({
  test: { setupFiles: ['@spikedpunch/cbd-vitest/setup'] },
})
```

**japa**

```js
import { cbd } from '@spikedpunch/cbd-japa'
configure({ files: ['tests/**/*.spec.js'], plugins: [cbd()] })
```

**mocha** — preload the module, or set this in the `test` script:

```sh
NODE_OPTIONS="--import @spikedpunch/cbd-mocha/auto" mocha
```

**Jest**

```js
// jest.config.cjs
const { withCbd } = require('@spikedpunch/cbd-jest/config')

module.exports = withCbd({
  testEnvironment: '@spikedpunch/cbd-jest/environment',
})
```

**node:test**

```sh
node --import @spikedpunch/cbd-node-test/register --test
```

Then record with the same command wrapped by the CLI:

```sh
pnpm exec cbd collect -- pnpm test          # or: node --test, npx vitest run, npx jest, ...
```

## The config file

`cbd.config.json` at the repository root is optional; every key has a safe default. An explicit
`--config` path must exist, a missing default file means defaults.

```json
{
  "$schema": "./node_modules/@spikedpunch/cbd/cbd.config.schema.json",
  "include": ["src/**", "tests/**"],
  "alwaysAll": ["data/**"],
  "alwaysSelect": [
    { "tests": ["tests/schema.spec.ts > the source names no unknown column"],
      "when": ["src/schema/**"] }
  ],
  "unknownPolicyFor": [{ "paths": ["tools/**"], "policy": "ignore" }],
  "maxAgeCommits": 50
}
```

| Key | Meaning |
| --- | --- |
| `include` / `exclude` | Repository-relative globs limiting which changed files the selection considers. |
| `alwaysAll` | Globs whose changes always force a full run (schema-only or generated files, for example). |
| `alwaysSelect` | Tests every matching subset must also run, for oracles that read sources as text. Each entry is `{ "tests": ["file" or "file > title"], "when": ["glob"] }`; `when` is optional. An entry the map cannot resolve forces a full run and warns. |
| `unknownPolicy` | `"all"` (default) or `"ignore"`: what a changed file the map has never seen means. |
| `unknownPolicyFor` | Per-glob overrides for an unknown file: `[{ "paths": ["tools/**"], "policy": "ignore" }]`. First match wins; a known file is unaffected; an ignored path is named in `selection.ignored`. |
| `betweenPolicy` | `"all"` (default) or `"ignore"`: what code executed outside any test window means. |
| `testFiles` | Globs that identify test files. |
| `testFilePolicy` | `"known"` (default) selects the tests the map knows a changed test file defines and warns; `"all"` forces the suite. |
| `maxAgeCommits` | How old a map may be before it is stale. Default 50. |
| `strict` | `true` makes a stale or dirty map force a full run instead of warning. |
| `stateDir` | Where shards and maps live. Default `.cbd`. |
| `mapsDir` | Where per-commit maps live, instead of `<stateDir>/maps`. An absolute path (for example the git common directory) lets worktrees and review sandboxes share one set. |
| `granularity` | Only `"test"` is implemented. |

### Files coverage cannot see

A migration, schema file, YAML document or Dockerfile changes behavior without any test executing
code in it. Declare it as a feed: an `alwaysSelect` entry with a `when` glob and a bare test-file
locator selects every test the map knows in that file.

```json
"alwaysSelect": [
  { "tests": ["typescript/tests/stores/tests/key-store.spec.ts"],
    "when": ["typescript/db/migrations/**"] }
]
```

A bare locator is the whole file; `file > title` narrows to one test. A file a test reads while
loading is already recorded (`loadReads`), and a directory it lists is `dirReads`; this declaration
is for inputs no recorded process opened — a migration directory a service reads at boot, for
example. An entry naming a test the map does not know forces a full run and warns.

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `CBD_SHARD` | adapters | Base path for coverage shards; the adapter may write one beside it per test file (Vitest). Unset means the adapter is inert. |
| `CBD_COMMIT` | adapters | The commit the recording belongs to. Defaults to `unknown`. |
| `CBD_SELECTION` | adapters | A JSON file `{ "titles": string[] }`; the run is narrowed to those tests. |
| `CBD_SOCKET_DIR` | instrument, japa | Directory of the instrumented service's socket; declares that a service should be recorded. |
| `CBD_RELOCATE_FROM` / `CBD_RELOCATE_TO` | build | Map a deployed copy's paths back to the checkout. |
| `CBD_INCLUDE_SELF` | adapters | `1` keeps CBD's own code in the map when CBD records its own suites (dogfooding). Off by default. |
| `CBD_SNAPSHOT_MS` | instrument | Periodic snapshot interval in milliseconds; `0` disables it. |

`cbd collect` sets `CBD_SHARD`, `CBD_COMMIT` and (for a subset) `CBD_SELECTION` for the command it
spawns, then builds the map.

## CLI

```sh
cbd --version
cbd build   [--commit <sha>] [--partial] [--incremental [--base <sha>]]
cbd select  [--since <ref>] [--no-worktree] [--strict] [--commit <sha>]
            [--patch <file.diff> | --change <path>:<start>[-<end>]]
            [--emit-selection <path>] [--format text|json|summary]
cbd explain <file>[:<line>] [--format json]
cbd reaches <test-title> <file>[:<line>] [--file <test-file>] [--format json]
cbd reaches --batch <rows.json> [--format json]
cbd stats   [--commit <sha>] [--format json]
cbd collect [--no-select] [--no-build] [--shard <path>] [--incremental] -- <test command>
cbd gc      [--keep <n>]
```

The root is chosen once per command: within the git top level, the nearest directory upward with a
`cbd.config.json`, else the git top level itself; outside git, the nearest config, else the working
directory. A config above the git top level belongs to another project and is not used. `--root`
overrides it; `--config` selects the config file.
`cbd --version` prints the CLI and core versions, and the `select --format json` answer carries
`cbdVersion`. See [`@spikedpunch/cbd-cli`](packages/cli/README.md) for details.

## How selection stays safe

- A changed file with no map evidence runs **all** tests, not none.
- Code executed between tests (`@between`) or during teardown is unattributable, so it runs all tests
  unless `betweenPolicy` says otherwise.
- A window whose test failed is not trusted as a passing window and does not enter the map.
- A change to `cbd.config.json` runs all tests: the map was built under the old include, policies and
  `alwaysSelect` list.
- A file a test **read or listed** is selected when it changes, even if the test executed no code in
  it — the case of a source grep, a dependency scan or a `tsc` run. Read tracking sees the test
  process's public `node:fs` APIs; it cannot see a captured reference, a native addon, a child
  process or a separately started service, so `alwaysSelect` remains the escape hatch for those.
- A shard whose source bytes changed since recording is refused (`StaleShardError`) rather than
  mapped to the wrong offsets.
- A map that is dirty or older than `maxAgeCommits` warns, and with `strict` escalates to all.
- An **incremental** map carries a test only when every file it touched, read or listed is unchanged;
  a file whose evidence could not be carried is marked partial, and any change to it runs everything.
- Every answer carries its reasons; `cbd explain` turns them into named tests and functions.

## Dogfooding

This repository records and selects against its own suites. `cbd.config.json` at the root scopes
the map to `packages/*/src`, the packages' tests and the fixture.

```sh
pnpm dogfood:record     # record every workspace suite, then build the map for HEAD
pnpm dogfood:select     # what a change reaches — same flags as `cbd select`
```

Each package's japa runner installs the adapter only when `CBD_SHARD` or `CBD_SELECTION` is set, so
an ordinary `pnpm -r test` — and CI — does not depend on the adapter being built. Recording sets
`CBD_INCLUDE_SELF=1`, because the suite is CBD's own code: the default self-root floor would
otherwise keep every `packages/*/src` script out of the map.

One shard per package is deliberate. A shard has exactly one header and footer, and its script ids
are local to it, so several test processes writing to one file would produce a map that parses and
is wrong. `cbd build` merges the per-package files by commit.

The adapter packages are in `alwaysAll`: their suites drive mocha, Vitest, Jest and `node:test` in
child processes, which the recorder cannot see, so a function-body change there has no truthful
subset answer.

## Documentation

- [`CBD.md`](CBD.md) — the design: the model, the safety rules, adapters, the map and shard formats.
- [`arch/decisions/`](arch/decisions/) — the decision records (ADRs) behind the design.
- [`arch/log.md`](arch/log.md) — the implementation and measurement log.
- [`RELEASING.md`](RELEASING.md) — how packages are published.

## Status

CBD is under active development. The core map and selection rules are stable enough to use; the
adapter seam (`@spikedpunch/cbd/adapter`) is explicitly unstable and may change as new runners are
added.
