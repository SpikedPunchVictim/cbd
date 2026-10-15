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

/** Executed outside any test window: at import time, or between tests. */
export interface ShardBucket {
  type: 'load' | 'between'
  touches: TouchRef[]
}

export interface ShardFooter {
  type: 'end'
  tests: number
  finishedAt: string
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
} {
  const header = records.find((r): r is ShardHeader => r.type === 'shard')
  if (header === undefined) throw new IncompleteShardError('shard has no header')

  const tests: ShardTest[] = []
  const load: TouchRef[] = []
  const between: TouchRef[] = []
  for (const record of records) {
    if (record.type === 'test') tests.push(record)
    else if (record.type === 'load') load.push(...record.touches)
    else if (record.type === 'between') between.push(...record.touches)
  }
  return { header, tests, load, between }
}
