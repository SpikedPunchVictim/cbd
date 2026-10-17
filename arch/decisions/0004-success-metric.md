---
type: Architecture Decision
title: "ADR-0004: The success metric is a product, and it is constrained"
description: S = (1−P)(1−r) ≥ 0.60, subject to a zero miss count, over a suite that clears the startup floor.
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
  - id: findings-7d
    resource: /.explore/FINDINGS.md
    title: What unit-tests-only removes from the design
  - id: target-suite
    resource: /Users/spikedpunchvictim/projects/grizzly/grizzly-platform/typescript
    title: grizzly-platform TypeScript monorepo — sdk/, the suite this metric is measured on
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

Decomposing `S` gives the decision its force. Let `r` be the fraction of the *reducible* work
actually run — the work a subset run still pays for, once startup is set aside. Then

```
S  = (1 − P) · (1 − r)
```

**The saving is a product of two independent factors.** You must not escalate (`P → 0`) and you
must select well (`r → 0`). Either one at zero kills the product however good the other is.

*Amended 2026-10-16 — startup was previously a third factor, `(1 − φ)`, and has been taken out of
the product.* Start-up is a cost the run pays whether or not CBD does anything: it is identical in
the baseline and in the subset, so it cancels when the two are compared, and it is nothing the
selector controls or influences. Leaving it in made `S` a compound of one thing CBD does and one
thing it merely inherits, and it made a suite with a heavy warm-up look like a failure of selection
when it is nothing of the kind. The floor is still load-bearing, but as an admissibility test on the
*suite* rather than as a factor in the *selector's* score — see the gate below.

This leaves one hard gate on selection quality:

| P(all) | max r |
|---|---|
| 0.10 | 33% |
| 0.19 | 26% |
| 0.25 | 20% |
| 0.30 | 14% |
| **≥ 0.40** | **0 — impossible** |

**Consequences.** Three follow directly, and they are the reason this record exists.

*Gate A — the startup floor — is a separate admissibility test on the suite.* Let `φ` be the
*irreducible* startup and load fraction of a run: what it pays even when it selects almost nothing.
At best — no escalation, perfect selection — a run still costs `φ · T_full`, so **the largest
wall-clock improvement any selector can deliver is `1 − φ`.** For a run to be 60% faster its suite
must have `φ ≤ 40%`. Below that line no selection quality and no amount of engineering reaches the
goal, and the honest answer is to find a different suite rather than a better selector.

`φ` is measured with no CBD code at all: time runs of different sizes using only the test runner's
own filtering, and take the floor directly by selecting a file that does not exist. It is an
afternoon's work and it can end the project for free. Measured 2026-10-16 — VS Code's platform scope
≤ 0.16%; the grizzly `tests/stores` suites ≈ 0.5%; the grizzly `int-cli` unit suite 17–21.5%; the
grizzly `sdk-unit` suite **42.6%, which fails**. Because the floor is roughly constant for a given
toolchain, `φ` is really a statement about suite *size*, and it is the reason the target moved from
the unit suite to the stores suite.

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

# The suite the metric is measured on

**Decided 2026-10-16**, replacing the choice made the day before. The target is the `tests/stores`
suites of the grizzly-platform TypeScript monorepo — the project this design was written from
[^target-suite], and the suite `CBD.md` §1 describes: *backend suites that drive a separately
started HTTP server*. japa 5.0.0. Ten spec files, six suites, 1555 tests in 548.6 s.

```
node tools/dev-cli/bin/dev.js lane up      # a private server + Postgres per lane
cd tests/stores && eval "$(node ../../tools/dev-cli/bin/dev.js lane env <id> --format dotenv)"
npm test                                    # plus: npm run test:signing
```

**Why the first choice was wrong.** On 2026-10-15 this record named `sdk-unit`, reasoning that the
stores suites were the out-of-process shape cut from v1 when the scope narrowed to unit tests.
Gate A was run on `sdk-unit` the next day and it failed: `T_full` 1.69 s against a floor of 0.72 s,
so `φ = 42.6%`, above the 40% line. The stores suites — same repository, same framework, same
toolchain — measure ≈ 0.5%. They differ in size by a factor of 325 and in nothing else that
matters.

So the scope decision had the premise backwards. The unit suites are 1.7 s and 5 s, far too fast
for selection to be worth anything, and the suite that hurts is the one that was excluded. What
`FINDINGS.md` §7d removed with the out-of-process machinery was not v2 polish; it was the only
place the tool pays. The full measurements are in `.explore/FINDINGS.md` §10–11.

**The cost, stated plainly.** Two items are now real debts rather than footnotes. There was no
japa adapter, though `CBD.md` calls japa the first and budgets a day for it (`cbd-cpy`). And Gate B
— designed to be the cheap, early gate — cannot be measured on these suites until the server is
instrumented, because a map blind to server-side code resolves a key-server change to an unknown
file and escalates to `all` for an artefactual reason (`cbd-a3v`). The gates are no longer nearly
free, and that is a price of the retarget rather than a surprise.

One question remains open rather than answered, and it should not be silently assumed later.
Whether 60% is a defended floor or a first estimate is unstated by the author; at a 25% all-rate it
demands running under a fifth of the tests, which is a demanding specification.

[^all-rate]: Amendment 2 of the plan, measured at whole-repo scope, `FINDINGS.md` §3.
[^cbd-goals]: CBD design document section 1 states the original absolute goal.
[^findings-7d]: `.explore/FINDINGS.md` §7d, "What unit-tests-only removes from the design".
[^target-suite]: The suite the design document was written from; `CBD.md` §1 and §7.1.
