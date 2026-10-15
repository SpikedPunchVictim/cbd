---
type: Architecture Decision
title: "ADR-0002: Resolve coverage at build time, not in the test window"
description: The shard records byte ranges; every path, line and ordinal lookup happens once, in cbd build.
status: draft
tags: [performance, shard, build]
generated: { by: process:cbd-adr-backfill, at: 2026-10-15T00:00:00Z }
sources:
  - id: b1-measurement
    resource: /IMPLEMENTATION_PLAN.md
    title: Stage B2 — normalize costs 36x what collection does
  - id: a4-finding
    resource: /IMPLEMENTATION_PLAN.md
    title: Stage A4 — the ordinal collision, and its known limitation
  - id: shard-format
    resource: /CBD.md
    title: CBD design document, section 6.3
---

# Authors and the team

The spike author, with Claude Code. Affects the adapter contract, so it reaches every future
framework adapter.

# Context and problem you want to solve

Measuring the pipeline against VS Code's platform scope produced the project's most important
number so far: over ten modules, `takeSync()` costs **3 ms** while `normalize()` costs
**108 ms**. Coverage processing cost 36 times what coverage collection did [^b1-measurement].

The cause is structural rather than a bug. Every window re-reads and re-indexes every file it
touches, re-parses every source map, and re-resolves every function's position — so a function in
a cross-cutting file is resolved once per window it appears in. In a small VS Code run,
`lifecycle.ts` appeared in 284 of 30 windows. The work is `O(windows × functions in window)` when
it should be `O(distinct (script, function))`. Extrapolated across 10,270 scripts and 16,017
windows, this is tens of minutes of overhead on a 104-second suite.

# Functional and non-functional requirements you want to address

- Recording overhead under roughly 10% of `T_full`, against a measured baseline of ~36×.
- The adapter must not execute anything that V8 will attribute to the following test window.
- Ordinals must map one key to exactly one source range within a build.
- The recorded data must still merge across CI shards for one commit.
- No silent under-selection — the unacceptable failure direction.

# Potential critical user journey (CUJ) the decision impacts

The collection run. A developer or CI job records a full suite once, and everything downstream —
selection on every subsequent change — reads the map that run produced. The recording run is the
one place a regression here is paid for on every future change.

# Overview of the key options

1. **Cache `FileCache` and `TraceMap` across windows**, as `OrdinalRegistry` already is. Measured
   ceiling: ~23% of the cost, because the remaining ~83% is the per-function
   `originalPositionFor` lookups. A mitigation, not a fix.
2. **Resolve only executed functions, keeping today's resolved shard format.** Removes the
   redundant per-window work for functions that did not run, but still resolves a
   cross-cutting function once per window, and still leaves ordinal assignment at take time.
3. **Defer resolution to `cbd build`.** The shard records, per window, only the executed
   functions' byte ranges — script id, start offset, end offset — plus a per-script table. No
   paths, no names, no line numbers. Every file read, map lookup and ordinal assignment happens
   once per unique `(script, function)` at build time [^shard-format].

# Your decision and reasons behind the accepted choice

Option 3. It fixes the hot loop by construction rather than by a constant factor, and it closes
three other problems at the same time:

- **Ordinals become stable by construction**, assigned from the union over every window. This is
  the proper fix for the A4 limitation, where first sighting of a script is not always complete,
  so a late-appearing function received an appended ordinal rather than its source-order one —
  and where two anonymous arrows in different windows both became `<anonymous>@0` and merged
  into one bogus function that selected the wrong tests [^a4-finding].
- **Our own work stops being attributed to the following test window.** Today `normalize` runs
  inside the consumer's process between windows; afterwards the only code executing between
  windows is the take.
- **Bytes on disk replace CPU in the hook**, which is the right trade: roughly 150 executed
  functions per window at ~15 bytes each, so ~50 MB for a 16,000-window run, transient.

**Consequences.** Two real costs. The shard is no longer human-readable — byte ranges against a
script id mean nothing without the build — so debugging a bad shard needs a build-side view. And
a new failure mode appears: an offset is only meaningful against the exact bytes it was taken
from, so if the output is re-transpiled between the run and the build, the same offsets point
into different code and attributions go silently wrong, in the under-selecting direction. The
shard must therefore record a per-script content signal and `cbd build` must refuse a shard whose
script no longer matches. Refusing beats guessing, which is the same rule the unreadable-declared-
map fix established.

Shards remain mergeable across machines for a single commit, which is what CI sharding needs.
This couples a shard to its build, which is a correctness improvement — it stops two builds'
maps being merged by accident — and a constraint that must be stated in the docs.

[^b1-measurement]: Stage B2, "the measurement that forces it".
[^a4-finding]: Stage A4, "the bug this stage found is the most serious of the project so far".
[^shard-format]: CBD design document section 6.3 already describes a `file` record for this.
