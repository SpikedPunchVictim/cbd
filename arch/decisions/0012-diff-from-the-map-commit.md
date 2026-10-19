---
type: Architecture Decision
title: "ADR-0012: Take the diff from the map's commit, not from the branch base"
description: The map describes the bytes at its own commit, so selection must count every change since that commit.
status: draft
tags: [selection, git, maps]
generated: { by: process:cbd-adr-backfill, at: 2026-10-19T00:00:00Z }
sources:
  - id: cbd
    resource: /CBD.md
    title: Section 8.2 — which changes
  - id: factory
    resource: /packages/core/src/factory.ts
    title: nearestMapCommit and the select path
  - id: map
    resource: /packages/core/src/map.ts
    title: The map is keyed by commit; a stale map is a wider diff
---

# Authors and the team

The spike author, with Claude Code. It changes what `cbd select` means on any branch whose base is
not the commit the map was recorded at.

# Context and problem you want to solve

A map is recorded at one commit and used for many subsequent changes. The obvious diff is from the
branch base — the commit the work branched from. That is wrong whenever the map's commit is not
that base. A map built at `X`, used on a branch whose base is `Y`, must count every change in
`X..worktree`: a change that landed between `X` and `Y` is present in the worktree and in the code
the map describes, but is invisible to a diff taken from `Y`. A test that reaches it would not be
selected, and nothing in the output would say so.

The same fact makes map *age* a correctness input rather than hygiene. A one-commit window can
answer ~66% of changes from the map; a ten-commit window can answer ~2.4%, because everything the
map has not seen since its commit resolves to an unknown file and escalates [^map]. A stale map is
therefore a wider diff and more `mode: all`, never a smaller one.

# Functional and non-functional requirements you want to address

- No change present in the worktree may be omitted from the diff.
- Selection must work between recordings, when HEAD is routinely a few commits past the map.
- The cost of a stale map must be visible (distance, warning) rather than silent.
- A caller must be able to narrow the range deliberately (`--since`).

# Potential critical user journey (CUJ) the decision impacts

A developer records on Monday at `X`, lands two changes, and selects on Wednesday. If the diff
starts at the branch base they created before Monday, Tuesday's change is invisible; a test that
should run for it is skipped.

# Overview of the key options

1. **Diff from the branch base (`merge-base HEAD <base>`).** Standard, and unsound against a map at
   an older commit.
2. **Diff from the map's commit.** The coordinates the map actually describes.
3. **Require a map at HEAD.** Sound, and defeats the purpose: the common case is selecting between
   recordings.

# Your decision and reasons behind the accepted choice

Option 2 [^cbd]. `select` loads the nearest ancestor of HEAD with a map (bounded to the recent
history a map could still answer for), uses that commit as the diff base, and reports the distance
so `maxAgeCommits` — and `--strict` — can act on it [^factory]. `--since` still lets a caller choose
a different base deliberately; the default is the map's own commit.

**Consequences.** A map carries its commit and `select` must resolve it; a dirty tree marks the map
dirty and warns; a stale map widens the diff and escalates, which is the safe direction. The map's
commit is also what `stats` and `explain` report, so a reader can always tell which recording
answered.

[^cbd]: CBD.md §8.2.
[^factory]: `factory.ts`, `nearestMapCommit` and the `select` implementation.
[^map]: `map.ts`'s docblock; the percentages are the Gate B-era measurements of answerability at
    one and ten commits.
