/**
 * The append-only shard: what a single test run writes on its way past.
 *
 * One JSON line per record, a header first and a footer last. The footer is the
 * point: a run that is killed part-way leaves a file that parses but is missing
 * its end, and a partial run's coverage is *silently wrong* rather than merely
 * incomplete — a test that aborted early executed less than it should have, so
 * its recorded touches under-select. Refusing such a shard is the only safe
 * behaviour, and it is why the footer exists rather than trusting the file.
 *
 * Append-as-you-go rather than write-at-the-end, for the same reason: a crash
 * should leave evidence of how far it got.
 */
import { appendFileSync } from 'node:fs'
import type { DriftStats } from './types.js'

export const SHARD_VERSION = 1

/**
 * `[file, key, startLine, endLine]` — the same tuple the map stores, so building
 * a map is a merge rather than a transformation.
 */
export type TouchRef = [file: string, key: string, startLine: number, endLine: number]

export interface ShardHeader {
  type: 'shard'
  version: number
  commit: string
  pid: number
  startedAt: string
}

export interface ShardTest {
  type: 'test'
  title: string
  file: string | null
  /** A non-green test's window is not trustworthy; the map builder drops these. */
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number
  touches: TouchRef[]
}

/**
 * Executed outside any test window. Three buckets, and the difference matters
 * because §8.3 treats them differently: a file reached only by `@load` or
 * `@teardown` is startup code and forces `mode: all`, while `@between` has its
 * own policy knob.
 */
export interface ShardBucket {
  type: 'load' | 'between' | 'teardown'
  touches: TouchRef[]
}

export interface ShardFooter {
  type: 'end'
  tests: number
  finishedAt: string
  /**
   * How far this run's window boundaries landed from where they were meant, when
   * the source that produced them had a boundary to miss. Absent for a synchronous
   * source, whose take answers in the tick it was asked and has no distance to
   * travel.
   *
   * It is in the record rather than in a caller's memory because it is a property of
   * the run, and a run is read long after the process that produced it has gone. A
   * map built from windows that slid is a map whose attribution is approximate, and
   * the difference between "this run was sharp" and "this run was not" should be
   * legible from the shard alone — the alternative is re-reading the source's
   * docblock and hoping.
   *
   * Additive and optional, so a shard written before this field existed still parses
   * and still means what it said.
   */
  drift?: DriftStats
}

export type ShardRecord = ShardHeader | ShardTest | ShardBucket | ShardFooter

export class IncompleteShardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IncompleteShardError'
  }
}

/** Somewhere to append lines. A file in production, a string in tests. */
export interface ShardSink {
  append(line: string): void
}

export class FileSink implements ShardSink {
  #path: string
  constructor(path: string) {
    this.#path = path
  }
  append(line: string): void {
    appendFileSync(this.#path, `${line}\n`)
  }
}

export class StringSink implements ShardSink {
  lines: string[] = []
  append(line: string): void {
    this.lines.push(line)
  }
  get text(): string {
    return this.lines.length === 0 ? '' : `${this.lines.join('\n')}\n`
  }
}

export function parseShard(text: string, source = '<shard>'): ShardRecord[] {
  const records: ShardRecord[] = []
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (line === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new IncompleteShardError(`${source}:${index + 1} is not valid JSON`)
    }
    records.push(parsed as ShardRecord)
  }

  if (records.length === 0) throw new IncompleteShardError(`${source} is empty`)
  const first = records[0]
  if (first?.type !== 'shard') {
    throw new IncompleteShardError(`${source} does not start with a shard header`)
  }
  const last = records[records.length - 1]
  if (last?.type !== 'end') {
    throw new IncompleteShardError(
      `${source} has no end record — the run was interrupted, so its coverage is partial`,
    )
  }
  return records
}

/** Split records back into the buckets a map builder wants. */
export function summarizeShard(records: ShardRecord[]): {
  header: ShardHeader
  tests: ShardTest[]
  load: TouchRef[]
  between: TouchRef[]
  teardown: TouchRef[]
} {
  const header = records.find((r): r is ShardHeader => r.type === 'shard')
  if (header === undefined) throw new IncompleteShardError('shard has no header')

  const tests: ShardTest[] = []
  const load: TouchRef[] = []
  const between: TouchRef[] = []
  const teardown: TouchRef[] = []
  for (const record of records) {
    if (record.type === 'test') tests.push(record)
    else if (record.type === 'load') load.push(...record.touches)
    else if (record.type === 'between') between.push(...record.touches)
    else if (record.type === 'teardown') teardown.push(...record.touches)
  }
  return { header, tests, load, between, teardown }
}
