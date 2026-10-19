---
okf_version: "0.2"
---

# CBD architecture decisions

Decision records for CBD, in [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)
v0.2. Frontmatter is OKF; the body follows Google's ADR chapters — *authors · context and
problem · requirements · critical user journey · options · decision and reasons*.

**Trust is read from the frontmatter, not asserted here.** A record with `status: draft` and no
`verified` key is *unverified*: drafted from measurements that are already committed, but not yet
read by a human. Adding `verified: { by: human:<id> }` and flipping `status` to `stable` is how a
record becomes reviewed. Nothing in OKF forces either — a consumer is required to tolerate a
missing family.

## Decisions

| # | decision | status |
|---|---|---|
| [0001](decisions/0001-observation-over-call-graph.md) | Observe execution instead of building a call graph | draft |
| [0002](decisions/0002-resolve-at-build-time.md) | Resolve coverage at build time, not in the test window | draft |
| [0003](decisions/0003-factory-and-two-tiers.md) | One factory, five verbs, two tiers | draft |
| [0004](decisions/0004-success-metric.md) | The success metric is a product, and it is constrained | draft |
| [0005](decisions/0005-inject-not-attach.md) | Reach a service by injecting into it, not by attaching to it | draft |
| [0006](decisions/0006-relocate-a-deployed-copy.md) | Relocate a path that resolved into a deployed copy | draft |
| [0007](decisions/0007-a-service-the-suite-starts-itself.md) | Attribute a service the suite starts itself | draft |
| [0008](decisions/0008-correlate-a-request-by-id.md) | Correlate an out-of-process request by id | draft |
| [0009](decisions/0009-canonicalize-both-sides.md) | Canonicalize both sides of a prefix match | draft |
| [0010](decisions/0010-refuse-projection-for-a-declared-map.md) | Refuse to project a script whose declared map is unreadable | draft |
| [0011](decisions/0011-the-root-hook-is-the-window.md) | The framework's awaited root hook is the window | draft |
| [0012](decisions/0012-diff-from-the-map-commit.md) | Take the diff from the map's commit, not the branch base | draft |
| [0013](decisions/0013-one-map-per-commit.md) | One map per commit, merged from its shards | draft |
| [0014](decisions/0014-the-source-array-is-the-seam.md) | The source array is the integration seam | draft |

The backfill is complete: the decisions that had only lived in docblocks, the design document and
the log now have records. New decisions are added as records rather than as a planned list here.

## Adding a decision

One file per decision at `decisions/NNNN-slug.md`, numbered sequentially. Frontmatter must carry
a non-empty `type` — that is OKF's only always-required key:

```yaml
---
type: Architecture Decision
title: "ADR-NNNN: <the decision, as an imperative>"
description: <one sentence>
status: draft                      # draft | stable | deprecated; absent means stable
tags: [<facet>, <facet>]
generated: { by: <actor>, at: <ISO 8601 with offset> }
sources:
  - id: <stable-key>
    resource: /<bundle-relative path or URL>
    title: <what it is>
---
```

Then the chapters, as `##` headings. Cite a source inline with a footnote whose label is its
`sources[].id` — OKF keys footnotes rather than numbering them positionally.

Do not add a `related:` or `links:` field. OKF has no relationships field on purpose: lineage is
markdown links in the body, and a consumer reads them as directed edges of an untyped
relationship.
