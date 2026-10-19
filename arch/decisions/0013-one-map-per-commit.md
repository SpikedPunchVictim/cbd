---
type: Architecture Decision
title: "ADR-0013: One map per commit, merged from every shard that names it"
description: The map is addressed by commit, so sharding a recording is a merge of shards for that commit, not a second map.
status: draft
tags: [maps, sharding, ci]
generated: { by: process:cbd-adr-backfill, at: 2026-10-19T00:00:00Z }
sources:
  - id: cbd
    resource: /CBD.md
    title: Sections 6.3 and 8.1 — shards and the map layout
  - id: map
    resource: /packages/core/src/map.ts
    title: buildMap and the merge; saveMap's path
  - id: factory
    resource: /packages/core/src/factory.ts
    title: build's shard selection and map path
---

# Authors and the team

The spike author, with Claude Code. It is the contract CI sharding and every later selection rely
on.

# Context and problem you want to solve

A real suite is recorded across machines: one shard per CI job, each a run of a subset of the
tests. Selection must answer from *one* map, and a map is a statement about one commit's bytes.
Two maps for one commit would leave `select` choosing between recordings — an ambiguity with no
principled answer — while a map per run or per machine multiplies artifacts that are all describing
the same tree.

# Functional and non-functional requirements you want to address

- Shards from different machines for one commit must merge into one map.
- A test recorded in two shards must not become two tests; its touches union.
- A map must never mix two builds' byte coordinates.
- `select` must have exactly one answer for a commit, and `gc` must not delete the map it reads.

# Potential critical user journey (CUJ) the decision impacts

A CI job records four shards in parallel and uploads them. The next build merges them; a developer's
selection on that commit reads one map and gets the union of what every job observed.

# Overview of the key options

1. **One map per recording run.** Simple to write, but selection would need to pick a run, and a
   partial suite's map is a smaller truth presented as the whole one.
2. **One map per commit per suite.** More precise, and selection would have to know which suite a
   change belongs to; the union is the safe answer.
3. **One map per commit, merged from shards whose headers name that commit.**

# Your decision and reasons behind the accepted choice

Option 3 [^cbd]. Shards carry the commit in their header. `build` merges every shard for the
target commit, skipping shards from other commits unless an explicit list names them; `buildMap`
unions a test recorded twice by title and file [^map]. The map lives at
`<stateDir>/maps/<commit>/map.json`, so the address is the commit and a rebuild replaces it
[^factory].

**Consequences.** Sharding is a merge, not a second artifact. A shard is coupled to its build: the
v2 script table records each script's size and mtime and the build refuses a mismatch (ADR-0002),
which is what stops two builds' maps being merged by accident. A partial recording that covers only
part of the suite still produces a valid map — for the tests it ran — and a change to code only the
unrecorded tests reach escalates through the unknown-file rule rather than being silently skipped.
`gc` always keeps the map `select` would read, even when it is older than the newest `n`.

[^cbd]: CBD.md §6.3 (shard format) and §8.1 (retention and merge).
[^map]: `map.ts` — `buildMap` and `mergeShards`.
[^factory]: `factory.ts` — the shard filter and `mapPath`.
