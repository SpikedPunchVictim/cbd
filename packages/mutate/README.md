# @spikedpunch/cbd-mutate

**Generic mutation-test selection.** Given a mutant at a source file and line, answer which tests
can observe it, using a [CBD](https://github.com/SpikedPunchVictim/cbd) coverage map.

This package deliberately contains **no mutation engine and no test-framework integration**. A
mutation driver owns generating and applying mutants, building, restarting services, running tests
and reporting. CBD owns the expensive selection question. That keeps it usable from a project's own
mutation script, a custom harness, or any other runner — no Stryker dependency.

## Install

```sh
pnpm add -D @spikedpunch/cbd-mutate @spikedpunch/cbd
```

You need a CBD map for the base commit. Record a green, full run first:

```sh
cbd collect --no-select -- <your test command>
```

## CLI

```sh
cbd-mutate select --file src/payments.ts --line 42
cbd-mutate select --file src/payments.ts --line 42 --end-line 44 --format json
```

```json
{
  "mode": "subset",
  "why": "function",
  "titles": ["refunds an overpayment", "rejects a negative refund"],
  "tests": [
    { "title": "refunds an overpayment", "file": "/repo/tests/refund.spec.ts" },
    { "title": "rejects a negative refund", "file": "/repo/tests/refund.spec.ts" }
  ]
}
```

Options: `--root`, `--state-dir` (default `.cbd`), `--commit` (default the nearest map to `HEAD`),
`--between-policy all|ignore`, `--unknown-policy all|ignore`, `--format text|json`.

Modes:

- `subset` — candidate tests. **A mutant is killed when any one of them fails.** The candidates are
  a superset: the map records which functions a test executed, not which branch, so some candidates
  will pass. Requiring every candidate to fail is wrong.
- `all` — the map cannot place the mutant (`load`, `between`, unknown file); run the whole suite.
- `none` — no test reaches it (`untested`, or a test file); report no coverage.

## Library

```ts
import { mutantTests } from '@spikedpunch/cbd'
// or from '@spikedpunch/cbd-mutate'

const selection = mutantTests(map, { file: 'src/payments.ts', startLine: 42 }, { root })
if (selection.mode === 'all') runEverything()
else if (selection.mode === 'subset') run(selection.tests.map((test) => test.title))
```

## Example: an existing mutation driver

Suppose a project's own mutation script (say `mutate.mjs`) already owns mutant specs, builds, lane restarts and kill verification.
Integration is a selection at the spec level, not a new runner:

- a row may carry `select: { "file": "src/x.ts", "line": 42 }` (the **source** location, even when
  the mutant is applied to `dist/`);
- the script calls `cbd-mutate select … --format json` for that row (or the library directly);
- it baselines the candidates, runs them after applying the mutant, and records a kill when **any**
  candidate fails; the named killers become the subset that actually died.

See [ADR-0016](https://github.com/SpikedPunchVictim/cbd/blob/main/arch/decisions/0016-mutation-selection-is-generic.md) for the integration
contract and the current blockers.

## Transformed scripts

Vitest, Jest and ts-node compile in memory, so V8's offsets index generated text rather than the
source file. The shard records that text's line starts (an end-of-run `generated` update on the
script row) and the build resolves through them (`cbd-x2j`). Plain-JavaScript scripts and
untransformed builds keep the file index and record nothing extra. A service running an instrument
older than the `generated` op falls back to the file; selection remains safe but may be
over-conservative for transformed code.

## Fixtures

`fixture/` (Vitest/TypeScript) and `fixture-nt/` (`node:test`/JavaScript) are small projects used to
record maps and exercise the selector during development. They are not part of the package's runtime.
