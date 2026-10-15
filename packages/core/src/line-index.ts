/**
 * Byte offset -> line/column, for the generated file V8 measured.
 *
 * V8 reports ranges as offsets into the generated script, but source maps are
 * keyed by line and column. Converting needs the generated file's text, which is
 * why this is here rather than in the Normalizer: the text is read once per file
 * and cached, since a file does not change during a run.
 */
import { readFileSync } from 'node:fs'

export interface LineIndex {
  /** Offset at which each line begins. Index 0 is line 1. */
  starts: number[]
  /** Total length, used to recognise a range that spans the whole script. */
  length: number
}

export function buildLineIndex(text: string): LineIndex {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return { starts, length: text.length }
}

/** 1-based line containing `offset`. */
export function lineAt(index: LineIndex, offset: number): number {
  const { starts } = index
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** 0-based column of `offset` within its line. */
export function columnAt(index: LineIndex, offset: number): number {
  return offset - index.starts[lineAt(index, offset) - 1]!
}

/**
 * Reads and indexes generated files, once each.
 *
 * Returns `null` for anything that is not a readable file on disk — `data:`
 * URLs, `eval`, `node:` internals — so callers can skip rather than throw.
 */
export class FileCache {
  #text = new Map<string, string | null>()
  #index = new Map<string, LineIndex | null>()

  text(path: string): string | null {
    const cached = this.#text.get(path)
    if (cached !== undefined) return cached
    let value: string | null
    try {
      value = readFileSync(path, 'utf8')
    } catch {
      value = null
    }
    this.#text.set(path, value)
    return value
  }

  index(path: string): LineIndex | null {
    const cached = this.#index.get(path)
    if (cached !== undefined) return cached
    const text = this.text(path)
    const value = text === null ? null : buildLineIndex(text)
    this.#index.set(path, value)
    return value
  }
}
