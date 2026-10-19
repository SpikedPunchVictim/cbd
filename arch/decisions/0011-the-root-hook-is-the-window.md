---
type: Architecture Decision
title: "ADR-0011: The framework's awaited root hook is the window boundary"
description: Record from hooks the runner awaits, not from callbacks it fires and forgets.
status: draft
tags: [adapters, japa, windows]
generated: { by: process:cbd-adr-backfill, at: 2026-10-19T00:00:00Z }
sources:
  - id: a0
    resource: /.explore/A0-japa-hooks.md
    title: The japa 5 hook and emitter facts the adapter rests on
  - id: japa
    resource: /packages/japa/src/adapter.ts
    title: The adapter's window hooks and the emitter
  - id: cbd
    resource: /CBD.md
    title: Section 7.1 — selection and recording with japa
---

# Authors and the team

The spike author, with Claude Code. It is the pattern every framework adapter follows when the
framework does not await its events.

# Context and problem you want to solve

A per-test coverage window is only meaningful if it is opened and closed where the runner actually
asks. japa 5 emits `test:start` and `test:end` from its reporter bus, but **does not await the
listeners**: a handler that awaited a take would return into the runner after the next test had
already started, and one test's execution would be attributed to the next. `Test.executing` and
`Test.executed` are static callbacks called with `forEach` and are not awaited either. The hooks
the runner *does* await are `test.setup`/`test.teardown` and `group.each.setup`/`teardown`,
reachable through `runner.onSuite`, `suite.onGroup`, `suite.onTest` and `group.tap` [^a0].

# Functional and non-functional requirements you want to address

- A window opens before the test's body and closes after it, on the runner's own schedule.
- Nothing CBD does may execute inside the following test's window.
- `@load` (the import phase) and `@teardown` remain distinguishable from `@between`.
- A take that cannot answer in the hook's tick must not block the hook.

# Potential critical user journey (CUJ) the decision impacts

A developer runs a japa suite with a dozen fast tests. If windows are taken from fire-and-forget
events, several tests share one window or a take bleeds into the next, and every change selects
the wrong tests.

# Overview of the key options

1. **Listen to `test:start` / `test:end` and take inside them.** Not awaited; the take runs after
   the runner has moved on.
2. **Use `Test.executing` / `executed`.** Also not awaited, same failure.
3. **Drive the recorder from the awaited hooks**, keeping every per-test handler synchronous; for an
   out-of-process source, dispatch the boundary synchronously and settle the reply later
   (`QueuedSource`).

# Your decision and reasons behind the accepted choice

Option 3 [^japa]. The adapter wraps the awaited setup/teardown hooks so the boundary is crossed in
the runner's own tick, and the Recorder's per-test API is synchronous. A source that cannot answer
in that tick is driven through `dispatch()` — the write is the boundary — and its replies are
drained at `runner:end`, the one event japa awaits.

The reporter emitter is still used, but only for what it is good at: its `test:end` carries the
outcome and file, which is what the record needs. It is not where the boundary is taken.

**Consequences.** The `@load` bucket is captured at the first `testStart`, because the source is
created before the test files are imported; a run with no tests captures it at `runEnd`. Empty
windows are recorded rather than dropped, so a test that runs nothing remains a test that runs
nothing. The same pattern is what a mocha adapter does through its single `run` funnel, and what
the node:test adapter does through its awaited hooks [^cbd].

[^a0]: `.explore/A0-japa-hooks.md` — the awaited-hook map and the `forEach` finding.
[^japa]: `packages/japa/src/adapter.ts` and `plugin.ts`; the `Windows` strategies in
    `packages/core/src/recorder.ts`.
[^cbd]: CBD.md §7.1.
