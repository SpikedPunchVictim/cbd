# @spikedpunch/cbd-vitest

The [Vitest](https://vitest.dev) adapter for [CBD](https://github.com/SpikedPunchVictim/cbd). One setup
file turns a normal Vitest run into per-test coverage windows and narrows the run to selected tests.

## Install

```sh
pnpm add -D @spikedpunch/cbd-vitest @spikedpunch/cbd @spikedpunch/cbd-cli
```

Peer dependency: `vitest >=3.2 <6`. Validated on Vitest 3.2, 4.1 and 5.0.

## Setup

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['@spikedpunch/cbd-vitest/setup'],
  },
})
```

This is the complete config change; there are no CBD variables in it. With `CBD_SHARD` unset — a
plain `vitest run` — the setup is inert, so the line can be committed. You normally do not set the
variable: `cbd collect` does.

## Recording and selecting

```sh
pnpm exec cbd collect -- pnpm vitest run
pnpm exec cbd select
```

`cbd collect` sets `CBD_SHARD` and `CBD_COMMIT` for the run (and `CBD_SELECTION` for a subset), then
builds the map.

To record without `collect`, set both variables yourself. `CBD_SHARD` is a **base path**, not a file
the adapter appends to: it writes one shard per spec file beside it, e.g.
`run.math.spec.ts.1a2b3c4d.ndjson`.

```sh
mkdir -p .cbd/shards
CBD_SHARD=.cbd/shards/run.ndjson \
CBD_COMMIT="$(git rev-parse HEAD)" \
pnpm vitest run
pnpm exec cbd build
```

The setup file runs **once per test file**, creating one in-process source and **one shard per file**.
That lets several Vitest workers run in parallel without appending to one another's file, and a worker
killed mid-file leaves a shard with no footer (refused) rather than a corrupted run artifact. The
file's import phase is recorded in `@load`.

Selection is applied by skipping an unselected test in `beforeEach`, before its window opens. Vitest's
`-t` is a regex and arbitrary titles cannot be pasted into one safely. A statically skipped test opens
no window.

A selection that matches no test would skip every test, and Vitest exits 0 for an all-skipped run.
To make that fail, add the reporter; it does nothing unless `CBD_SELECTION` is set:

```ts
export default defineConfig({
  test: {
    setupFiles: ['@spikedpunch/cbd-vitest/setup'],
    reporters: ['default', '@spikedpunch/cbd-vitest/reporter'],
  },
})
```

## Notes

- Identity is the full suite path plus the test name (`outer > inner > adds`), with the file carried
  separately, so same-named tests in one file stay distinct. Vitest 4+ reports `fullTestName`; Vitest
  3 uses the suite chain.
- A failed test's window does not enter the map.
- Disable Vitest's own `@vitest/coverage-v8` during a collection: two coverage sessions on one isolate
  interfere.
- A separately started service is **not collected yet** by this adapter. If `CBD_SOCKET_DIR` is set it
  warns; a change to the service's code therefore escalates to a full run, which is the safe answer.

See [CBD.md](https://github.com/SpikedPunchVictim/cbd/blob/main/CBD.md) for the model and the
[root README](https://github.com/SpikedPunchVictim/cbd#readme) for the CLI and config.
