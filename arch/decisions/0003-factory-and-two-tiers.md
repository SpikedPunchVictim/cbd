---
type: Architecture Decision
title: "ADR-0003: One factory, five verbs, two tiers"
description: createCbd(config) returns build/select/explain/stats/verify; adapters live behind a separate export.
status: draft
tags: [api, developer-experience, integration-testing]
generated: { by: process:cbd-adr-backfill, at: 2026-10-15T00:00:00Z }
sources:
  - id: cbd-cli
    resource: /CBD.md
    title: CBD design document, section 9.2 — the designed CLI surface
  - id: sources-interface
    resource: /CBD.md
    title: CBD design document, section 4.1 — settings for every source
---

# Authors and the team

The spike author, with Claude Code. This is the surface every consumer touches, so it is the
decision with the longest expected life.

# Context and problem you want to solve

The project must grow from unit tests into integration tests, where the code under test runs in a
different process from the test runner. The obvious risk is that each new capability adds a verb,
a flag or an entry point, and the surface grows until nobody can describe it. The question put
directly was whether the API landscape can stay small and easy while that expansion happens.

# Functional and non-functional requirements you want to address

- A developer should be able to describe the whole API from memory.
- Adding integration-test support must not add a verb.
- The CLI, any future MCP server, and library callers should share one implementation rather than
  three divergent ones.
- The core library must stay framework- and language-neutral, and must not gain process-spawning
  responsibilities.

# Potential critical user journey (CUJ) the decision impacts

A developer who has never seen CBD wants to know why a test is being selected, or which tests
reach a given line. That must be one call with an obvious name, not a configuration exercise.

# Overview of the key options

1. **Free functions with an explicit `loadConfig`.** Best tree-shaking and the simplest mental
   model, but configuration is passed at every call, which invites divergence between call sites.
2. **A single factory, `createCbd(config)`,** returning an object of verbs. Config is bound once,
   which makes the "one config file" rule structural rather than conventional, and makes the
   object easy to inject in tests. Tree-shaking is worse, which is irrelevant for a Node CLI and
   library that is never bundled into a browser.
3. **CLI only, no library.** Smallest surface, but MCP consumers and orchestrators such as a
   review or mutation-testing harness need in-process access.

# Your decision and reasons behind the accepted choice

Option 2, in two tiers.

**Tier 1 — the stable surface, one factory and five verbs:** `build`, `select`, `explain`,
`stats`, `verify`. Every one returns plain JSON-serialisable data, which is what lets the CLI,
the MCP server and a library caller be thin renderers over the same code path rather than three
implementations. `select` already exists and carries the whole §8.3 rule table.

**Tier 2 — `@spikedpunch/cbd/adapter`:** `Recorder`, `inProcessSource`, `FileSink`, `parseShard`,
documented as unstable and for adapter authors, which is us.

Two consequences of keeping the surface small that are worth recording as decisions in their own
right:

- **`collect` is not a core verb.** Running the test suite is process orchestration, so it belongs
  to `@spikedpunch/cbd-cli`. This keeps `child_process` out of a framework-neutral library.
- **`verify` takes outcomes as data, not a command to run.** Same reason, and it makes verification
  unit-testable without spawning anything.

**Consequences.** Integration-test support adds *no verb*. It adds source implementations under
`packages/core/src/source/` and two config keys, because the only thing that differs between unit
and integration is where coverage comes from — and that is already an array in
`RecorderOptions.sources` [^sources-interface]. The async member of `Source` was put there for
exactly this reason and must not become dead code.

The cost is that configuration becomes mandatory for every call. That is the intended trade: it
is what keeps `cbd select`, `cbd explain` and the library answering the same question the same
way, and it is why the CLI and the library cannot drift.

[^cbd-cli]: CBD design document section 9.2 lists the designed CLI verbs.
[^sources-interface]: CBD design document section 4.1 — every source shares one settings shape.
