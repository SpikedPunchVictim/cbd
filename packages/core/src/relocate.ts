/**
 * Rewriting a source path that resolved into a *copy* of the tree.
 *
 * A script's own source map is asked "which source line is this?", and it answers
 * correctly. Grizzly's `tsc` emits inline maps, and a deployed lane's `dist/*.js`
 * resolve to the lane's own `../src/*.ts`. That is the right answer to a question
 * nobody is asking. The map's keys have to be paths the *rest of the toolchain*
 * names — git above all, since `changesSince` returns paths built on the repo root
 * it was handed — and a path under a staging directory names nothing a diff can
 * produce.
 *
 * So a path that resolved is rewritten by rule: `from` names the staging root, `to`
 * names the checkout. Measured, on grizzly key-server (ADR-0006): one logical file
 * held 3 tests at the checkout path and 2 *different* tests under the lane path,
 * overlap empty — a change to it returned a complete-looking subset that silently
 * omitted the tests that reached it over HTTP.
 *
 * This is deliberately NOT `projectPath`, and the difference is the reason it is a
 * second rule type rather than a second call. Projection is for a build with NO
 * source map, where the generated file *is* the source file, and it is sound only
 * because a 1:1 build preserves lines. Relocation claims something weaker, later in
 * the pipeline: a map has already resolved, and the only claim is that the tree it
 * resolved into is a copy of the checkout. So it never swaps extensions — a copy of
 * a tree has the same file names — and it never drops a file it does not describe.
 */
import { canonicalPath, within } from './projection.js'

export interface RelocationRule {
  /** Absolute prefix of the tree the code ran from, e.g. `<root>/.grizzly-dev/<lane>`. */
  from: string
  /** Absolute prefix of the tree the code lives in, e.g. `<root>`. */
  to: string
}

// A resolved path is asked for once per function per window, and the same few
// hundred paths recur across every window of a run, so `realpathSync` runs once per
// distinct path rather than millions of times. Stable for the process, on the same
// assumption `canonicalProjectionRules` already makes: a rule set is fixed for a
// run. A miss costs one throwing `realpathSync`, which is why this exists at all.
const canonicalPaths = new Map<string, string>()

function canonical(file: string): string {
  const cached = canonicalPaths.get(file)
  if (cached !== undefined) return cached
  const resolved = canonicalPath(file)
  canonicalPaths.set(file, resolved)
  return resolved
}

/**
 * `from` prefixes, resolved through any symlinks; `to` is left as written.
 *
 * The asymmetry is `canonicalProjectionRules`'s, for its reasons, restated here
 * because it is not shared code. Node canonicalizes the paths it hands the
 * inspector, so a map built with its own URL resolves its sources to realpaths,
 * while a prefix in a config is exactly as typed. On macOS `/tmp` is `/private/tmp`,
 * so a literal `from` spelled the symlinked way matches nothing — every staged path
 * stays unknown-file and escalates to `mode: all`, which fails safe but silently
 * gives up the speedup. `to` must keep agreeing with the repo root `changesSince`
 * was handed, so it is not touched.
 */
function canonicalRules(rules: readonly RelocationRule[]): RelocationRule[] {
  return rules.map((rule) => ({ ...rule, from: canonicalPath(rule.from) }))
}

/**
 * Rewrite `file` to the path it lives at when it resolved into a copy of the tree.
 *
 * Returns `file` unchanged when no rule covers it — byte for byte, which is the
 * property the acceptance run leans on. A relocation never drops a path, so this
 * cannot remove a file from the map; the worst a wrong rule can do is name a path
 * no diff produces, which reads as unknown-file and escalates.
 */
export function relocatePath(file: string, rules: readonly RelocationRule[]): string {
  if (rules.length === 0) return file
  return relocate(file, canonicalRules(rules))
}

function relocate(file: string, rules: readonly RelocationRule[]): string {
  const resolved = canonical(file)
  for (const rule of rules) {
    if (!within(resolved, rule.from)) continue
    const rest = resolved.slice(rule.from.length).replace(/^\//, '')
    return `${rule.to.replace(/\/$/, '')}/${rest}`
  }
  return file
}

/**
 * The rewrite as one function, for a caller that resolves many files per window.
 *
 * Rules are canonicalized once here, at the top of a scan, rather than at every
 * call. The returned function is the identity when there are no rules, so a run
 * without relocation pays a call and nothing else.
 */
export function createRelocator(rules: readonly RelocationRule[] = []): (file: string) => string {
  if (rules.length === 0) return (file) => file
  const canonicalized = canonicalRules(rules)
  return (file) => relocate(file, canonicalized)
}
