---
type: Architecture Decision
title: "ADR-0001: Observe execution instead of building a call graph"
description: Selection is driven by what tests actually executed, not by a static call graph.
status: draft
tags: [selection, soundness, dependencies]
generated: { by: process:cbd-adr-backfill, at: 2026-10-15T00:00:00Z }
sources:
  - id: cbd-design
    resource: /CBD.md
    title: CBD design document
  - id: b2-finding
    resource: /IMPLEMENTATION_PLAN.md
    title: Stage B2 — the measurement that forced the resolution change
  - id: jelly
    resource: https://github.com/cs-au-dk/jelly
    title: Jelly — call graph and library usage analyser for JavaScript
---

# Authors and the team

The spike author, with Claude Code. The decision applies to any consumer of the selector.

# Context and problem you want to solve

The goal is to run only the tests a change can affect, which requires answering "which tests
reach this code?" There are two families of answer: *infer* it from the source (a call graph, or
a module graph), or *observe* it (record what actually executed, per test).

# Functional and non-functional requirements you want to address

- **Sound in the one direction that matters.** Never skip a test that would have failed.
  Over-selecting costs minutes; under-selecting costs correctness. These are not symmetric.
- Framework-neutral, language-neutral core, with no dependence on a points-to analyser.
- Must survive the constructs that defeat static analysis: dynamic dispatch, DI containers,
  callbacks, `Event.on`, proxies, string-keyed lookups, dynamic `import()`.
- Selection must be cheap enough to run on every change.

# Potential critical user journey (CUJ) the decision impacts

A developer changes one function in a shared helper and runs the suite. Every test that reaches
that helper must run — including tests that reach it only through three hops of dependency-
injection wiring, and tests that reach it through a callback registered somewhere else entirely.

# Overview of the key options

1. **Static call graph.** `@cs-au-dk/jelly` [^jelly] is the only serious, maintained option;
   `ts-call-graph` and `jscg` are dormant and pinned to abandoned babel/typescript majors. All
   of them describe the TypeScript source, while the program that actually runs is transpiled
   and stripped of type-only imports.
2. **Observed execution**, via V8 precise coverage taken per test window (the design's own
   approach) [^cbd-design].
3. **Hybrid** — coverage for selection, a static graph as an offline audit oracle.

# Your decision and reasons behind the accepted choice

Option 2, with option 3 retained as a possible future audit and option 1 explicitly rejected for
the selection path.

Observation answers a stronger question than inference does. If test `T` runs `A`, and `A` calls
`B`, then `B`'s body executes inside `T`'s window and is attributed to `T`. Transitivity is free,
and it is free for exactly the constructs that make a call graph unsound: there is nothing to
resolve, because nothing is being predicted. On a DI-container codebase such as VS Code — where
the most-reached file in a small recording was the instantiation service — a field-based
points-to analysis degenerates toward "everything calls everything", which is `mode: all` with
extra steps. The reverse also holds and is a feature: a memoised function that a test never
executes is *not* recorded against that test, which is more precise than the call-graph answer.

The cost is the mirror image: observation only sees what ran. Anything outside a window — import
time, trailing async work — cannot be attributed, and the design answers that with escalation to
`mode: all` rather than by guessing. That is the conservative direction, so it is a cost in time
rather than in soundness.

**Consequences.** Selection has no dependency on a points-to analyser, and the core stays small.
The `all`-rate becomes the metric that matters, and it is why `unknownPolicy` is graduated rather
than binary. The one residual miss path is not a call-graph question at all: asynchronous work
that outlives its window and lands in a later one is attributed to the wrong test, which is why
`settleMs` exists and why `cbd verify`'s miss count is the load-bearing measurement [^b2-finding].

[^jelly]: Jelly — call graph and library usage analyser for JavaScript.
[^cbd-design]: CBD design document, sections 2 and 8.
[^b2-finding]: Stage B2 records the reasoning; the miss count is Stage B1's decision gate.
