# @spikedpunch/cbd-cli

The `cbd` binary for [CBD](https://github.com/SpikedPunchVictim/cbd): record a coverage map, ask which
tests a change reaches, and explain the answer.

```sh
pnpm add -D @spikedpunch/cbd-cli @spikedpunch/cbd
# plus the adapter for your runner, e.g. @spikedpunch/cbd-japa
```

## Commands

```sh
cbd --version
cbd build   [--commit <sha>] [--partial] [--root <dir>] [--format json]
cbd select  [--since <ref>] [--no-worktree] [--strict] [--commit <sha>]
cbd explain <file>[:<line>] [--root <dir>] [--format json]
cbd reaches <test-title> <file>[:<line>] [--file <test-file>] [--format json]
cbd stats   [--commit <sha>] [--root <dir>] [--format json]
cbd collect [--no-select] [--no-build] [--shard <path>] -- <test command>
cbd gc      [--keep <n>] [--root <dir>] [--format json]
```

The root is, within the git top level, the nearest directory upward containing a `cbd.config.json`,
else the git top level itself; outside git, the nearest config, else the working directory. A config
above the git top level is not used. `--root` overrides it. The config is `<root>/cbd.config.json` unless
`--config` names another; a missing default config means safe defaults, a missing explicit one is an
error. `cbd --version` prints the CLI and core versions, and `select --format json` carries
`cbdVersion`.

### `cbd collect`

Runs the test command with `CBD_SHARD` and `CBD_COMMIT` set, optionally narrows it with
`CBD_SELECTION`, then builds the map in the same process.

```sh
pnpm exec cbd collect -- pnpm test
pnpm exec cbd collect --no-select -- pnpm test   # full recording, never narrow
```

Select and build are on by default once collection is asked for; `--no-select` and `--no-build` turn
each off. On a repository's first run there is no map, so the honest answer is a full recording, not
an error. An interrupted child leaves a shard with no footer, which is refused rather than built.

A run that selected a subset rebuilds the map incrementally from the map the selection read, so the
tests it skipped stay in the map (the explicit `--incremental` and `--base` still work). A run whose
test command exits non-zero builds no map and says so, leaving any existing map as it was: the
failed tests are not recorded as passing, and a map without them would stop selecting them. `--no-select` records the full suite
and builds from that alone.

The adapters are inert unless `CBD_SHARD` is set, so the same `test` script works for ordinary runs
and for `cbd collect`.

### `cbd select`

Diffs the map's commit against the working tree (or `--since <ref>` / `--no-worktree` for `HEAD`) and
prints the tests to run, with the reasons.

```sh
pnpm exec cbd select
pnpm exec cbd select --since origin/main --format json
```

Exit codes are part of the interface:

| Exit | Meaning |
| --- | --- |
| `0` | A subset was selected. |
| `3` | The answer is "run all"; the reason is printed. |
| `1` | Failure (no map, stale shard, git error). |
| `2` | Bad arguments. |

A script can therefore branch without parsing output:

```sh
pnpm exec cbd select
status=$?
case $status in
  0) run_selected_only ;;
  3) run_everything ;;
  *) exit "$status" ;;
esac
```

### `cbd explain` and `cbd reaches`

`explain` answers "what reaches this file or line?": the functions and the tests whose windows touched
them. `reaches` answers the inverse for one test, which is useful when reading a test or asking a
mutation-testing question.

```sh
pnpm exec cbd explain src/router.ts:42
pnpm exec cbd reaches 'handles a refund' src/payments.ts --file tests/refund.spec.ts
pnpm exec cbd reaches 'handles a refund' src/payments.ts --format json
```

With a line, `explain` also runs the selection `cbd select --change <file>:<line>` would run and,
when that selection is more than the tests listed, prints `select would run N tests:` with each
reason and its count: load observers for a line at module scope, reads, opaque dependencies,
`alwaysSelect`, `emitCheck`. `--format json` carries the same answer as `selection`. A function line
that select answers with exactly the listed tests prints as before.

A bare title that names more than one test is refused; `--file` picks one.

### `cbd stats`

Summarises a map: tests, mapped functions, reached and seen files, untested files, bucket sizes, tests
per test file, functions per file, tests per function, and the widest files. `--format json` prints
the same object.

### `cbd build`

Merges shards into a map. By default it takes the shards under `.cbd/shards` whose header names the
target commit, so a stale shard from an earlier run does not leak into a new map. `--partial` accepts a
shard with no footer (an interrupted run) when that is deliberate.

### `cbd gc`

Keeps the newest `--keep` runs of each kind (default 10) under the state directory, always keeps the
map `select` is using, and touches nothing else in `.cbd`. A run's shards (one per test file for
Jest, Vitest and node:test) are grouped by their run name and kept or removed together; only
directories named like a commit and holding a `map.json` count as maps.

## Typical workflows

**First recording**

```sh
pnpm exec cbd collect -- pnpm test
```

**Inner loop**

```sh
pnpm exec cbd select            # what does my working-tree change reach?
pnpm exec cbd select --since origin/main
```

**CI**

```sh
pnpm exec cbd collect -- pnpm test   # refresh the map for this commit
pnpm exec cbd select --format json   # branch on exit code / parse the subset
```

**Inspect**

```sh
pnpm exec cbd stats
pnpm exec cbd explain src/router.ts:42
```

## Configuration

The CLI reads the same `cbd.config.json` as the library:

```json
{
  "$schema": "./node_modules/@spikedpunch/cbd/cbd.config.schema.json",
  "include": ["src/**", "tests/**"],
  "alwaysAll": ["data/**"],
  "maxAgeCommits": 50,
  "strict": false
}
```

See the [root README](https://github.com/SpikedPunchVictim/cbd#the-config-file) for every key.

## Requirements

Node.js 22+ and `git` on `PATH`. The CLI depends on `@spikedpunch/cbd`; the runner adapter is a
separate package.
