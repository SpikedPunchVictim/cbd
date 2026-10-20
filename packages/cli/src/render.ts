/**
 * Text rendering: quiet by default, one line per question.
 *
 * The verbs return data and know nothing about a terminal; this module is the only
 * place that turns that data into something a person reads. `--format json` bypasses
 * it entirely — the JSON form is the verb's own result, not a second rendering of
 * it, so a script cannot be told a different story than a human.
 *
 * Paths are shown relative to the repository root, because that is where the reader
 * is. A path outside the root (a map that names another checkout, a relocated lane)
 * is shown as it is rather than as `../../…`, which would hide where it really is.
 */
import { relative } from 'node:path'
import type {
  BuildResult,
  ExplainResult,
  Reason,
  ReachesResult,
  SelectResult,
  StatsResult,
  TestEntry,
} from '@spikedpunch/cbd'
import type { GcResult } from './gc.js'

export const shown = (root: string, path: string): string => {
  const rel = relative(root, path)
  return rel === '' || rel.startsWith('..') ? path : rel
}

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`

const short = (commit: string): string => commit.slice(0, 7)

const behind = (distance: number): string =>
  distance === 0 ? 'up to date' : `${plural(distance, 'commit')} behind`

const size = (bytes: number): string => {
  const kb = bytes / 1024
  return kb < 1024 ? `${Math.round(kb)} kB` : `${(kb / 1024).toFixed(1)} MB`
}

const built = (iso: string): string => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(0, 19).replace('T', ' ')
}

const entryLine = (root: string, entry: TestEntry): string =>
  entry.file === null ? entry.title : `${shown(root, entry.file)} > ${entry.title}`

function reasonLine(root: string, reason: Reason): string {
  switch (reason.kind) {
    case 'function':
      return `${shown(root, reason.file)} > ${reason.fn} (${plural(reason.tests.length, 'test')})`
    case 'file':
      return `${shown(root, reason.file)} (${plural(reason.tests.length, 'test')})`
    case 'test-file':
      return `${shown(root, reason.file)} (test file, ${plural(reason.tests.length, 'test')})`
    case 'always':
      return `alwaysSelect (${plural(reason.tests.length, 'test')})`
    case 'all':
      return reason.file === undefined
        ? reason.why
        : `${reason.why} (${shown(root, reason.file)})`
  }
}

export function selectLines(result: SelectResult, root: string): string[] {
  const lines: string[] = []
  if (result.selection.mode === 'all') {
    for (const reason of result.selection.reasons) lines.push(`all tests: ${reasonLine(root, reason)}`)
  } else {
    for (const entry of result.selected) lines.push(entryLine(root, entry))
  }
  const files = plural(result.changes.length, 'changed file')
  const summary = `${short(result.map.commit)}, ${behind(result.map.distance)}`
  lines.push(
    result.selection.mode === 'all'
      ? `all tests for ${files} (map ${summary})`
      : `${plural(result.selected.length, 'test')} for ${files} (map ${summary})`,
  )
  if (result.selection.ignored.length > 0) {
    lines.push(
      `ignored ${plural(result.selection.ignored.length, 'changed file')}: ` +
        result.selection.ignored.map((path) => shown(root, path)).join(', '),
    )
  }
  return lines
}

export function buildLines(result: BuildResult, root: string): string[] {
  return [
    `map ${shown(root, result.path)}: ${plural(result.tests, 'test')}, ` +
      `${plural(result.files, 'file')} from ${plural(result.shards.length, 'shard')} ` +
      `(${size(result.bytes)})`,
  ]
}

/**
 * The line answer: the function(s) that contain the line, then the tests.
 *
 * Only the containing functions are named. Listing every function in the file
 * would read as "all of these reach this line", which is the opposite of what the
 * line query is for.
 */
function lineDetail(result: ExplainResult): string[] {
  if (result.functions.length === 0) {
    // No function evidence at all: the line is exactly as unexecuted as the file.
    // "Outside every function" would claim the file's tests reach it, which is
    // true only when the map has some. An unknown file's header says the rest.
    return result.seen ? ['  nothing in the file was executed'] : []
  }
  const line = result.line!
  const containing = result.functions.filter(
    (fn) => line >= fn.startLine && line <= fn.endLine,
  )
  return [
    containing.length > 0
      ? `  functions: ${containing.map((fn) => fn.key).join(', ')}`
      : '  outside every function: the whole file’s tests',
    ...result.tests.map((title) => `  ${title}`),
  ]
}

export function explainLines(result: ExplainResult, root: string): string[] {
  const where =
    result.line === undefined
      ? shown(root, result.file)
      : `${shown(root, result.file)}:${result.line}`
  // A zero answer is ambiguous on its own: the map may have seen the file and
  // found no test in it, or never heard of it at all, and those are opposite
  // instructions to `select`. Say which one this is.
  const note = result.seen
    ? result.tests.length === 0
      ? ' (seen, no test reaches it)'
      : ''
    : ' (not in the map: select runs all)'
  const lines = [`${where} — ${plural(result.tests.length, 'test')}${note}`]
  if (result.buckets.length > 0) lines.push(`  reached at ${result.buckets.join(', ')}`)

  if (result.line === undefined) {
    // Without a line, the functions are the answer: each one's tests are what the
    // map actually recorded, and the union above would only repeat them.
    for (const fn of result.functions) {
      const tests = fn.tests.length === 0 ? 'no tests' : fn.tests.join(', ')
      lines.push(`  ${fn.key} (${fn.startLine}-${fn.endLine}): ${tests}`)
    }
  } else {
    lines.push(...lineDetail(result))
  }
  return lines
}

export function reachesLines(result: ReachesResult, root: string): string[] {
  const where =
    result.target.line === undefined
      ? shown(root, result.target.file)
      : `${shown(root, result.target.file)}:${result.target.line}`
  const who = `${result.test.title}${
    result.test.file === null ? '' : ` (${shown(root, result.test.file)})`
  }`
  const note = result.seen ? '' : ' (file not in the map: select runs all)'
  const lines = [`${who} ${result.reaches ? 'reaches' : 'does not reach'} ${where}${note}`]

  if (result.functions.length > 0) {
    lines.push('  through:')
    for (const fn of result.functions) lines.push(`  ${fn.key} (${fn.startLine}-${fn.endLine})`)
  }
  if (
    result.target.line !== undefined &&
    !result.functions.some(
      (fn) => result.target.line! >= fn.startLine && result.target.line! <= fn.endLine,
    )
  ) {
    // The answer came from the file-level rule, not from a function this test ran.
    lines.push('  (the line is outside this test\'s functions; the file-level rule answers)')
  }
  return lines
}

export function statsLines(result: StatsResult, root: string): string[] {
  const map = result.map
  const lines = [
    `map ${short(map.commit)} (${behind(map.distance)}, ` +
      `${map.dirty ? 'dirty tree' : 'clean tree'}, built ${built(map.builtAt)})`,
    `${plural(result.tests, 'test')}, ${plural(result.files, 'file')} reached, ` +
      `${plural(result.seen, 'file')} seen, ${plural(result.untested, 'file')} untested`,
    `buckets: load ${result.buckets.load}, between ${result.buckets.between}, ` +
      `teardown ${result.buckets.teardown}`,
    `test files: ${result.testFiles.files} (median ${result.testFiles.median}, ` +
      `p90 ${result.testFiles.p90}, max ${result.testFiles.max})`,
  ]
  lines.push(
    `code: ${plural(result.functions, 'function')} in ${plural(result.files, 'file')} ` +
      `(per file median ${result.functionsPerFile.median}, p90 ${result.functionsPerFile.p90}, ` +
      `max ${result.functionsPerFile.max}); tests per function median ` +
      `${result.testsPerFunction.median}, p90 ${result.testsPerFunction.p90}, ` +
      `max ${result.testsPerFunction.max}`,
  )
  if (result.topFiles.length > 0) {
    lines.push('most-tested files:')
    for (const file of result.topFiles.slice(0, 5)) {
      lines.push(
        `  ${shown(root, file.file)}: ${plural(file.tests, 'test')}, ` +
          `${plural(file.functions, 'function')}`,
      )
    }
  }
  if (result.duplicateTests.length > 0) {
    lines.push('duplicate titles (distinguished by ordinal in the map):')
    for (const group of result.duplicateTests.slice(0, 5)) {
      lines.push(`  ${shown(root, group.file ?? '(no file)')}: ${group.title} (${String(group.count)})`)
    }
  }
  if (result.untestedFiles.length > 0) {
    // The count above says how big the gap is; these lines say where it is. A file
    // that no process loaded is not here — the map cannot name it — and `select`
    // runs everything for one, so say that rather than let the list read as
    // "everything else is covered".
    lines.push('untested (seen, no test reaches):')
    for (const file of result.untestedFiles) lines.push(`  ${shown(root, file)}`)
    lines.push('  a file no run loaded is unknown, not untested: select runs all for it')
  }
  return lines
}

export function gcLines(result: GcResult): string[] {
  const kept =
    `${result.shards.kept} shard${result.shards.kept === 1 ? '' : 's'} and ` +
    `${result.maps.kept} map${result.maps.kept === 1 ? '' : 's'}`
  const removed = result.shards.removed + result.maps.removed
  const freed =
    removed === 0
      ? 'nothing to remove'
      : `removed ${plural(result.shards.removed, 'shard')} and ` +
        `${plural(result.maps.removed, 'map')} (${size(result.bytes)})`
  return [`kept ${kept}, ${freed}`]
}

export function renderJson(value: unknown): string[] {
  return [JSON.stringify(value, null, 2)]
}
