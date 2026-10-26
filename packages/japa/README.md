# @spikedpunch/cbd-japa

The [japa](https://japa.dev) adapter for [CBD](https://github.com/SpikedPunchVictim/cbd). It turns a
plain japa run into per-test coverage windows, and narrows a run to the tests a change reaches.

## Install

```sh
pnpm add -D @spikedpunch/cbd-japa @spikedpunch/cbd @spikedpunch/cbd-cli
```

Peer dependency: `@japa/runner >=5 <6`.

## Setup

Add the plugin to the `configure` call you already have:

```js
import { configure, processCLIArgs, run } from '@japa/runner'
import { cbd } from '@spikedpunch/cbd-japa'

processCLIArgs(process.argv.slice(2))
configure({
  files: ['tests/**/*.spec.js'],
  plugins: [cbd()],
})
await run()
```

With `CBD_SHARD` unset the plugin is inert, so the line can be committed and ordinary runs are
unaffected. `cbd collect` sets the variable for the run it spawns:

```sh
pnpm exec cbd collect -- pnpm test
```

## Recording

The plugin installs japa's test-start/test-end hooks and writes shard records to `CBD_SHARD`. japa
exposes its emitter to plugins directly, so no patching and no `/auto` entry is needed.

### Code your entry imports before the plugin

The plugin starts recording when japa installs it, inside `configure`. Anything your `bin/test.ts`
imports above that line (a shared test-kit, a config module) has already run, so it never reaches the
map, and a change to it is an unknown file that runs the whole suite. The `register` preload starts
recording earlier:

```sh
NODE_OPTIONS="--import @spikedpunch/cbd-japa/register" pnpm exec cbd collect -- pnpm test
```

Keep `plugins: [cbd()]` in `configure`: the plugin joins the session the preload started rather than
starting a second one, and what ran before the first test is recorded as load-time execution. The
preload is inert when `CBD_SHARD` is unset. Shard, commit and scan settings come from the environment
when the preload is used; the same options passed to `cbd()` do not apply to its session.

### A service the suite drives

When `CBD_SOCKET_DIR` is set, the plugin records the instrumented service as well as the test process,
and writes its windows to a sibling `*.service.ndjson` shard. The service is instrumented by running it
with CBD's module:

```sh
NODE_OPTIONS="--import @spikedpunch/cbd/instrument" \
CBD_SOCKET_DIR=/tmp/cbd-sockets \
node server.js
```

A configured service that cannot be reached is an **error**, not a silent skip: a map that omits the
server would escalate every server-side change to a full run, and skipping quietly reproduces exactly
the problem CBD exists to avoid.

Deployed copies (a lane, a container image) can be mapped back to the checkout with
`CBD_RELOCATE_FROM` / `CBD_RELOCATE_TO`, so the map is keyed by repository paths.

## Selection

`CBD_SELECTION` (a JSON file `{ "titles": string[] }`) narrows the run to those bare japa titles;
`cbd collect` writes it before spawning the run. You can also pass titles explicitly:

```js
configure({ plugins: [cbd({ only: ['adds two numbers'] })] })
```

An explicit `only` wins over the environment. Recording and selection are independent: selection can
run without recording, and recording without selection.

## Options

```ts
cbd({
  enabled: true,        // false makes the plugin a no-op without removing it
  shard: process.env.CBD_SHARD,
  commit: process.env.CBD_COMMIT,
  scan: undefined,      // advanced: projection/relocation/filter rules
  only: undefined,      // bare japa titles to run
})
```

## Notes

- Test identity is the suite path plus the test name (`outer > inner > adds`) and the file, so two
  same-named tests in one file stay distinct.
- A statically skipped test opens no window.
- Selection titles are bare japa titles; a fully qualified title matches nothing in japa's filter.

See [CBD.md](https://github.com/SpikedPunchVictim/cbd/blob/main/CBD.md) for the window model and
safety rules, and the [root README](https://github.com/SpikedPunchVictim/cbd#readme) for the CLI and
config.
