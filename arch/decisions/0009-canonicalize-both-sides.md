---
type: Architecture Decision
title: "ADR-0009: Canonicalize both sides of a prefix match, and leave the destination as written"
description: A projection or relocation rule matches only if the script path and the rule's source prefix are canonicalized the same way.
status: draft
tags: [paths, projection, relocation, soundness]
generated: { by: process:cbd-adr-backfill, at: 2026-10-19T00:00:00Z }
sources:
  - id: projection
    resource: /packages/core/src/projection.ts
    title: Projection rules, path canonicalization and its postmortems
  - id: relocate
    resource: /packages/core/src/relocate.ts
    title: Relocation rules and the same asymmetry
  - id: findings
    resource: /.explore/FINDINGS.md
    title: The A2 path work — symlinked temp roots and the empty map
---

# Authors and the team

The spike author, with Claude Code. It affects every consumer that configures a projection or a
relocation prefix.

# Context and problem you want to solve

A rule joins a script's path to the path a developer edits by matching a prefix: `from` names the
build output or the staging copy, `to` names the source tree or the checkout. Node reports module
URLs as **realpaths**, while a prefix written in a config is exactly as typed. On macOS `/tmp` is a
symlink to `/private/tmp`, so a rule spelled with the symlinked prefix matches no script at all.

The failure is not a wrong answer; it is an *empty* one. Every script is dropped, the map holds
nothing, every change resolves to an unknown file and escalates to `mode: all`. That fails safe —
never under-selecting — but the entire speedup disappears silently, and nothing in the output says
why. The same mistake has been carried by nyc since 2018 and by c8 for the same reason
[^projection].

# Functional and non-functional requirements you want to address

- A rule must match regardless of which side was spelled through a symlink.
- `to` must keep agreeing with the paths git produces, because `changesSince` builds its paths on
  the repository root and `select` compares them by string.
- The comparison must not be paid per function per window: a run resolves the same few hundred
  paths in every window.

# Potential critical user journey (CUJ) the decision impacts

A developer points CBD at a build with no source maps (`out/` → `src/`) or at a lane whose server
runs a copy of the tree. If the rule silently fails, they see `mode: all` on every change and
conclude the tool does not work.

# Overview of the key options

1. **Compare literally.** Simple, and wrong whenever the two spellings differ from the symlink.
2. **Canonicalize only `from`.** Half a fix: whichever side happened to be literal decides the
   result.
3. **Canonicalize the script path and `from`, never `to`.** The comparison is between two things
   Node and the user chose, while the destination is a statement about the toolchain's spelling.

# Your decision and reasons behind the accepted choice

Option 3. `canonicalProjectionRules` resolves each rule's `from` through `realpathSync`, and the
generated path is canonicalized at the comparison, so neither spelling decides the outcome
[^projection]. `createRelocator` does the same for relocation [^relocate].

`to` is deliberately left as written. The map's keys must be the paths the rest of the toolchain
names — git above all, since `changesSince` returns paths built on the root it was handed.
Canonicalizing `to` would move every map key away from what a diff produces, trading one mismatch
for another.

**Consequences.** Rules are canonicalized once per scan (memoized on the rule array's identity),
and relocation caches `realpathSync` per distinct path. A missing prefix is not an error: a `from`
that does not exist yet is handed back untouched, because a `to` may name a tree that has not been
built. The failure mode that remains is the honest one — a rule that matches nothing leaves the
map empty and escalates, rather than producing plausible wrong paths.

[^projection]: `projection.ts`'s docblock, including the nyc (`istanbuljs/nyc#1301`) and c8
    (`aspect-build/rules_js#2933`) postmortems.
[^relocate]: `relocate.ts` — the same asymmetry, restated there rather than shared, because the
    reasons differ in what each side means.
