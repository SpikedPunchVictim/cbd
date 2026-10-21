# 0017 — Adapter contract: ids, the record API, and the window boundary

**Status:** draft
**Date:** 2026-10-20

## Context

Selection crossed the adapter seam as bare titles: `cbd collect` wrote
`{"titles": [...]}` and the japa plugin filtered on them. That works for a serial
japa suite with unique titles and fails, in ways that only show up in a real
repository, for renames, duplicate titles, titles built from templates, and every
runner that does not filter exactly as japa does. Consumer test helpers also had no
way to say "this test depends on this file" when coverage cannot see the
dependency (a source grep, a `tsc` run, a spawned tool), so consumers kept
hand-written always-run lists.

The roadmap asked for a runner-neutral contract: stable IDs, lifecycle hooks, a
record API, and results reported back. It also proposed an `AsyncLocalStorage`
context owned by cbd, which is where this record departs from it.

## Decision

**1. Identity is `file::title`.** `testId(file, title)` is canonical; an adapter
reports a `TestRef` with `id`, `file`, `title`, and — when the runner exposes them
— a `titlePath` and a definition site. The definition site is deliberately **not**
part of the id: a line number changes when unrelated code above the test moves, and
a selection must not break then. Where two tests genuinely share a title in one
file, selection by title runs both; the existing ordinal disambiguates their
coverage, and over-selection is the safe direction.

`titlePath` is optional because japa exposes a bare title and a flattened suite
path, not an array. Splitting the flattened path on a separator would mis-split
any title containing it, so the contract defaults the path to `[title]` instead of
inventing one.

**2. The selection file is v2 and adapter-neutral.** It carries `{version: 2,
tests: [{id, file, title, titlePath?, line?, column?}]}`. `cbd collect` writes it;
`readSelection` still derives titles, so an adapter that can only filter by title
is unaffected, and a v1 `{titles}` file is still read. A malformed v2 entry is an
error, never a silent fall back to "no filter".

**3. There is no ALS test context.** None of the supported runners lets a *plugin*
wrap the test body: japa emits events around a function it invokes itself, and the
other adapters sit in the same place. An `AsyncLocalStorage` context established in
a `beforeEach` does not reliably survive into the runner's own invocation of the
test. The boundary adapters already report — start, end — stays the source of
truth, and record calls are attributed to the open window. This is sound for the
supported suites: japa and `node:test` are serial, mocha is serial, Jest runs test
files in workers, and Vitest runs files in workers with concurrency only via its
opt-in `concurrent` API. An adapter for a runner that overlaps tests by default
must serialize windows or decline to record, and the contract version is how it
says which it implements.

**4. The record API is plain functions.** `recordRead`, `recordDirRead`,
`recordDependency` and `recordOpaque` take paths and reasons, no runner context and
no test id. A recorder registers itself while its window is open; calls outside
every window are ignored. That is safe: an unrecorded dependency leaves its file
unknown to the map, which escalates to `all`. `recordOpaque` marks a test as
selected by any in-scope change and is the honest fallback when no path can be
named (a spawned tool, a driven service).

**5. Results ride the shard and the map.** Status and duration were already on the
shard test record; the map now keeps them on the test entry. This is the basis for
the subset cost estimate, and it is what "results reported back" means here: no
second channel.

**6. The contract is versioned separately.** `ADAPTER_CONTRACT_VERSION` is exported
from the package root and the adapter entry; `cbd --version --format json` reports
it. An incompatible change bumps it.

## Consequences

- Adapters keep working unchanged; the new fields are optional, and titles remain
  derivable from a v2 file.
- `recordRead` from spec-import time is not attributed. The spec's identity is not
  visible to core, and an adapter cannot open a context around the import. Such a
  helper must be called inside a test, or the test needs `alwaysSelect`; this is
  stated in the API's documentation.
- Consumers get IDs in `cbd select --format json`, in the selection file, and in
  `explain`; later features (incremental recording, `--emit-selection`, batch
  `reaches`) build on them.
- A future adapter that can wrap test bodies may add an ALS context *inside* the
  adapter and call `activateRecordSink` around it; no API change is needed, because
  the record API does not name the context.
