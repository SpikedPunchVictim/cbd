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
    } else if (char === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end === -1 || end === i + 1) {
        out += '\\['
      } else {
        let body = pattern.slice(i + 1, end)
        const negated = body.startsWith('!')
        if (negated) body = `^${body.slice(1)}`
        // A negated class must not cross a separator; a positive class is safe.
        out += `[${body}${negated ? '/' : ''}]`
        i = end
      }
    } else if ('\\^$.|+(){}'.includes(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`^${out}$`)
}

/** Braces group alternatives: `*.{ts,tsx}` is two globs. */
function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]+)\}/.exec(pattern)
  if (match === null) return [pattern]
  const before = pattern.slice(0, match.index)
  const after = pattern.slice(match.index + match[0].length)
  return (match[1] ?? '')
    .split(',')
    .flatMap((part) => expandBraces(`${before}${part}${after}`))
}

/** The same pattern on either separator spelling. */
const normalize = (path: string): string => path.replaceAll('\\', '/')

const cache = new Map<string, RegExp>()

export function matchesGlob(path: string, pattern: string): boolean {
  const candidate = normalize(path)
  for (const expanded of expandBraces(normalize(pattern))) {
    let regex = cache.get(expanded)
    if (regex === undefined) {
      regex = toRegExp(expanded)
      cache.set(expanded, regex)
    }
    if (regex.test(candidate)) return true
  }
  return false
}

export function matchesAnyGlob(path: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    if (matchesGlob(path, pattern)) return pattern
  }
  return null
}
