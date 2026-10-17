---
type: Architecture Decision
title: "ADR-0006: Relocate a path that resolved into a deployed copy"
description: A source path a map resolves into a deployed tree is rewritten back to the checkout by an explicit rule, so the map is keyed by where the code lives rather than where it ran.
status: draft
tags: [paths, selection, soundness, deployment]
generated: { by: agent:claude-code, at: 2026-10-17T00:00:00Z }
sources:
  - id: cbd-design
    resource: /CBD.md
    title: CBD design document
  - id: acceptance-run
    resource: /arch/log.md
    title: The cbd-a3v.3.5 acceptance run on grizzly key-server
  - id: projection-module
    resource: /packages/core/src/projection.ts
    title: projectPath — joining a compiled path back to its source when there is no map
---

# Authors and the team

The spike author, with Claude Code. The decision applies to the core's path resolution, and
therefore to every adapter and every consumer.

# Context and problem you want to solve

A function's identity in the map is `(file, name@ordinal)`, and `file` is the path the script
*resolved to*: through its own source map where there is one, by projection where there is not.
That is the right answer to "which source line is this?", and it is the wrong answer to "which
file does version control know?", in one specific case.

The grizzly acceptance run [^acceptance-run] is that case. The stores lane runs the server from a
copy of the build under `.grizzly-dev/<lane>/`, and grizzly's `tsc` emits **inline** source maps,
so the copy's `dist/*.js` resolves through its own maps to its own `../src/*.ts` — inside the
lane. Every one of the 464 files in the service shard is keyed under the lane. Twenty-four have a
twin at the repository path, and that twin holds only what the test process ran in-process. The
remaining 269 are known to the map under no path a repository diff can name.

The consequence is measured, not inferred. `select()` against
`api/key-server/fastify/src/handlers/CreateEncrypt.ts` returns 3 tests, the ones that ran the
handler in process; the lane-path entry for the same handler names 2 *different* tests, the ones
that exercised it over HTTP. The overlap is empty. Choosing by the repository path therefore
misses two tests that genuinely reach the handler, and it returns a complete-looking answer while
doing it — under-selection, the one failure this project treats as unacceptable.

`CBD_PROJECTION_FROM`/`CBD_PROJECTION_TO` cannot fix it, and that is worth recording because the
knob looks like the answer. A projection rule is consulted only when a script carries **no**
source map [^projection-module]. These scripts carry one, so the resolver never reaches the
projection path at all. The rule that would have helped is the one the resolver is designed to
ignore.

# Functional and non-functional requirements you want to address

- **Sound in the one direction that matters.** One logical file whose evidence sits under two
  paths must become one entry holding the union. A union is never smaller than either part, so
  the fix can only grow the selected set.
- **No change to anyone's build.** CBD is framework-neutral and cannot ask a consumer to rebuild
  differently; grizzly is a test subject, not a partner.
- **Fails safe.** A rule that matches nothing must change nothing. A rule that lapses must degrade
  to `unknown-file` and `mode: all`, loudly, rather than to a wrong-but-plausible subset.
- **Bounded cost.** Resolution happens once per script per window; the window boundary path
  (dispatch → settle) must not be touched at all.
- **Explicit over implicit.** A rule that rewrites a path is a claim about the environment, and it
  should be readable as one.

# Potential critical user journey (CUJ) the decision impacts

A developer changes one line of a request handler in a service their suite drives out of process.
The service is deployed to a staging directory before it runs. They run the suite: it must select
the tests that reached that handler over HTTP *and* the ones that called it in process, and the
count must not quietly be the smaller of the two.

# Overview of the key options

1. **A relocation rule in the core**, applied to the resolved original path after a map has done
   its work: `<staging root>` → `<checkout root>`. One new rule type, one new scan option, one
   env pair, mirroring the shape that already exists for projection.
2. **Apply the existing projection rules at a second application point**, so there is one knob
   and one concept — "joining a path back to the source tree" — with two moments.
3. **Fix it in the deploy**: have the staging step emit maps whose `sources` point at the
   checkout. No CBD change at all, and the map is correct at its source.
4. **Derive it**: when a resolved path does not exist on disk, look for a suffix that does.
   Rejected without measurement — it replaces a rule the operator can read with a guess, and a
   guess that lands on the wrong file is exactly the under-selection this ADR exists to prevent.

# Your decision and reasons behind the accepted choice

Option 1, with option 2 explicitly rejected and option 3 recorded as a thing a consumer may
additionally choose.

Projection and relocation are the same *operation* — a prefix swap — but not the same *claim*.
Projection says "there is no map, so this generated file **is** that source file", and it is only
sound because a 1:1 build preserves lines; the code goes to some length to refuse to guess when
that is not true [^projection-module]. Relocation says "a map resolved correctly, into a copy of
the tree that lives elsewhere". Folding them together would make a rule written for one purpose
silently rewrite the other, and the two have different failure modes: a projection that misfires
produces wrong line numbers inside a real file, while a relocation that misfires produces a path
no diff can name. Two knobs, each answerable on its own, is the explicit option and the one a
reader can audit.

Option 3 is genuinely cheaper for grizzly and is not wrong — a map whose sources name the
checkout is a better artifact. It is rejected as *the* fix because it leaves the defect in place
for every other consumer, and because `rush deploy` does not know the checkout root at build
time. It remains available as an addition, and if it lands the relocation rule simply stops
matching anything, which is the failure mode this design wants.

The rule is applied to the resolved **original** path only, never to the generated one: a
generated path under a copy is not a file version control knows, and rewriting it would put a key
in the map that no diff can produce. Order is map → relocate → `include`/`exclude`, so an
`include` naming the checkout keeps matching a file that arrived under the staging root.

The staging prefix is matched **literally**, like every projection prefix today. A lane id is
user-chosen, so the rule names one lane, and a rule that has lapsed or gone stale escalates to
`mode: all` rather than to a subset. A single `*` segment would cover every lane in a
`.grizzly-dev/` directory in one rule, and is available later as an additive change if naming one
staging root per environment proves to chafe.

**Consequences.** One logical file with evidence under two paths becomes one entry holding the
union — measured on grizzly as 3 + 2 = 5 tests for `CreateEncrypt.ts`, disjoint before and
complete after. The rule set is now two, and the docs have to keep them distinct. And the design
carries an assumption worth stating where the knob is documented: it assumes the copy was built
from the checkout. A stale copy attributes old evidence to new paths, which over-selects — the
direction this project accepts, and the reason the assumption is tolerable.

[^acceptance-run]: The cbd-a3v.3.5 acceptance run, 2026-10-17: 393 tests, lane `loafing-pepper`,
    464 service-shard files, 293 of them keyed under the lane, 24 with a repository-path twin.
[^projection-module]: `packages/core/src/projection.ts`, and `createScriptResolver` in
    `packages/core/src/source-maps.ts`, which prefers a declared map and does not fall back.
