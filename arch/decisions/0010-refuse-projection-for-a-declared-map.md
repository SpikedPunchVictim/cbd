---
type: Architecture Decision
title: "ADR-0010: Refuse to project a script whose declared source map cannot be read"
description: A declared map that cannot be honoured drops the script; falling back to line projection would guess at a transform that is not line-preserving.
status: draft
tags: [source-maps, projection, soundness]
generated: { by: process:cbd-adr-backfill, at: 2026-10-19T00:00:00Z }
sources:
  - id: source-maps
    resource: /packages/core/src/source-maps.ts
    title: createScriptResolver — the refusal and its reasons
  - id: findings
    resource: /.explore/FINDINGS.md
    title: The two fixture builds, and why neither could catch this
---

# Authors and the team

The spike author, with Claude Code. It affects any consumer whose build emits source maps for some
scripts and not others.

# Context and problem you want to solve

A script either declares a source map or it does not. When it does, the map is a promise about how
the generated file was made. When it declares one that cannot be read — a missing `.map`, a broken
inline payload, an unparseable map — there is a tempting third path: ignore the declaration and use
path projection, which assumes the generated file is a line-preserving copy of the source.

That assumption holds for `tsc` with `sourceMap: false` only. An esbuild transpile strips type-only
lines and rewrites enums, class fields and decorators, so everything below such a rewrite shifts.
Projecting it yields line numbers that look entirely plausible and are wrong. A range that has
slipped can sit outside the hunk that really touched the function — the selection omits the test
that would have caught the change, silently.

# Functional and non-functional requirements you want to address

- Never guess when the build has told us it is not 1:1.
- Prefer an answer that escalates (unknown file → `mode: all`) to one that looks complete and is
  wrong.
- Keep a way to resolve a build that genuinely has no maps: an explicit projection rule remains
  valid when no map is declared.

# Potential critical user journey (CUJ) the decision impacts

A developer changes a function in a file whose map failed to build. The selection either runs
everything (safe, slow) or runs a plausible-looking subset that may omit the failing test.

# Overview of the key options

1. **Fall back to projection on an unreadable map.** Fast, plausible, and unsound for any transform
   that moved lines.
2. **Refuse the script.** Drop it from the map; a change to its file reaches the unknown-file rule
   and runs everything.
3. **Fail the whole run.** Loud, but a single unreadable map in a dependency would take down a
   recording that is otherwise usable.

# Your decision and reasons behind the accepted choice

Option 2 [^source-maps]. A declared map is honoured or the script is not resolved. Projection is
consulted only when no map was declared at all, and then it is the caller's explicit rule.

**Consequences.** The file never enters the map, so `select` answers `unknown-file` and runs
everything — the safe direction, and the same answer the unreadable-declared-map rule gives for a
relocated or deployed copy. The fixture could not catch the hazard by construction: `out-maps`
always carries readable maps and `out-nomaps` declares none, so the fallback fires in neither build
and every test stayed green while it sat there [^findings]. It is now pinned by a hermetic
source-map test that declares a map the resolver cannot read and asserts the script is dropped
rather than projected.

[^source-maps]: `source-maps.ts`, `createScriptResolver` — the comment above the declared-map
    branch.
[^findings]: `.explore/FINDINGS.md`, section on the two-build fixture.
