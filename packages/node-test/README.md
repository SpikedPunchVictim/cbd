# @spikedpunch/cbd-node-test

The [`node:test`](https://nodejs.org/api/test.html) adapter for
[CBD](https://github.com/SpikedPunchVictim/cbd). A preload module records one coverage shard per test
file and narrows the run to the tests a change reaches.

## Install

```sh
pnpm add -D @spikedpunch/cbd-node-test @spikedpunch/cbd @spikedpunch/cbd-cli
```

Requires **Node.js 22+**, the core's minimum (the adapter itself needs `TestContext.fullName` / `filePath`, from 20.16).

## Setup

```sh
node --import @spikedpunch/cbd-node-test/register --test
```

With `CBD_SHARD` unset the preload is inert for recording, so the command can be committed and normal
runs are unaffected. Both ESM and CommonJS test files work.

## Recording and selecting

```sh
pnpm exec cbd collect -- node --import @spikedpunch/cbd-node-test/register --test
pnpm exec cbd select
```

`cbd collect` sets `CBD_SHARD` and `CBD_COMMIT` for the child run (and `CBD_SELECTION` for a subset),
then builds the map.

`node:test` runs each test file in its own child process by default, and the preload runs **before the
file is evaluated** — so each file gets one in-process source and one shard, and its import phase
lands in `@load`. Windows are the global `beforeEach` / `afterEach` hooks; the file's `after` hook
writes the footer.

Identity is `t.fullName` (`outer > inner > adds`), with `t.name` as a fallback on older Node. Status is
`t.passed`, which is true only after a passing body; anything else is failed. A `t.skip()` or
`t.todo()` called inside a body leaves `passed` true, so the adapter tracks those calls and records
the window as skipped.

## Selection

`node:test` has no runtime skip that stops a test body, the parent runner never loads user preloads,
and the child's harness reads its options before the preload runs. The adapter therefore re-executes
each test file once with `--test-name-pattern` and inherits the child's stdout, where the parent runner
expects TAP. The cost is one extra process per test file during a subset run.

- The pattern uses the runner's spelling: parts joined by single spaces, not CBD's ` > `.
- A `--test-name-pattern` the caller already set is left alone, with a warning; running more tests than
  selected is the safe direction.
- `--test-isolation=none` cannot produce a shard per file or re-execute a child, so the adapter warns
  and records nothing (the existing map stands; a changed file escalates).

## Notes

- Statically skipped tests reach no hook and open no window.
- A test registered `{ todo: true }` reaches the hooks without a marker; it is recorded as passed with a
  hooks-only window, which can only over-select.
- A failed test's window does not enter the map.

See [CBD.md](https://github.com/SpikedPunchVictim/cbd/blob/main/CBD.md) for the model and the
[root README](https://github.com/SpikedPunchVictim/cbd#readme) for the CLI and config.
