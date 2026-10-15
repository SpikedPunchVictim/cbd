/**
 * Glob matching for `alwaysAll` and `include` patterns.
 *
 * Deliberately small — double-star, star and question mark over a slash-separated
 * path. A dependency for this would be larger than the thing it does, and the only
 * semantics that matter here are that a double-star prefix matches at any depth
 * while a single star does not cross a separator.
 */

function toRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` spans zero or more path segments, so `**/x` also matches `x`.
        i += 1
        if (pattern[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`^${out}$`)
}

const cache = new Map<string, RegExp>()

export function matchesGlob(path: string, pattern: string): boolean {
  let regex = cache.get(pattern)
  if (regex === undefined) {
    regex = toRegExp(pattern)
    cache.set(pattern, regex)
  }
  return regex.test(path)
}

export function matchesAnyGlob(path: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (matchesGlob(path, pattern)) return pattern
  }
  return null
}
