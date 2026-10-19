---
type: Architecture Decision
title: "ADR-0008: Correlate an out-of-process request by id, at the instrument"
description: A test window names itself, the service instrument reads that name from an HTTP header and takes a tagged window at each request boundary, and the recorder credits the delta to the test that sent it; anything unmatched stays @between and escalates.
status: draft
tags: [attribution, integration, http, correlation]
generated: { by: agent:claude-code, at: 2026-10-18T08:00:00Z }
sources:
  - id: cbd-design
    resource: /CBD.md
    title: CBD design document
  - id: integration-plan
    resource: /IMPLEMENTATION_PLAN.md
    title: Phase C, the I1-I5 scenario table
  - id: correlate
    resource: /packages/core/src/correlate.ts
    title: Correlator and the test-side HTTP injection
  - id: instrument
    resource: /packages/core/src/instrument.ts
    title: The injected module and its request-boundary takes
  - id: socket-source
    resource: /packages/core/src/source/socket.ts
    title: The take reply, its tags, and the correlate op
  - id: recorder
    resource: /packages/core/src/recorder.ts
    title: Turning tagged coverage into test records
---

# Authors and the team

The author, with Claude Code. Applies to the injected instrument, the socket source, the
recorder, and any adapter that records a suite driving a separately started service.

# Context and problem you want to solve

ADR-0005 and ADR-0007 attribute a service's execution **by time**: the collector dispatches a
take at each test boundary, and whatever the service ran while that window was open is credited
to the test whose window it was. That is exact when a test awaits its request and wrong in the
direction this project treats as unacceptable when it does not. A request still in flight at
`testEnd`, or one whose response arrives during the next test, lands in whichever window happens
to be open. The fixture that demonstrates it (`straddle`) was built to measure precisely this:
the service answers, then keeps working, and the work is credited to a test that drove nothing.

Phase C's I2 row names the fix — "request-id header" — and leaves the mechanism open.

# Requirements

- **No new `createCbd` verb** (ADR-0003). Correlation is a source capability and a recorder
  attribution rule, not a product surface.
- **Framework-neutral.** Express, Fastify, Koa and a bare `createServer` must all be covered,
  and no per-framework middleware may be required of the consumer.
- **Never under-select.** An id the collector cannot resolve must become `@between`, which
  §8.3 escalates, never be dropped.
- **Never take the host down.** The instrument is a guest (ADR-0005); a correlation bug must
  not turn a request into an exception.
- **The uncorrelated path is unchanged.** A run with no service, or one that opts out, must
  record exactly what it recorded before.

# Critical user journey

A japa suite starts a service before the run, sends it a request without awaiting the response,
and ends the test. The next test sleeps; the service finishes the request during it. With
correlation, `cbd select` names the first test for a change to the service handler. Without it,
it names the second — a test that never drove that code, and that will fail for want of the work
the first test did.

# Options considered

**A. A service-side middleware.** Small and explicit, but one adapter per framework, and it
only covers requests that pass through the middleware the consumer installed. Rejected: it
makes the product's coverage depend on the consumer naming their framework.

**B. The instrument patches `http.Server`.** Every framework built on Node's HTTP server arrives
through the `request` event, so the hook is below all of them. It can take coverage at the
request's start and end, tag the delta with the ids in flight, and carry those ids back on the
take reply. Larger, and it must be written under the guest rules; chosen.

**C. The test declares the ids it sent.** The simplest contract, but it asks test authors to
edit every request, or the adapter to wrap their client — which is B plus a coarser join.
Rejected as a starting point, though B's recorder rule (unknown id → `@between`) is exactly C's
safety property.

With B, the id still has to reach the request. The adapter could ask the test to set a header
(C again), or the **recorder can put it on outgoing `http`/`https`/`fetch` calls while its
window is open**. The latter is seamless and is the only global side effect correlation adds;
it is installed by the plugin and released at `runner:end`.

# Decision and reasons

**Three pieces, all in the adapter tier.**

1. **`Correlator` names a window.** `begin(title, file)` returns `<pid>-<n>` and remembers the
   owner; `end()` closes it. The plugin installs the client patch, which adds
   `x-cbd-correlation` only when a window is open and never overwrites a header the caller set.
2. **The service instrument takes at request boundaries.** An opt-in env
   (`CBD_CORRELATION_HEADER`) turns the hook on at start-up; a `correlate` op turns it on for a
   service that was already running. `http.Server.prototype.emit` is patched for `'request'`;
   the response's `finish`/`close` closes the window. Each delta carries the **set** of ids that
   were in flight, because one V8 counter cannot be split between concurrent requests —
   attributing to the set over-selects, picking one guesses.
3. **The recorder credits by id.** `TakeResult.ids` describes the ordinary window (so another
   test's boundary that took a request's work still credits its sender); `TakeResult.requests`
   carries the request-boundary deltas. The recorder writes each as an ordinary `test` record
   for the owner. **No shard or map format change** is needed: `buildMap` already unions test
   records by title and file.

**Why the instrument and not a middleware.** The consumer's framework is not the product's
concern, and `http.Server` is the one seam every Node framework shares. The cost is that HTTP/2
servers and clients that bypass the `http` module (a raw `undici` dispatcher) are not covered;
that is named in `correlate.ts` and falls back to the time-based attribution that already
existed.

**Why the take reply and not a side channel.** ADR-0007's recovery rule is that a reply that
never arrived is found again by take id. A tagged window that arrived on a different channel
could not be recovered with it, so `ids` and `requests` are kept on the unacknowledged window in
the snapshot. A process that dies before any reply keeps its queued request windows in the
snapshot's `pendingRequests`, which the unnumbered fallback reads.

**Two measured costs, and what was done about them.**

- *The first take got heavier.* The instrument initially imported `correlate.ts`, and with it
  `https`/`tls`, into every service. On the straddle fixture the expensive first take visibly
  grew, and that fixture gates on drift. The wire constants moved to `instrument-protocol.ts`
  (no runtime imports) so the instrument loads `http` alone.
- *A spawned service could miss the correlate op by a test.* The collector configures an
  already-running service with an op; a service a test spawns used to get that op only when the
  re-scan attached, and on a fast suite the request could precede it. The plugin now exports
  `CBD_CORRELATION_HEADER` to the runner's environment before tests run, so a child inherits
  correlation and installs it at start-up. `HelloResult.correlating` lets the collector skip
  the op for such a service, which also removes a round trip from the attach path.

**`CBD_CORRELATION=off` exists** because correlation is a different measurement as well as a
different mechanism: it adds a take per correlated request, so the straddle fixture — whose
whole subject is the time-based boundary's drift — turns it off. The request-id path is
asserted in `packages/cli/tests/scenarios-e2e.spec.ts` instead.

**A flaky gate was replaced with a stable one.** `straddle` asserted `maxUs < minGapUs`; measured
on the same machine, the pre-existing baseline records occasional 3–12 ms maxima at window 4 and
later (a descheduled loop) and failed roughly half the time under load. The test now asserts on
`meanUs`, which is the steady-state cost the design claims, and the footer still carries
`maxUs` for a human.

# Consequences

- I1 (in-process) needs nothing new; I2 (out-of-process request/response) is exact for sequential
  traffic and over-attributes under concurrency; I3 (workers) is the re-scanning source with
  multiple targets, unchanged; I4 (queue/async, no boundary) remains the honest limit — the work
  lands in a bucket and a change to it escalates.
- A consumer that sets its own correlation header on a request keeps it; the adapter supplies
  one only when absent.
- The `@between` bucket remains the answer for any tagged window whose id the run does not own,
  which is what makes a stale id or another client's traffic safe rather than invisible.
