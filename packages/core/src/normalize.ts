/**
 * V8 coverage payload -> stable `(file, function)` identities.
 *
 * Two decisions worth stating, because both were measured rather than assumed:
 *
 * ORDINALS COME FROM THE WHOLE FILE, NOT THE EXECUTED SET.
 *   V8 reports every function in any script that has coverage, including
 *   zero-count ones (`.explore/spike/ordinal-probe.mjs`: three same-named `parse`
 *   methods reported with counts 0, 1, 0). If ordinals were assigned over the
 *   executed functions alone, a window running only the second `parse` would
 *   call it `parse@0` while a window running both would call it `parse@1`, and
 *   every key would drift between windows. Assigning them over the full list —
 *   which is what `scan` does — makes `name@ordinal` stable, and lets line
 *   numbers be data rather than identity.
 *
 * `scan` IS THE PRIMITIVE; `normalize` IS A FILTER OVER IT.
 *   The executed/not-executed distinction is one boolean, and carrying it all
 *   the way through means the inverse map ("what does no test reach?") costs
 *   nothing extra to build later.
 */
import { FileCache } from './line-index.js'
import { createScriptResolver } from './source-maps.js'
import type { ProjectionRule } from './projection.js'
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

export interface ScanOptions {
  /** Rules joining build output back to source when no map exists. */
  projection?: ProjectionRule[]
  /** Applied to the ORIGINAL file path, after resolution. */
  include?: (file: string) => boolean
  exclude?: (file: string) => boolean
  /**
   * Cheap filter on the generated script URL, applied before any file is read.
   * Resolving a script costs a stat and a read, so rejecting early is worth it.
   */
  prefilter?: (url: string) => boolean
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

function displayName(fn: V8Function, range: V8Range, scriptLength: number): string {
  // Spanning the whole script, not merely starting at zero: a file that begins
  // with a bare `function` declaration also has a function at offset 0, and
  // calling that the module body would misname a real function.
  if (range.startOffset === 0 && range.endOffset >= scriptLength) return MODULE_NAME
  return fn.functionName === '' ? ANONYMOUS_NAME : fn.functionName
}

export function scan(
  payload: V8ScriptCoverage[],
  source: Source,
  options: ScanOptions = {},
): Definition[] {
  const cache = new FileCache()
  const projection = options.projection ?? []
  const prefilter = options.prefilter ?? defaultPrefilter
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
      located.push({ fn, range, file: at.file, startLine: at.line })
    }

    // Within one script, generated offset order is source order.
    located.sort((a, b) => a.range.startOffset - b.range.startOffset)

    const counters = new Map<string, number>()
    for (const item of located) {
      const name = displayName(item.fn, item.range, resolver.length)
      const bucket = `${item.file}\u0000${name}`
      const ordinal = counters.get(bucket) ?? 0
      counters.set(bucket, ordinal + 1)

      const end = resolver.original(item.range.endOffset)
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
