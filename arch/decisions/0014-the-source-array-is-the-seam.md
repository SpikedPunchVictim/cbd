---
type: Architecture Decision
title: "ADR-0014: The source array is the integration seam"
description: The core records from a list of sources; framework and transport are adapter concerns.
status: draft
tags: [adapters, sources, architecture]
generated: { by: process:cbd-adr-backfill, at: 2026-10-19T00:00:00Z }
sources:
  - id: types
    resource: /packages/core/src/types.ts
    title: Source and QueuedSource — the seam's whole surface
  - id: cbd
    resource: /CBD.md
    title: Section 4 — sources and section 7 — adapters
  - id: adr7
    resource: /arch/decisions/0007-a-service-the-suite-starts-itself.md
    title: A service the suite starts itself
---

# Authors and the team

The spike author, with Claude Code. It is the boundary that keeps the core framework-neutral.

# Context and problem you want to solve

One recorded run can have more than one place where code executes: the test process itself, a
service started separately, and services a test starts mid-run. The transport differs — an in-process
inspector session, a unix socket, a debugger URL — and so does the timing: an in-process source can
take in the tick a test ends, a socket cannot. The core must record all of it with one bookkeeping
path and no knowledge of japa, mocha, HTTP or sockets.

# Functional and non-functional requirements you want to address

- The core must not import a framework or a transport.
- One set of window boundaries must drive every source of a run.
- A source that cannot answer synchronously must still be recordable.
- Script tables and coverage from every source must resolve through the same path pipeline.
- The seam must be small enough to implement outside this repository (a harness writing a shard).

# Potential critical user journey (CUJ) the decision impacts

A team runs a japa suite that drives a separate key server. Both processes' execution must land in
one map, attributed to the same tests, without the core learning what japa or the server is.

# Overview of the key options

1. **A recorder per framework/transport.** Duplicates the window bookkeeping, which is the part
   that must not exist twice; a drift between copies misfiles a phase.
2. **The core knows about sockets and frameworks.** Fast to write, and makes every new runner a
   core change.
3. **A `Source` interface** (`takeSync`, `take`, `scripts`, `close`; `QueuedSource` for
   dispatch-then-settle) and a recorder that holds a list of them and takes all at each boundary.

# Your decision and reasons behind the accepted choice

Option 3 [^types]. Adapters compute a test identity, create the sources a run needs and drive the
Recorder at the runner's awaited hooks (ADR-0011). The core takes every source at each window, in
parallel where one is queued. The *sources array* — the list of processes a run recorded — is also
what the protocol/snapshot reports, so a reader can see where the coverage came from [^cbd].

A source that can do neither a synchronous take nor a dispatchable boundary is refused at
construction: the failure it would otherwise produce (every window empty, a well-formed map
claiming no test reaches anything) is the one mistake that reads as a confident answer.

**Consequences.** A new transport is a new `Source`, not a core change; the same adapter contract
is exercised by in-process, socket and rescanning sources in the adapter e2e. Cross-source
attribution is the hard part and lives in two later decisions: an out-of-process request is
attributed by id (ADR-0008), and work a suite leaves running between windows escalates rather than
being guessed at (ADR-0007).

[^types]: `types.ts` — `Source`, `QueuedSource`, `PendingTake`, `V8ScriptCoverage`.
[^cbd]: CBD.md §4 and §7.
