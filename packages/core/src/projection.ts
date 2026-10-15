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

/** True when `file` is inside `prefix`, on a path boundary. */
function within(file: string, prefix: string): boolean {
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
    const joined = `${rule.to.replace(/\/$/, '')}/${rest}`
    return swapExtension(joined, rule.extensions ?? DEFAULT_EXTENSIONS)
  }
  return null
}
