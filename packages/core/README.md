# @spikedpunch/cbd

The framework-neutral core of [CBD](https://github.com/SpikedPunchVictim/cbd): it turns recorded test
windows into a per-commit **coverage map**, diffs a change against that map, and answers which tests
a change can affect.

Most projects use the [`cbd` CLI](https://www.npmjs.com/package/@spikedpunch/cbd-cli) or a runner
adapter. This package is the library underneath both:

- the map model and its queries (functions, lines, tests, buckets, statistics);
- `createCbd`, the stable API: `build`, `select`, `explain`, `reaches`, `stats`, `verify`;
- the shard parser and build-time resolution;
- the adapter seam (`@spikedpunch/cbd/adapter`) used by the framework adapters.

## Install

```sh
pnpm add -D @spikedpunch/cbd
```

You also need an adapter for your test runner and, normally, the CLI. See the
[root README](https://github.com/SpikedPunchVictim/cbd#packages).

## Library use

```ts
import { createCbd } from '@spikedpunch/cbd'

const cbd = createCbd({ root: process.cwd() })

// A map must exist first: `cbd collect` records one, or build one from shards.
const { selection, selected, map } = cbd.select({ since: 'origin/main' })

if (selection.mode === 'all') {
  console.error('run everything:', selection.reasons)
} else {
  for (const test of selected) console.log(test.title)
}
```

`select` diffs the map's commit against the working tree by default, and returns:

- `selection.mode` — `subset` or `all`;
- `selection.tests` — indices into the map;
- `selected` — the resolved `{ title, file }` entries;
- `selection.reasons`, `unmapped`, `untested`, `warnings` — why, in data;
- `map` — the commit, age, path and shard list the answer came from.

Options: `since` (default: the map's commit), `worktree` (default `true`), `strict`, `commit`.
Selection rules (`include`, `alwaysAll`, `unknownPolicy`, `betweenPolicy`, `maxAgeCommits`, …) live in
`select`'s config and are usually loaded from `cbd.config.json` with `loadConfig`.

### Verbs

| Verb | Answer |
| --- | --- |
| `build(options?)` | Merge the commit's shards into `.cbd/maps/<commit>/map.json`. |
| `select(options?)` | Which tests the change reaches: `subset` or `all` with reasons. |
| `explain(target)` | For a file or line: its functions and the tests that reach them. |
| `reaches(test, target)` | The inverse: does one test reach this file or line? |
| `stats(options?)` | Map size, untested files, tests per file/function, widest files. |
| `verify(selection, changes, outcomes)` | Pure check of a selection against supplied outcomes. |

```ts
const build = cbd.build({ commit: 'HEAD' })
const stats = cbd.stats()
const answer = cbd.explain('src/router.ts:42')
const inverse = cbd.reaches('handles a refund', 'src/payments.ts', { file: 'tests/refund.spec.ts' })
```

## Recording

The core does not run a suite. Two things feed it:

1. **An adapter** for your runner. Adapters translate lifecycle events into `Recorder` windows and
   write shards; they live in `@spikedpunch/cbd-japa`, `-mocha`, `-vitest`, `-jest` and `-node-test`.
2. **The instrument module**, for code in another Node process (a server the tests drive):

   ```sh
   NODE_OPTIONS="--import @spikedpunch/cbd/instrument" \
   CBD_SOCKET_DIR=/tmp/cbd-sockets \
   node server.js
   ```

   The instrument answers `take` requests over the socket named by `CBD_SOCKET_DIR`. The japa adapter
   records it automatically when that variable is present. Deployed copies can be mapped back to the
   checkout with `CBD_RELOCATE_FROM` / `CBD_RELOCATE_TO`.

State lives under `.cbd/` by default: `shards/<run>.ndjson` and `maps/<commit>/map.json`.

## Adapter authors

`@spikedpunch/cbd/adapter` is the Tier 2 seam:

```ts
import {
  Recorder,
  FileSink,
  inProcessSource,
  parseShard,
  resolveShard,
  scanFromEnv,
  readSelection,
} from '@spikedpunch/cbd/adapter'
```

It exports the sources (`inProcessSource`, socket and inspector sources), the recorder and sinks, the
shard parser/resolver, the normalizer, projection/relocation helpers, and the environment readers.
**This surface is explicitly unstable**; the stable contract is the package root.

## Safety

The core refuses to guess:

- a changed file the map has not seen escalates to `mode: all`;
- a shard whose recorded bytes no longer match the file is refused (`StaleShardError`);
- a failed test's window does not enter the map;
- `@between` and `@teardown` activity is unattributable and runs everything unless configured
  otherwise;
- stale or dirty maps warn, and escalate under `strict`.

## Documentation

- [CBD.md](https://github.com/SpikedPunchVictim/cbd/blob/main/CBD.md) — the design and the selection
  rules.
- [arch/decisions](https://github.com/SpikedPunchVictim/cbd/tree/main/arch/decisions) — the ADRs.
- [Root README](https://github.com/SpikedPunchVictim/cbd#readme) — setup for every runner.
