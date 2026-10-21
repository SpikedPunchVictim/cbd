/**
 * Joining a compiled path back to its source when there is no source map.
 *
 * This exists because of a real repository rather than a hypothetical: VS Code
 * sets `"sourceMap": false` in `src/tsconfig.json`, its node tests execute
 * `out/vs/**\/*.js`, and git tracks `src/vs/**\/*.ts`. Nothing in the artifact
 * records that relationship — no map, no sourceMappingURL comment, and the
 * output directory is gitignored. Without a configured projection, every changed
 * source file is "never seen" and the answer is `mode: all` forever.
 *
 * For a 1:1 build (no bundling, no code moved between files) this is a pure
 * string transform and needs no map at all.
 */
import { realpathSync } from 'node:fs'

export interface ProjectionRule {
  /** Absolute prefix of the build output, e.g. `<root>/out-nomaps`. */
  from: string
  /** Absolute prefix of the source tree, e.g. `<root>`. */
  to: string
  /**
   * Extension rewrite applied after the prefix swap.
   * Defaults to `{ '.js': '.ts' }`.
   */
  extensions?: Record<string, string>
}

const DEFAULT_EXTENSIONS: Record<string, string> = { '.js': '.ts' }

/**
 * True when `file` is inside `prefix`, on a path boundary.
 *
 * Exported because relocation does the same prefix test on a resolved path — see
 * `relocate.ts`, which shares this and nothing else from here. A plain `startsWith`
 * would rewrite `/repo/out-nomaps-extra/...` under a rule for `/repo/out-nomaps`,
 * pointing the map at files that do not exist.
 */
export function within(file: string, prefix: string): boolean {
  if (file === prefix) return true
  const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`
  return file.startsWith(normalized)
}

function swapExtension(file: string, extensions: Record<string, string>): string {
  const slash = file.lastIndexOf('/')
  const dot = file.lastIndexOf('.')
  if (dot <= slash) return file
  const ext = file.slice(dot)
  const replacement = extensions[ext]
  return replacement === undefined ? file : file.slice(0, dot) + replacement
}

/**
 * Projects a compiled file path onto its source path, or returns `null` when no
 * rule applies.
 *
 * Rules are tried in order, so a caller can put a narrow output directory before
 * a broad one.
 */
export function projectPath(file: string, rules: ProjectionRule[]): string | null {
  for (const rule of rules) {
    if (!within(file, rule.from)) continue
    const rest = file.slice(rule.from.length).replace(/^\//, '')
    const base = rule.to.replace(/\/$/, '')
    // The rule's own prefix (a directory a test listed) must not come back with a
    // trailing slash: the map keys it as a path, and `/repo/src` !== `/repo/src/`.
    const joined = rest === '' ? base : `${base}/${rest}`
    return swapExtension(joined, rule.extensions ?? DEFAULT_EXTENSIONS)
  }
  return null
}

/**
 * Resolve a path's symlinks, or hand it back untouched if it does not exist.
 *
 * Exported because the other half of the comparison needs it: `from` is not the
 * only side of the prefix match that can be spelled two ways. See
 * `createProjectionResolver`, which canonicalizes the generated path as well, so
 * that neither spelling decides the outcome.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // A missing prefix is not an error. `from` normally exists when a run happens,
    // but `to` may name a tree that has not been built yet.
    return path
  }
}

const canonicalCache = new WeakMap<readonly ProjectionRule[], ProjectionRule[]>()

/**
 * `from` prefixes, resolved through any symlinks. The `to` side is left alone, and
 * that asymmetry is the point.
 *
 * Node canonicalizes the paths it hands the inspector: `import.meta.url`, and so
 * every script URL V8 reports, is a realpath. Paths a user writes into a config come
 * out exactly as typed. On macOS `os.tmpdir()` is `/var/…` whose realpath is
 * `/private/var/…`, so a `from` spelled with the symlinked prefix matches no script
 * at all — every script is dropped, the map comes out empty, and every change
 * degrades to `mode: all` for ever, with no error to say why. It fails safe, never
 * under-selecting, but the entire speedup disappears silently.
 *
 * Known and unfixed in the ecosystem: nyc has carried this since 2018
 * (istanbuljs/nyc#1301, plus its many duplicates) and c8 drops symlinked
 * first-party code for the same reason (aspect-build/rules_js#2933). Both of the
 * postmortems written about it reach for the same fix — canonicalize before
 * comparing.
 *
 * Only `from`, though. `from` describes where Node decided to put the generated
 * files, which is not the user's choice and has to be matched as Node spells it.
 * `to` describes where the source files live as the *rest of the toolchain* names
 * them — git above all, since `changesSince` returns paths built on the repo root
 * it was handed. Canonicalizing `to` would move every map key away from what
 * `changesSince` produces, trading one mismatch for another.
 *
 * The generated path is canonicalized too, at the comparison, rather than here —
 * canonicalizing one side only would just move the failure to whichever spelling
 * the other side happened to use.
 *
 * Memoized on the rules array's identity, because `scan` runs once per test window.
 */
export function canonicalProjectionRules(rules: readonly ProjectionRule[]): ProjectionRule[] {
  const cached = canonicalCache.get(rules)
  if (cached !== undefined) return cached
  const resolved = rules.map((rule) => ({ ...rule, from: canonicalPath(rule.from) }))
  canonicalCache.set(rules, resolved)
  return resolved
}
