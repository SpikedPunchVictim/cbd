---
type: Architecture Decision
title: "ADR-0004: The success metric is a product, and it is constrained"
description: S = (1−P)(1−φ)(1−r) ≥ 0.60, subject to a zero miss count.
status: draft
tags: [metrics, goals, soundness]
generated: { by: process:cbd-adr-backfill, at: 2026-10-15T00:00:00Z }
sources:
  - id: cbd-goals
    resource: /CBD.md
    title: CBD design document, section 1 — problem and goals
  - id: premortem
    resource: /arch/log.md
    title: Pre-mortem on the plan at 4dc5ed9, 2026-10-15
  - id: all-rate
    resource: /IMPLEMENTATION_PLAN.md
    title: Amendment 2 — the measured all-rate, and its two framings
---

# Authors and the team

The spike author, with Claude Code. The reframing came out of a pre-mortem run against the plan
as committed at `4dc5ed9`.

# Context and problem you want to solve

The goal was stated as an absolute: a ~20 minute suite should become ~2 minutes. That has two
defects.

It does not travel. The same engineering result reads as a triumph on a 60-minute suite and as a
failure on a 4-minute one, so the number cannot be quoted across repositories or compared between
them — and the repository that actually matters here has never been named.

Worse, the plan cited **two irreconcilable framings of its own all-rate**: per change (7–49%,
median 19%) and per ten-commit window, where it compounds to a ~2.4% subset rate. Those imply
outcomes roughly three times apart, and they appear in the same document as though they were one
measurement [^all-rate]. The pre-mortem identified this as the most likely cause of cancellation:
not that the mechanism fails, but that it is judged against a bar derived from the wrong framing.

# Functional and non-functional requirements you want to address

- **Portable.** Quotable without re-derivation, across repositories of different sizes.
- **Isolating.** It must separate what CBD controls from what it merely inherits.
- **Measurable early and cheaply** — ideally before the expensive implementation work.
- **Not gameable toward under-selection**, which is the one unacceptable failure direction.

# Potential critical user journey (CUJ) the decision impacts

A developer edits one file and runs the suite. What they experience is the *fraction* they got
back, not the minutes — and the fraction is what determines whether they keep running the tool.

# Overview of the key options

1. **Absolute wall time saved.** Concrete and easy to feel, but not portable and not comparable.
2. **Average percentage of iteration time saved.** Normalised, portable, and it composes over a
   sequence of edits, which is what a developer actually experiences.
3. **Both**, with the percentage primary and the absolute quoted alongside for intuition.

# Your decision and reasons behind the accepted choice

Option 2, with the absolute retained as context. Stated as a floor rather than a wish:

```
S ≥ 0.60,  subject to  miss count = 0
```

Decomposing `S` gives the decision its force. Let `φ` be the *irreducible* startup and load
fraction of a run — what a run pays even when it selects almost nothing — and `r` the fraction of
the *reducible* work actually run. Then

```
E[T] = P·T_full + (1−P)·[φ + r(1−φ)]·T_full

  S  = (1−P) · (1−φ) · (1−r)
```

**The saving is a product of three independent factors.** That is the whole model, and it is what
the goal document lacked. You must not escalate (P → 0), you must not pay startup (φ → 0), and you
must select well (r → 0). *Any one factor at zero kills the product however good the other two
are.*

Setting each factor to its own limit gives two hard gates, and one of them is fatal on its own:

| P(all) | max φ (at r=0) | max r (at φ=0) |
|---|---|---|
| 0.10 | 33% | 33% |
| 0.19 | 26% | 26% |
| 0.25 | 20% | 20% |
| 0.30 | 14% | 14% |
| **≥ 0.40** | **0** | **0 — impossible** |

**Consequences.** Three follow directly, and they are the reason this record exists.

*Gate A is measurable with no CBD code at all.* `φ` is obtained by timing three runs on the
target suite using only the test runner's own filtering: the full suite, a run selecting roughly
10% of tests, and a run selecting one. If `φ > 26%`, the 60% target is unreachable at *any*
selection quality, because CBD chooses which tests run and cannot make them load faster. This is
an afternoon's work and it can end the project for free. For VS Code's platform scope it already
passes — a smoke run of 30 tests was 9 ms of test time against 0.2 s wall, set against a 104 s full
run, giving φ ≈ 0.2% — but that runner is hand-rolled, and japa and vitest are not.

*Gate B is a ceiling no selection quality can lift.* `P(all) ≥ 0.40` makes the target impossible at
any `r`. The measured range is 7–49%, so the top of that range is fatal. This makes the previously
academic framework question load-bearing: japa files per-test setup as `@between`, and rule 9
escalates a file touched only by `@between`, so japa's all-rate is pushed upward by exactly the
mechanism mocha's root-hook window already solved.

*The metric rewards the wrong direction, so it cannot stand alone.* `S` **improves when you
under-select**: loosening `unknownPolicy`, dropping the `@load` escalation, or treating `@between`
as attributable all raise the score. Every policy lever in amendments 2–4 pushes that way, and the
metric will report the push as a win. The objective must therefore be **constrained, never
scalar** — a miss count of zero is a hard constraint, and `S` is maximised only within it. Anyone
reporting a saving must be asked for the miss count in the same breath. The average also conceals
what is felt, so `p50` and `p90` of `S` are reported alongside the mean: if escalation correlates
with the changes a developer most wants to be fast — shared helpers, configuration, startup files
— the mean overstates the benefit.

Two questions are left open by this record rather than answered, and neither should be silently
assumed later. Whether 60% is a defended floor or a first estimate is unstated by the author; at a
25% all-rate it demands running under a fifth of the tests, which is a demanding specification.
And the suite the metric is to be measured on is still unnamed, which is the one input every gate
above depends on.

[^all-rate]: Amendment 2 of the plan, measured at whole-repo scope, `FINDINGS.md` §3.
[^cbd-goals]: CBD design document section 1 states the original absolute goal.
