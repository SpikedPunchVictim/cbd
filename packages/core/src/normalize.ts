/**
 * V8 coverage payload -> stable `(file, function)` identities.
 *
 * Two decisions worth stating, because both were measured rather than assumed:
 *
 * ORDINALS COME FROM THE FIRST SIGHTING OF A SCRIPT, NOT FROM EACH WINDOW.
 *   The obvious approach — assign ordinals from the function list in the payload —
 *   is wrong, and wrong in a way that corrupts data silently. V8 reports a
 *   script's FULL function list only on the take taken just after it is compiled;
 *   on later takes it reports only the functions that had activity, plus the
 *   module body's absence. Measured on the fixture's `src/helpers.js`: a mid-run
 *   take reported two functions where the file has six.
 *
 *   So two different anonymous arrows, each the only anonymous function in its own
 *   window, would both be called `<anonymous>@0`, be merged by key, and produce a
 *   range spanning both — observed as an "arrow" at lines 8-24.
 *
 *   The fix is a per-script registry, seeded the first time a script is seen and
 *   consulted thereafter. Within one process a script's generated offsets never
 *   change, so an offset is an exact identity for a function. This is what
 *   CBD.md §6.3's `file` record is for.
 *
 *   KNOWN LIMITATION: the first sighting is not always complete either. In the
 *   fixture, a take during import already omitted the arrow inside `repeat`, so
 *   that function was appended later and carries a higher ordinal than its source
 *   position implies. Ordinals are therefore deterministic for a given build and
 *   suite, which is what selection needs — the map is rebuilt per commit, and a
 *   hunk is matched against line ranges, never against keys from another map — but
 *   they are NOT guaranteed to survive an arbitrary edit elsewhere in the file, as
 *   CBD.md hoped. Getting that properly means deferring key assignment to
 *   `cbd build`, where the union over every window is known. Worth revisiting.
 *
 * `scan` IS THE PRIMITIVE; `normalize` IS A FILTER OVER IT.
 *   The executed/not-executed distinction is one boolean, and carrying it all
 *   the way through means the inverse map ("what does no test reach?") costs
 *   nothing extra to build later.
 */
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FileCache } from './line-index.js'
import { createScriptResolver } from './source-maps.js'
import { canonicalProjectionRules, type ProjectionRule } from './projection.js'
import { createRelocator, type RelocationRule } from './relocate.js'
import { CBD_SELF_ROOTS } from './self.js'
import type { Source, V8Function, V8Range, V8ScriptCoverage } from './types.js'

export interface Definition {
  /** Absolute path of the original source file. */
  file: string
  /** `name@ordinal`, stable across edits elsewhere in the file. */
  key: string
  name: string
  ordinal: number
  /** Line range in ORIGINAL coordinates. Data, not identity. */
  startLine: number
  endLine: number
  /** Which path joined the generated file back to its source. */
  via: 'source-map' | 'projection'
  /** True when the function ran during the window this payload covers. */
  executed: boolean
}

/** A `Definition` that is known to have executed. */
export type Touch = Omit<Definition, 'executed'>

/**
 * `scriptUrl` -> (`generated start offset` -> name and ordinal).
 *
 * Seeded the first time a script appears, when its payload still holds the whole
 * function list. Pass the same instance to every `scan` call in a run.
 */
export type OrdinalRegistry = Map<string, Map<number, { name: string; ordinal: number }>>

export interface ScanOptions {
  /** Rules joining build output back to source when no map exists. */
  projection?: ProjectionRule[]
  /**
   * Rules joining a path that resolved into a *copy* of the tree back to the
   * checkout, applied to the resolved ORIGINAL path — after the map, before
   * `include`/`exclude`. For a service that runs from a deployment copy, whose
   * maps resolve inside the copy: see `relocate.ts` and ADR-0006.
   */
  relocate?: RelocationRule[]
  /** Applied to the ORIGINAL file path, after resolution. */
  include?: (file: string) => boolean
  exclude?: (file: string) => boolean
  /**
   * Package roots of the tool itself — core's is always excluded, and an adapter
   * adds its own (`cbd-qly`). Scripts under them are dropped no matter what, even
   * when a caller replaces `prefilter`: the exclusion is a floor, not a default.
   */
  selfRoots?: readonly string[]
  /**
   * Cheap filter on the generated script URL, applied before any file is read.
   * Resolving a script costs a stat and a read, so rejecting early is worth it.
   * A custom prefilter narrows further; it cannot opt the tool's own code back in.
   */
  prefilter?: (url: string) => boolean
  /** Shared across the windows of a run; see `OrdinalRegistry`. */
  ordinals?: OrdinalRegistry
  /**
   * Keep the tool's own code when that code is what the suite tests.
   *
   * The self-root floor exists so the recorder's own bookkeeping — serializing a
   * take, normalizing, writing the shard — does not enter every window. Dogfooding
   * inverts that: CBD records its own suites, and a map that omits
   * `packages/core/src` answers every source change with `mode: all`. With this
   * set, core's roots and any adapter's `selfRoots` are not applied; the recorder's
   * work is attributed like any other code. That over-selects (its work lands in
   * `@between` and in the window after a take), which is the safe direction.
   */
  includeSelf?: boolean
}

/** The module body: V8 gives it no name, and its range spans the whole script. */
const MODULE_NAME = '<module>'
const ANONYMOUS_NAME = '<anonymous>'

function defaultPrefilter(url: string): boolean {
  if (!url.startsWith('file:')) return false
  // Dependency code is excluded from the map by design, so it is not worth
  // reading the file to discover that.
  return !url.includes('/node_modules/')
}

/**
 * Both spellings of a root, because a script URL can carry either one.
 *
 * Node resolves a loaded module's URL through symlinks, so the realpath is the
 * production case; a caller that synthesizes a payload (or runs on macOS, where
 * `/tmp` is `/private/tmp`) can hand over the unresolved one. A root that cannot
 * be resolved is inert rather than fatal: the caller named it, not this code.
 */
function rootVariants(root: string): string[] {
  try {
    const real = realpathSync(root)
    return real === root ? [root] : [root, real]
  } catch {
    return [root]
  }
}

/**
 * The scan's own filter, with the tool's roots as a floor.
 *
 * A consumer's `prefilter` can narrow the scan but cannot opt the tool back in
 * (`cbd-qly`). Core's roots are always present; an adapter adds its own package's
 * because core cannot know where that package was installed.
 */
export function scriptPrefilter(options: ScanOptions): (url: string) => boolean {
  const accept = options.prefilter ?? defaultPrefilter
  // `includeSelf` is the dogfooding switch: the tool's implementation is the code
  // under test, so the floor is exactly wrong. See `ScanOptions.includeSelf`.
  const roots =
    options.includeSelf === true
      ? []
      : [...CBD_SELF_ROOTS, ...(options.selfRoots ?? [])].flatMap(rootVariants)
  return (url) => accept(url) && !withinRoots(url, roots)
}

/**
 * Whether a script URL is one of the tool's own files.
 *
 * The `file:` test matters: a `node:` or `data:` URL has no path to compare, and
 * `fileURLToPath` would throw for it. The separator check is what keeps
 * `/repo/packages/core-extra` from being treated as inside `/repo/packages/core`.
 */
function withinRoots(url: string, roots: readonly string[]): boolean {
  if (!url.startsWith('file:')) return false
  let file: string
  try {
    file = fileURLToPath(url)
  } catch {
    return false
  }
  return roots.some((root) => file === root || file.startsWith(`${root.replace(/\/+$/, '')}${sep}`))
}

export function displayName(fn: V8Function, range: V8Range, maxEndOffset: number): string {
  // The module body starts at zero AND contains every other function in the
  // script. Two weaker tests both fail: `startOffset === 0` alone misnames a file
  // that opens with a bare `function` declaration, and `endOffset >= the file's
  // length` fails because the module body stops at its closing brace, short of a
  // trailing `//# sourceMappingURL` comment line.
  if (range.startOffset === 0 && range.endOffset >= maxEndOffset) return MODULE_NAME
  return fn.functionName === '' ? ANONYMOUS_NAME : fn.functionName
}

export function scan(
  payload: V8ScriptCoverage[],
  source: Source,
  options: ScanOptions = {},
): Definition[] {
  const cache = new FileCache()
  const projection =
    options.projection === undefined || options.projection.length === 0
      ? []
      : canonicalProjectionRules(options.projection)
  const prefilter = scriptPrefilter(options)
  // Rules are canonicalized once here, not per resolved file: `scan` runs once per
  // test window, and every window resolves the same few hundred paths.
  const relocate = createRelocator(options.relocate)
  const scripts = source.scripts()

  // file -> key -> Definition, so a file loaded by more than one script still
  // yields one row per function.
  const merged = new Map<string, Definition>()

  for (const script of payload) {
    if (!prefilter(script.url)) continue

    const resolver = createScriptResolver(script.url, scripts.get(script.scriptId), {
      projection,
      cache,
    })
    if (resolver === null) continue

    // Resolve every function, executed or not: ordinals depend on the full list.
    const located: Array<{ fn: V8Function; range: V8Range; file: string; startLine: number }> = []
    for (const fn of script.functions) {
      const range = fn.ranges[0]
      if (range === undefined) continue
      const at = resolver.original(range.startOffset)
      if (at === null) continue
      located.push({ fn, range, file: relocate(at.file), startLine: at.line })
    }

    // The module body is the function that contains all the others.
    let maxEndOffset = 0
    for (const item of located) {
      if (item.range.endOffset > maxEndOffset) maxEndOffset = item.range.endOffset
    }

    // Within one script, generated offset order is source order.
    located.sort((a, b) => a.range.startOffset - b.range.startOffset)

    const registry = options.ordinals
    let known = registry?.get(script.url)
    if (known === undefined) {
      // First sighting: the payload is complete, so this is the real function list.
      known = new Map()
      const seen = new Map<string, number>()
      // Source order, so ordinals follow the file rather than the order V8
      // happened to surface the functions in.
      const bySource = [...located].sort(
        (a, b) => a.startLine - b.startLine || a.range.startOffset - b.range.startOffset,
      )
      for (const item of bySource) {
        const name = displayName(item.fn, item.range, maxEndOffset)
        const ordinal = seen.get(name) ?? 0
        seen.set(name, ordinal + 1)
        known.set(item.range.startOffset, { name, ordinal })
      }
      registry?.set(script.url, known)
    }

    for (const item of located) {
      let resolved = known.get(item.range.startOffset)
      if (resolved === undefined) {
        // Not in the seeding payload — a partial first sighting, or a function
        // that only starts running later. Give it the next free ordinal and
        // remember it: stable for the rest of the run, and never colliding.
        const name = displayName(item.fn, item.range, maxEndOffset)
        let next = 0
        for (const entry of known.values()) if (entry.name === name) next += 1
        resolved = { name, ordinal: next }
        known.set(item.range.startOffset, resolved)
      }
      const { name, ordinal } = resolved

      // No forward fallback: an unmappable end offset collapses to the start,
      // which understates the range by a line or two rather than swallowing the
      // rest of the file.
      const end = resolver.original(item.range.endOffset, false)
      const key = `${name}@${ordinal}`
      const identity = `${item.file}\u0000${key}`

      const previous = merged.get(identity)
      if (previous) {
        previous.startLine = Math.min(previous.startLine, item.startLine)
        previous.endLine = Math.max(previous.endLine, end?.line ?? item.startLine)
        previous.executed ||= item.range.count > 0
        continue
      }

      merged.set(identity, {
        file: item.file,
        key,
        name,
        ordinal,
        startLine: item.startLine,
        endLine: end?.line ?? item.startLine,
        via: resolver.via,
        executed: item.range.count > 0,
      })
    }
  }

  const { include, exclude } = options
  return [...merged.values()]
    .filter((d) => (include === undefined || include(d.file)))
    .filter((d) => (exclude === undefined || !exclude(d.file)))
    .sort((a, b) => (a.file === b.file ? a.key.localeCompare(b.key) : a.file.localeCompare(b.file)))
}

/** The functions that ran during this window. */
export function normalize(
  payload: V8ScriptCoverage[],
  source: Source,
  options: ScanOptions = {},
): Touch[] {
  return scan(payload, source, options)
    .filter((d) => d.executed)
    .map(({ executed: _executed, ...touch }) => touch)
}
