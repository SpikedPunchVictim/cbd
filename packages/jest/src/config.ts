/**
 * Selection for Jest, from `CBD_SELECTION`, at config load time.
 *
 * Jest's own `testNamePattern` is the only filter that sees a fully expanded test
 * name — including `test.each`/`describe.each` rows — and the config is loaded
 * before the run, which is early enough to read the selection file. A setup-file
 * wrapper cannot do the same job: `.each` rows bypass it, so a selected row would
 * be skipped silently. `withCbd` therefore translates the selection into one
 * escaped alternation and lets Jest filter.
 *
 * Titles are CBD's `describe > name`; Jest's full name joins the same parts with
 * spaces, so each part is escaped and the separator becomes `\\s+`.
 */
import { readFileSync } from 'node:fs'
import { titlePartReadings } from '@spikedpunch/cbd/adapter'

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

const escapePart = (part: string): string => part.replace(REGEX_SPECIALS, '\\$&')

/** The `testNamePattern` for `CBD_SELECTION`, or `undefined` when no selection is set. */
export function selectionPattern(path: string | undefined = process.env.CBD_SELECTION): string | undefined {
  if (path === undefined || path === '') return undefined
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    titles?: unknown
    tests?: unknown
  }
  // The CLI's `--emit-selection` and `cbd collect` write v2; the older reader
  // accepted only v1, so every subset bridge into Jest aborted.
  let titles: string[]
  if (Array.isArray(parsed.tests)) {
    const entries = parsed.tests as Array<{ title?: unknown } | null>
    if (entries.some((entry) => entry === null || typeof entry !== 'object' || typeof entry.title !== 'string')) {
      throw new Error('cbd: the v2 selection needs { "tests": [{ "file", "title" }] }')
    }
    titles = entries.map((entry) => (entry as { title: string }).title)
  } else if (Array.isArray(parsed.titles) && parsed.titles.every((title) => typeof title === 'string')) {
    titles = parsed.titles as string[]
  } else {
    throw new Error(
      'cbd: the selection must contain { "titles": string[] } or { "version": 2, "tests": [...] }',
    )
  }
  if (titles.length === 0) {
    throw new Error('cbd: the selection is empty; run without CBD_SELECTION rather than nothing')
  }
  // Anchored: Jest's pattern is unanchored, and `Should throw an error` would
  // otherwise also match `Should throw an error 2`. Every reading of a title is
  // admitted, because a title may itself contain ` > ` and the stored string does
  // not say which occurrences were separators; the extra readings can only
  // over-select.
  const alternatives: string[] = []
  for (const title of titles) {
    for (const parts of titlePartReadings(title)) {
      alternatives.push(parts.map(escapePart).join('\\s+'))
    }
  }
  return `^(?:${alternatives.join('|')})$`
}

/**
 * The project's Jest config with the selection applied.
 *
 * ```js
 * const {withCbd} = require('@spikedpunch/cbd-jest/config');
 * module.exports = withCbd({testEnvironment: '@spikedpunch/cbd-jest/environment', ...});
 * ```
 *
 * Without `CBD_SELECTION` the config is returned unchanged.
 */
export function withCbd<T extends Record<string, unknown>>(config: T): T & { testNamePattern?: string } {
  const pattern = selectionPattern()
  return pattern === undefined ? config : { ...config, testNamePattern: pattern }
}
