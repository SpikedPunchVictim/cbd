# Changelog

All packages share a version. Dates are release dates; the working tree is `unreleased`
until a tag is pushed and the publish workflow runs.

## 0.0.2 — 2026-10-20

Fixes from grizzly-sv T-29-015, all in the selection path. No API was removed; a map
recorded before this release still loads, with the safe fallback described below.

### Selection correctness

- **Untracked files are changes.** `git diff` never lists them, so a new file under
  `include` was invisible and `select` could answer with no tests while the suite was
  broken. Worktree-mode selection now reads `git ls-files --others --exclude-standard`
  and treats each as an addition; `--no-worktree` still asks about a commit only.
- **Module-scope changes select the process that loaded the module.** A test can compare
  a top-level binding without calling a function in the file, so the function index left
  it out. The map now records `shardTests` (the tests that can observe a shard's
  module state) and `loadShards` (per file, the shards that evaluated it), and a hunk
  outside every function selects those tests plus the function index's. A shard marked
  `role: 'service'` attributes load only to the tests that actually touched the
  service. Maps without the fields fall back to `mode: all`.
- **Helpers that define tests are test files.** A helper whose `test(...)` calls are made
  through a function a spec invokes is now detected by a static registration scan, so
  `testFilePolicy` applies and its added-test warning fires. Under `known` it selects the
  tests that executed code in the helper.
- **`alwaysSelect`.** New `cbd.config.json` key for tests that read sources as text and can
  never appear in coverage. Entries are `{ "tests": ["file" or "file > title"], "when":
  ["glob"]? }`, are added with reason `always`, and an unresolved entry forces `mode: all`
  with a warning. Malformed entries are rejected by the loader and the schema.
- **Maps are portable.** Paths are stored relative to the map's root and resolved on load,
  so a map recorded in one worktree gives the same answer in another checkout of the same
  commit. Absolute paths outside the root stay absolute.
- **Ignored changes are visible.** `Selection.ignored` names changed files outside
  `include` that no rule claimed (`alwaysAll` and `alwaysSelect.when` can still claim one).

### Docs

- CBD.md §8.2–§8.5 and the README describe the new rules, `alwaysSelect`, `ignored`, and
  the portable map format.
- `cbd.config.schema.json` accepts `alwaysSelect`.
