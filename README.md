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

Install the core, the CLI, and the adapter for your runner. The japa example:

```sh
pnpm add -D @spikedpunch/cbd @spikedpunch/cbd-cli @spikedpunch/cbd-japa
```

Configure the adapter once, in the runner's config (it is inert unless CBD asks it to record):

```js
// bin/test.js (japa)
import { configure, processCLIArgs, run } from '@japa/runner'
import { cbd } from '@spikedpunch/cbd-japa'

processCLIArgs(process.argv.slice(2))
configure({ files: ['tests/**/*.spec.js'], plugins: [cbd()] })
await run()
```

Record a map for the current commit (this runs the suite once):

```sh
pnpm exec cbd collect -- pnpm test
```

After editing a source file, ask what to run:

```sh
pnpm exec cbd select
```

`select` exits **0** for a subset, **3** for "run everything", **1** for a failure and **2** for bad
arguments, so scripts can branch without parsing output. Use `cbd explain <file>:<line>` to see which
tests reach a line, and `cbd reaches <test> <file>` for the inverse.

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

Each adapter is enabled by `CBD_SHARD`, which `cbd collect` sets for the child run. With that variable
absent the adapter does nothing, so the setup can be committed to the repository.

**japa**

```js
import { cbd } from '@spikedpunch/cbd-japa'
configure({ files: ['tests/**/*.spec.js'], plugins: [cbd()] })
```

**mocha** — preload the module, or set this in the `test` script:

```sh
NODE_OPTIONS="--import @spikedpunch/cbd-mocha/auto" mocha
```

**Vitest**

```ts
// vitest.config.ts
export default defineConfig({
  test: { setupFiles: ['@spikedpunch/cbd-vitest/setup'] },
})
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
  "maxAgeCommits": 50
}
```

| Key | Meaning |
| --- | --- |
| `include` / `exclude` | Repository-relative globs limiting which changed files the selection considers. |
| `alwaysAll` | Globs whose changes always force a full run (schema-only or generated files, for example). |
| `unknownPolicy` | `"all"` (default) or `"ignore"`: what a changed file the map has never seen means. |
| `betweenPolicy` | `"all"` (default) or `"ignore"`: what code executed outside any test window means. |
| `testFiles` | Globs that identify test files. |
| `testFilePolicy` | `"known"` (default) selects the tests the map knows a changed test file defines and warns; `"all"` forces the suite. |
| `maxAgeCommits` | How old a map may be before it is stale. Default 50. |
| `strict` | `true` makes a stale or dirty map force a full run instead of warning. |
| `stateDir` | Where shards and maps live. Default `.cbd`. |
| `granularity` | Only `"test"` is implemented. |

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `CBD_SHARD` | adapters | Write coverage windows to this shard. Unset means the adapter is inert. |
| `CBD_COMMIT` | adapters | The commit the recording belongs to. Defaults to `unknown`. |
| `CBD_SELECTION` | adapters | A JSON file `{ "titles": string[] }`; the run is narrowed to those tests. |
| `CBD_SOCKET_DIR` | instrument, japa | Directory of the instrumented service's socket; declares that a service should be recorded. |
| `CBD_RELOCATE_FROM` / `CBD_RELOCATE_TO` | build | Map a deployed copy's paths back to the checkout. |
| `CBD_SNAPSHOT_MS` | instrument | Periodic snapshot interval in milliseconds; `0` disables it. |

`cbd collect` sets `CBD_SHARD`, `CBD_COMMIT` and (for a subset) `CBD_SELECTION` for the command it
spawns, then builds the map.

## CLI

```sh
cbd build   [--commit <sha>] [--partial] [--format json]
cbd select  [--since <ref>] [--no-worktree] [--strict] [--commit <sha>]
cbd explain <file>[:<line>] [--format json]
cbd reaches <test-title> <file>[:<line>] [--file <test-file>] [--format json]
cbd stats   [--commit <sha>] [--format json]
cbd collect [--no-select] [--no-build] [--shard <path>] -- <test command>
cbd gc      [--keep <n>]
```

`--root` selects the repository (default: the working directory); `--config` selects the config file.
See [`@spikedpunch/cbd-cli`](packages/cli/README.md) for details.

## How selection stays safe

- A changed file with no map evidence runs **all** tests, not none.
- Code executed between tests (`@between`) or during teardown is unattributable, so it runs all tests
  unless `betweenPolicy` says otherwise.
- A window whose test failed is not trusted as a passing window and does not enter the map.
- A shard whose source bytes changed since recording is refused (`StaleShardError`) rather than
  mapped to the wrong offsets.
- A map that is dirty or older than `maxAgeCommits` warns, and with `strict` escalates to all.
- Every answer carries its reasons; `cbd explain` turns them into named tests and functions.

## Documentation

- [`CBD.md`](CBD.md) — the design: the model, the safety rules, adapters, the map and shard formats.
- [`arch/decisions/`](arch/decisions/) — the decision records (ADRs) behind the design.
- [`arch/log.md`](arch/log.md) — the implementation and measurement log.
- [`RELEASING.md`](RELEASING.md) — how packages are published.

## Status

CBD is under active development. The core map and selection rules are stable enough to use; the
adapter seam (`@spikedpunch/cbd/adapter`) is explicitly unstable and may change as new runners are
added.
