# @spikedpunch/cbd-jest

The [Jest](https://jestjs.io) adapter for [CBD](https://github.com/SpikedPunchVictim/cbd). A custom
test environment records per-test coverage windows, and a config helper turns a selection into Jest's
own name filter.

## Install

```sh
pnpm add -D @spikedpunch/cbd-jest jest-environment-node @spikedpunch/cbd @spikedpunch/cbd-cli
```

Peer dependencies: `jest >=29 <31` and `jest-environment-node >=29 <31`. Validated on Jest 29.6 and
30.5.

## Setup

```js
// jest.config.cjs
const { withCbd } = require('@spikedpunch/cbd-jest/config')

module.exports = withCbd({
  testEnvironment: '@spikedpunch/cbd-jest/environment',
})
```

- `testEnvironment` records windows (one environment and one shard per test file).
- `withCbd` applies `CBD_SELECTION` as an anchored `testNamePattern`. Without it, recording still
  works but the run is not narrowed. Without `CBD_SELECTION` the config is returned unchanged.

Both can live in a committed config: with `CBD_SHARD` and `CBD_SELECTION` unset they are inert.

## Recording and selecting

```sh
pnpm exec cbd collect -- pnpm jest
pnpm exec cbd select
```

`cbd collect` sets `CBD_SHARD` and `CBD_COMMIT` for the run (and `CBD_SELECTION` for a subset), then
builds the map.

Jest creates one environment per test file, and `setup()` is awaited before the file is evaluated, so
the file's imports land in `@load` and `teardown()` writes the footer. Windows are the awaited
`test_start` / `test_done` events. Identity is the enclosing `describe` names plus the test name, with
Jest's synthetic `ROOT_DESCRIBE_BLOCK` omitted.

## Why selection lives in the config

Jest's `testNamePattern` is the only filter that sees a fully expanded test name, including
`test.each` / `describe.each` rows. The config is loaded before the run, which is early enough to read
the selection file. A setup-file wrapper cannot do this: `.each` rows bypass it, and silently skipping
a selected row is the failure CBD does not accept. Titles are escaped and joined into one alternation
(` > ` becomes whitespace), anchored so `Should throw` does not also match `Should throw 2`.

## Notes

- Test identity is the suite path plus the test name; same-named tests in different `describe` blocks
  stay distinct.
- Statically skipped and todo tests open no window.
- A failed test's window does not enter the map.
- Jest's own `--coverage` must be off during a collection.

See [CBD.md](https://github.com/SpikedPunchVictim/cbd/blob/main/CBD.md) for the model and the
[root README](https://github.com/SpikedPunchVictim/cbd#readme) for the CLI and config.
