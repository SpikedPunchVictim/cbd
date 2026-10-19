# @spikedpunch/cbd-mocha

The [mocha](https://mochajs.org) adapter for [CBD](https://github.com/SpikedPunchVictim/cbd). One
preload turns a plain mocha run into per-test coverage windows and applies a selection with no edits to
test files.

## Install

```sh
pnpm add -D @spikedpunch/cbd-mocha @spikedpunch/cbd @spikedpunch/cbd-cli
```

Tested against mocha 10.

## Setup

Preload the module in the `test` script:

```json
{
  "scripts": {
    "test": "NODE_OPTIONS=\"--import @spikedpunch/cbd-mocha/auto\" mocha"
  }
}
```

Or on the command line:

```sh
NODE_OPTIONS="--import @spikedpunch/cbd-mocha/auto" npx mocha
```

With `CBD_SHARD` unset the preload is inert for recording, and with `CBD_SELECTION` unset it does not
narrow, so the script is safe to commit.

## Recording and selecting

```sh
pnpm exec cbd collect -- pnpm test
pnpm exec cbd select
```

`cbd collect` sets `CBD_SHARD` and `CBD_COMMIT` for the child run (and `CBD_SELECTION` for a subset),
then builds the map. Recording and selection are independent: either variable can be used alone.

The preload patches `Mocha.prototype.run`; root hooks added there still bind every test because mocha
reads them when each test runs, not when the suite is built. Windows are the awaited
`beforeEach`/`afterEach` events. One shard is written per mocha process.

Selection becomes mocha's own `grep`: the selected titles are escaped and joined into one anchored
pattern, so a title containing regex characters is still exact. A selection replaces a `--grep` the
command line named, because the selection was computed from the map and a second filter could only
remove tests.

## Manual wiring

Embedders can drive the pieces directly instead of using `/auto`:

```ts
import { installMochaAdapter, beginShard, mochaWindowHooks } from '@spikedpunch/cbd-mocha'
```

`installMochaAdapter` applies the root hooks to a mocha runner, `beginShard` opens the recorder, and
`mochaWindowHooks` exposes the test-start/end pair. Most projects should use `/auto`.

## Notes

- Test identity is the full title (`describe > describe > test`) plus the file.
- Statically skipped tests open no window.
- Failed tests do not enter the map (their windows are not trusted as green).

See [CBD.md](https://github.com/SpikedPunchVictim/cbd/blob/main/CBD.md) for the model and the
[root README](https://github.com/SpikedPunchVictim/cbd#readme) for the CLI and config.
