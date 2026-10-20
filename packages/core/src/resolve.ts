/**
 * Build-time resolution: a v2 shard's byte ranges -> the map's identities.
 *
 * This is ADR-0002's other half. The recorder writes what V8 said — a script id,
 * a start offset, an end offset — and every path lookup, source-map query and
 * ordinal assignment happens here, exactly once per distinct `(script, function)`.
 * The recorder's hot loop is then O(executed functions), not O(windows × functions).
 *
 * Three rules make the result safe rather than merely fast:
 *
 *   **The bytes must be the same bytes.** An offset means nothing against a
 *   different build. Each script row records the file's size and mtime, and a
 *   mismatch refuses the shard (`cbd-7d5`). Refusing is the only answer that cannot
 *   under-select; guessing would attribute a range to whatever now sits at that
 *   offset, silently.
 *
 *   **Ordinals come from the union over every window.** The recorder emits a
 *   function row the first time any window reports it, so the set here is complete
 *   even when V8's first sighting of a script was partial. Sorting that union by
 *   source position is the proper fix for the A4 anonymous-arrow collision.
 *
 *   **Anything unresolvable is dropped, never guessed.** A script with no readable
 *   map resolves to no identities, and the file simply does not enter the map. A
 *   change to it then reaches §8.3's unknown-file rule and runs everything — the
 *   safe direction.
 */
import { statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FileCache, sameLineStarts } from './line-index.js'
import { displayName, type ScanOptions } from './normalize.js'
import { canonicalProjectionRules } from './projection.js'
import { createRelocator } from './relocate.js'
import { createScriptResolver, sourceMapUrlOf } from './source-maps.js'
import {
  summarizeShard,
  type ShardFunction,
  type ShardHeader,
  type ShardInput,
  type ShardScript,
  type ShardTest,
  type ShardTouch,
  type TouchRef,
} from './shard.js'

/** A test with its touches resolved into the map's coordinates. */
export interface ResolvedTest {
  title: string
  file: string | null
  /** Repeated-title discriminator from the shard; absent for the first. */
  ordinal?: number
  status: ShardTest['status']
  durationMs: number
  touches: TouchRef[]
}

export interface ResolvedShard {
  /** The shard's name, kept for the map's provenance. */
  name: string
  header: ShardHeader
  tests: ResolvedTest[]
  load: TouchRef[]
  between: TouchRef[]
  teardown: TouchRef[]
}

export interface ResolveOptions {
  /**
   * The build-side half of the scan: projection and relocation rules, and the
   * include/exclude filters.
   *
   * These moved here in v2. A shard carries byte ranges, which are only meaningful
   * once a build says how to read them, and the same rules must apply at build time
   * that the recording assumed. `prefilter` and `selfRoots` are record-time only:
   * they decide which scripts enter the shard at all.
   */
  scan?: ScanOptions
  /** Shared across shards so a generated file is read and indexed once per build. */
  cache?: FileCache
}

/**
 * A shard whose script no longer matches the bytes its offsets were measured
 * against.
 *
 * A distinct type because the caller's answer is always "re-record", and because a
 * test that expects a stale shard to be refused should not have to match a message.
 */
export class StaleShardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleShardError'
  }
}

interface Identity {
  file: string
  key: string
  startLine: number
  endLine: number
}

/**
 * A function's identity inside a shard: its **range**, not just its start.
 *
 * A start offset alone is not unique. Jest compiles a CommonJS module inside a VM
 * wrapper, and V8 reports the wrapper (`0-777`) and the first function it contains
 * (`add`, `0-38`) with the same start. Keying by start merged them, and the map
 * lost every function that began at offset 0 (`cbd-xnp.2`).
 */
const rangeKey = (start: number, end: number): string => `${String(start)}\u0000${String(end)}`

const refId = (ref: TouchRef): string => `${ref[0]}\u0000${ref[1]}`

function unionInto(target: Map<string, TouchRef>, refs: TouchRef[]): void {
  for (const ref of refs) {
    const id = refId(ref)
    const existing = target.get(id)
    if (existing === undefined) {
      target.set(id, [ref[0], ref[1], ref[2], ref[3]])
      continue
    }
    existing[2] = Math.min(existing[2], ref[2])
    existing[3] = Math.max(existing[3], ref[3])
  }
}

/**
 * The script table, validated.
 *
 * A shard is written append-only by one process, so a duplicate is a writer bug.
 * Identical duplicates are tolerated (a shard may be concatenated by a caller);
 * contradictory ones are refused, because the build would otherwise pick one
 * arbitrarily.
 */
function scriptTable(scripts: ShardScript[], name: string): Map<string, ShardScript> {
  const table = new Map<string, ShardScript>()
  for (const script of scripts) {
    const prior = table.get(script.scriptId)
    if (prior === undefined) {
      table.set(script.scriptId, script)
      continue
    }
    if (prior.url !== script.url || prior.size !== script.size || prior.mtimeMs !== script.mtimeMs) {
      throw new Error(
        `cbd: shard ${name} records script ${script.scriptId} twice with different content ` +
          `(${prior.url} and ${script.url}); the shard is inconsistent`,
      )
    }
    // A transformed script's generated line starts arrive in an end-of-run update
    // row (`cbd-x2j`). Adopt them; two different generated shapes for one script
    // are a writer bug the build must not choose between.
    if (script.generated !== undefined) {
      if (prior.generated === undefined) {
        table.set(script.scriptId, { ...prior, generated: script.generated })
      } else if (
        prior.generated.length !== script.generated.length ||
        !sameLineStarts(prior.generated.lineStarts, script.generated.lineStarts)
      ) {
        throw new Error(
          `cbd: shard ${name} records two different generated shapes for script ` +
            `${script.scriptId}; the shard is inconsistent`,
        )
      }
    }
  }
  return table
}

/** The function table, keyed by script and then by the function's range. */
function functionTable(
  functions: ShardFunction[],
  name: string,
): Map<string, Map<string, ShardFunction>> {
  const table = new Map<string, Map<string, ShardFunction>>()
  for (const fn of functions) {
    let byRange = table.get(fn.scriptId)
    if (byRange === undefined) {
      byRange = new Map()
      table.set(fn.scriptId, byRange)
    }
    const id = rangeKey(fn.start, fn.end)
    const prior = byRange.get(id)
    if (prior === undefined) {
      byRange.set(id, fn)
      continue
    }
    if (prior.name !== fn.name) {
      throw new Error(
        `cbd: shard ${name} records the function at script ${fn.scriptId} range ` +
          `${String(fn.start)}-${String(fn.end)} twice with different names; the shard is inconsistent`,
      )
    }
  }
  return table
}

/**
 * The file a script ran from, as the stable tree spells it.
 *
 * `relocate` is applied here rather than only to resolved sources because a
 * deployed lane runs a *copy*: its script URLs name the copy, which is gone by the
 * time anyone rebuilds the map (ADR-0006). The rule says the copy was built from
 * the checkout, so the checkout's file is the one whose bytes the offsets describe
 * — and it is the file whose size and mtime can still be checked.
 */
function stablePath(url: string, relocate: (file: string) => string): string | null {
  try {
    return relocate(fileURLToPath(url))
  } catch {
    return null
  }
}

/**
 * Refuse a script whose bytes no longer match the ones the run recorded.
 *
 * The guard is separate from resolution because it answers a different question —
 * "are these the same bytes?" — and because it is the one failure that cannot be
 * recovered from: an offset into different bytes attributes code to whatever now
 * occupies that range, silently and in the under-selecting direction.
 */
function verifyScript(script: ShardScript, path: string): void {
  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    throw new StaleShardError(
      `cbd: the build cannot read ${path}, which the recorded run executed. The offsets were ` +
        `measured against that file; re-record the run. (${String(error)})`,
    )
  }
  if (stat.size !== script.size || stat.mtimeMs !== script.mtimeMs) {
    throw new StaleShardError(
      `cbd: ${path} changed since it was recorded (size ${String(script.size)} -> ${String(stat.size)}, ` +
        `mtime ${String(script.mtimeMs)} -> ${String(stat.mtimeMs)}). Byte offsets are only meaningful ` +
        'against the bytes they were measured from, so this shard is refused; re-record the run.',
    )
  }
}

/** Resolve one script's functions, once. */
function identitiesFor(
  script: ShardScript,
  functions: ShardFunction[],
  path: string,
  options: ResolveOptions,
  relocate: (file: string) => string,
): Map<string, Identity> {
  const empty = new Map<string, Identity>()
  verifyScript(script, path)

  // Resolve against the stable path, not the URL the shard names: a lane's copy is
  // gone by build time and the checkout's identical bytes are what remain. A
  // relative sourceMappingURL then resolves beside the checkout's file, which is
  // the map that describes those bytes.
  const cache = options.cache ?? new FileCache()
  const stableUrl = pathToFileURL(path).href
  // The shard omits a map the file itself declares; recover it from the same
  // bytes `verifyScript` just checked (`cbd-n9t.1`). A row that carries one — a
  // loader-injected map with no on-disk comment — keeps it.
  const sourceMapURL = script.sourceMapURL ?? sourceMapUrlOf(cache.text(path) ?? '')
  const generatedIndex =
    script.generated === undefined
      ? undefined
      : { starts: script.generated.lineStarts, length: script.generated.length }
  const resolver = createScriptResolver(
    stableUrl,
    {
      url: stableUrl,
      ...(sourceMapURL === undefined ? {} : { sourceMapURL }),
    },
    {
      projection: canonicalProjectionRules(options.scan?.projection ?? []),
      cache,
      ...(generatedIndex === undefined ? {} : { index: generatedIndex }),
    },
  )
  if (resolver === null) return empty

  const include = options.scan?.include
  const exclude = options.scan?.exclude

  let maxEnd = 0
  for (const fn of functions) if (fn.end > maxEnd) maxEnd = fn.end

  const located: Array<{
    fn: ShardFunction
    startLine: number
    endLine: number
    file: string
  }> = []
  for (const fn of functions) {
    const at = resolver.original(fn.start)
    if (at === null) continue
    // No forward fallback for the end, for the same reason `scan` takes none: it
    // would swallow the rest of the file into a one-line function.
    const end = resolver.original(fn.end, false)
    const file = relocate(at.file)
    if (include !== undefined && !include(file)) continue
    if (exclude !== undefined && exclude(file)) continue
    located.push({ fn, startLine: at.line, endLine: end?.line ?? at.line, file })
  }

  // Within one script, resolved source order is the file's order. The union is
  // complete here — every function any window executed — which is what makes this
  // ordinal stable and why the A4 collision cannot recur.
  located.sort(
    (a, b) => a.startLine - b.startLine || a.fn.start - b.fn.start || a.fn.end - b.fn.end,
  )

  const seen = new Map<string, number>()
  const identities = new Map<string, Identity>()
  for (const item of located) {
    const name = displayName(
      { functionName: item.fn.name, isBlockCoverage: false, ranges: [] },
      { startOffset: item.fn.start, endOffset: item.fn.end, count: 1 },
      maxEnd,
    )
    const ordinal = seen.get(name) ?? 0
    seen.set(name, ordinal + 1)
    identities.set(rangeKey(item.fn.start, item.fn.end), {
      file: item.file,
      key: `${name}@${ordinal}`,
      startLine: item.startLine,
      endLine: item.endLine,
    })
  }
  return identities
}

/**
 * A window naming a script or function the table does not describe is a broken
 * shard, not a file that happens to be unresolvable.
 *
 * Checked before any file is read, because reporting the difference is what keeps
 * a truncated shard from looking like a small map.
 */
function checkReferences(
  name: string,
  windows: ShardTouch[],
  scripts: Map<string, ShardScript>,
  functions: Map<string, Map<string, ShardFunction>>,
): void {
  for (const window of windows) {
    for (const [scriptId, ranges] of Object.entries(window)) {
      const byRange = functions.get(scriptId)
      if (!scripts.has(scriptId)) {
        throw new Error(
          `cbd: shard ${name} references script ${scriptId} in a window but has no script ` +
            'record for it; the shard is incomplete or inconsistent',
        )
      }
      for (const [start, end] of ranges) {
        if (byRange?.get(rangeKey(start, end)) === undefined) {
          throw new Error(
            `cbd: shard ${name} references the function at script ${scriptId} offset ` +
              `${String(start)} in a window but has no function record for it; the shard is ` +
              'incomplete or inconsistent',
          )
        }
      }
    }
  }
}

/** Resolve a whole shard. */
export function resolveShard(input: ShardInput, options: ResolveOptions = {}): ResolvedShard {
  const { header, tests, load, between, teardown, scripts, functions } = summarizeShard(input.records)
  const scriptRows = scriptTable(scripts, input.name)
  const functionRows = functionTable(functions, input.name)

  // Tests and buckets have different shapes — a test carries its touches under
  // `touches`, a bucket *is* its touches — so flatten to the one shape first.
  checkReferences(
    input.name,
    [...tests.map((test) => test.touches), ...load, ...between, ...teardown],
    scriptRows,
    functionRows,
  )

  const relocate = createRelocator(options.scan?.relocate ?? [])
  const cache = options.cache ?? new FileCache()
  const identities = new Map<string, Map<string, Identity>>()
  for (const [scriptId, script] of scriptRows) {
    const path = stablePath(script.url, relocate)
    if (path === null) {
      identities.set(scriptId, new Map())
      continue
    }
    identities.set(
      scriptId,
      identitiesFor(script, [...(functionRows.get(scriptId)?.values() ?? [])], path, {
        ...options,
        cache,
      }, relocate),
    )
  }

  /** One window's raw ranges in the map's coordinates, unioned per function. */
  const touchesOf = (touch: ShardTouch): TouchRef[] => {
    const merged = new Map<string, TouchRef>()
    for (const [scriptId, ranges] of Object.entries(touch)) {
      const byRange = identities.get(scriptId)
      if (byRange === undefined) continue
      for (const [start, end] of ranges) {
        const identity = byRange.get(rangeKey(start, end))
        // Unresolvable or filtered out: the file does not enter the map, and
        // §8.3's unknown-file rule escalates a change to it.
        if (identity === undefined) continue
        unionInto(merged, [[identity.file, identity.key, identity.startLine, identity.endLine]])
      }
    }
    return [...merged.values()]
  }

  return {
    name: input.name,
    header,
    tests: tests.map((test) => ({
      title: test.title,
      file: test.file,
      ...(test.ordinal === undefined ? {} : { ordinal: test.ordinal }),
      status: test.status,
      durationMs: test.durationMs,
      touches: touchesOf(test.touches),
    })),
    load: load.flatMap(touchesOf),
    between: between.flatMap(touchesOf),
    teardown: teardown.flatMap(touchesOf),
  }
}
