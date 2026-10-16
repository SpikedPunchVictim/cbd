# Update history

## 2026-10-15

**Creation** — bundle established. ADR-0001 (observe execution, not a call graph), ADR-0002
(resolve at build time) and ADR-0003 (one factory, five verbs, two tiers) written as unreviewed
drafts. Remaining records listed under *Planned* in [index.md](index.md).

**Update** — ADR-0004 recorded after a pre-mortem on the plan as committed at `4dc5ed9`. It
replaces the absolute goal ("20 min → 2 min") with a constrained percentage metric,
`S = (1−P)(1−φ)(1−r) ≥ 0.60` subject to a zero miss count, and derives two gates from it — one of
which, the startup floor φ, is measurable with no CBD code at all. Two questions are recorded as
open rather than answered: whether 60% is a defended floor, and where the target suite lives.
