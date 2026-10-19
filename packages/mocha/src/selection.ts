/**
 * Turning `CBD_SELECTION`'s titles into mocha's one filter.
 *
 * Mocha has a single `grep` for a run, so a subset of N titles has to become one
 * regexp. It is tested against `test.fullTitle()` — exactly the string the adapter
 * records — so an anchored alternation of the titles selects exactly the mapped
 * set, with no prefix or suffix matching another test by accident.
 *
 * **Escaping is not optional.** A title is data, not a pattern: `it('adds 1 + 1')`
 * must not also select `adds 11`, and parentheses or brackets in a group name are
 * ordinary characters. mocha's own `fgrep` escapes its argument for this reason;
 * here the escaping is applied per title before the alternation is built.
 */
export function selectionPattern(titles: string[]): RegExp {
  if (titles.length === 0) {
    // An empty filter reads to mocha as "match nothing", which would run no tests —
    // the under-selecting direction. `readSelection` refuses this too; the guard
    // here means a caller cannot reach that state through this function either.
    throw new Error('a selection must name at least one test title')
  }
  return new RegExp(`^(?:${titles.map(escapeTitle).join('|')})$`)
}

const escapeTitle = (title: string): string => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
