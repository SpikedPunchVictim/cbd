/**
 * A script that *announces* a source map but whose map cannot be read must not
 * fall back to path projection.
 *
 * Projection assumes a line-preserving build. That holds for `tsc` with
 * `sourceMap: false` — the fixture's `out-nomaps` — but it does NOT hold for an
 * esbuild transpile, which is what VS Code's `transpile-client` uses: esbuild
 * strips type-only lines and rewrites enums, class fields and decorators, so
 * everything below such a rewrite shifts. Falling back there yields line
 * numbers that look entirely plausible and are wrong, and a range that has
 * slipped can sit outside the hunk that really touched the function. That is
 * under-selection — the single failure this project cannot accept.
 *
 * The fixture cannot catch this by construction: `out-maps` always carries
 * readable maps, `out-nomaps` declares none at all, so the fallback fires in
 * neither build and every test stayed green while the hazard sat there.
 *
 * Unresolvable is the safe answer. The file then never enters the map, and a
 * change to it escalates through the unknown-file rule to `all`.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { normalize } from '../src/normalize.js'
import type { ScriptInfo, Source, V8ScriptCoverage } from '../src/types.js'

const BODY = [
  'function alpha() {',
  '  return 1',
  '}',
  'function beta() {',
  '  return 2',
  '}',
].join('\n')

/** What V8 finds at the end of a file esbuild transpiled with an inline map. */
const MAP_COMMENT = '\n//# sourceMappingURL=mod.js.map\n'

function fakeSource(scripts: Map<string, ScriptInfo> = new Map()): Source {
  return {
    kind: 'fake',
    supportsSync: true,
    takeSync: () => [],
    take: async () => [],
    scripts: () => scripts,
    close: () => {},
  }
}

function payloadFor(url: string, start: number, end: number, count: number): V8ScriptCoverage[] {
  return [
    {
      scriptId: '1',
      url,
      functions: [
        { functionName: 'alpha', isBlockCoverage: false, ranges: [{ startOffset: start, endOffset: end, count }] },
      ],
    },
  ]
}

function makeTree(
  map: 'none' | 'missing' | 'malformed',
): { root: string; outDir: string; file: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'cbd-source-maps-'))
  const outDir = join(root, 'out')
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, 'mod.js')
  writeFileSync(file, map === 'none' ? BODY : BODY + MAP_COMMENT)
  if (map === 'malformed') writeFileSync(join(outDir, 'mod.js.map'), '{ not json')
  return { root, outDir, file, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** The projection rule for a 1:1 outDir build: `<root>/out/x.js` → `<root>/x.ts`. */
function rule(tree: { root: string; outDir: string }) {
  return { projection: [{ from: tree.outDir, to: tree.root }] }
}

// The control. No map is declared, so projection is the only thing that *can*
// answer — and for a genuinely line-preserving build it is correct. This is
// the fixture's `out-nomaps`, and it must keep working.
test('a script with no source map still projects', () => {
  const tree = makeTree('none')
  try {
    const url = pathToFileURL(tree.file).href
    const start = BODY.indexOf('function alpha')
    const touched = normalize(
      payloadFor(url, start, BODY.indexOf('}', start) + 1, 1),
      fakeSource(new Map([['1', { url }]])),
      rule(tree),
    )
    assert.equal(touched.length, 1)
    assert.equal(touched[0]?.file, join(tree.root, 'mod.ts'))
    assert.equal(touched[0]?.via, 'projection')
  } finally {
    tree.cleanup()
  }
})

/**
 * A script with neither a map nor anything to project is its own original file.
 *
 * This is the shape a service under test usually has, and it is the one shape that
 * had never been exercised: `out-maps` carries readable maps and `out-nomaps` is
 * always run with a projection rule, so the empty rule list — no map, nothing to
 * rewrite — was only ever reached by accident. It resolved to `null`, which dropped
 * the script entirely.
 *
 * The cost of getting it wrong is not a wrong map so much as a *useless* one: every
 * file of that service resolves to unknown and a change to any of them selects the
 * whole suite. Nothing fails, so nothing says so.
 */
test('a script with no map and no projection rule is its own original file', () => {
  const tree = makeTree('none')
  try {
    const url = pathToFileURL(tree.file).href
    const start = BODY.indexOf('function alpha')
    const touched = normalize(
      payloadFor(url, start, BODY.indexOf('}', start) + 1, 1),
      fakeSource(new Map([['1', { url }]])),
    )
    assert.equal(touched.length, 1, 'an unmapped script with nothing to project went missing')
    // The realpath, because `canonicalPath` resolves symlinks — on macOS the temp
    // directory is reached through one.
    assert.equal(touched[0]?.file, realpathSync(tree.file), 'it should be recorded as itself')
    assert.equal(touched[0]?.via, 'projection')
  } finally {
    tree.cleanup()
  }
})

test('a declared but missing map resolves to nothing rather than projecting', () => {
  const tree = makeTree('missing')
  try {
    const url = pathToFileURL(tree.file).href
    const start = BODY.indexOf('function alpha')
    const touched = normalize(
      payloadFor(url, start, BODY.indexOf('}', start) + 1, 1),
      fakeSource(new Map([['1', { url, sourceMapURL: 'mod.js.map' }]])),
      rule(tree),
    )
    assert.deepEqual(
      touched,
      [],
      'projected a script whose map was declared but unreadable; the line numbers would be a guess',
    )
  } finally {
    tree.cleanup()
  }
})

test('a declared but unparseable map resolves to nothing rather than projecting', () => {
  const tree = makeTree('malformed')
  try {
    const url = pathToFileURL(tree.file).href
    const start = BODY.indexOf('function alpha')
    const touched = normalize(
      payloadFor(url, start, BODY.indexOf('}', start) + 1, 1),
      fakeSource(new Map([['1', { url, sourceMapURL: 'mod.js.map' }]])),
      rule(tree),
    )
    assert.deepEqual(
      touched,
      [],
      'projected a script whose map failed to parse; the line numbers would be a guess',
    )
  } finally {
    tree.cleanup()
  }
})
