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
import { sourceMapUrlOf } from '../src/source-maps.js'
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

/**
 * The module body of a tsc-built script starts where the first mapping does.
 *
 * tsc emits `"use strict"` and the `__createBinding` helpers on generated lines
 * that carry no mapping, so byte offset 0 — the module body — has no mapping of
 * its own and `originalPositionFor` will not search past its line. The lookup
 * returned null, the module body vanished, and a file whose only executed
 * function is the module body (a module of classes or constants re-exported by a
 * barrel) disappeared from the map entirely: `cbd-1ci`, observed on
 * `libs/core/src/KeyStore.ts`, `SigningPolicy.ts`, and `libs/leases/src/Columns.ts`.
 */
test('the module body resolves through an unmapped generated prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'cbd-module-body-'))
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'out'), { recursive: true })
    const sourceFile = join(root, 'src/mod.ts')
    const generated = join(root, 'out/mod.js')
    writeFileSync(sourceFile, 'class Unused {\n}\n')

    // Three generated lines with no segments (`;;;`), then the class on line 4.
    const map = {
      version: 3,
      file: 'mod.js',
      sources: ['../src/mod.ts'],
      names: [],
      mappings: ';;;AAAA',
    }
    const sourceMapURL = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`
    const code = [
      '"use strict";',
      'Object.defineProperty(exports, "__esModule", { value: true });',
      '// tsc emits this line before the first mapping',
      'class Unused {',
      '}',
      `//# sourceMappingURL=${sourceMapURL}`,
      '',
    ].join('\n')
    writeFileSync(generated, code)

    const url = pathToFileURL(generated).href
    const payload: V8ScriptCoverage[] = [
      {
        scriptId: '1',
        url,
        functions: [
          {
            functionName: '',
            isBlockCoverage: false,
            ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }],
          },
        ],
      },
    ]
    const touched = normalize(payload, fakeSource(new Map([['1', { url, sourceMapURL }]])), {})
    assert.equal(
      touched.length,
      1,
      'the module body was dropped because offset 0 has no mapping on its generated line',
    )
    assert.equal(touched[0]?.name, '<module>')
    // The map resolves `sources` against the script's own URL, so the spelling is
    // the one in the temp directory rather than its realpath.
    assert.equal(touched[0]?.file, sourceFile)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// `cbd-n9t.1`: a shard omits a map the file itself declares, so the build has to
// read the same comment Node would.
test('sourceMapUrlOf reads the last magic comment, in either form', () => {
  assert.equal(sourceMapUrlOf('x\n//# sourceMappingURL=a.map\n'), 'a.map')
  assert.equal(sourceMapUrlOf('x\n//@ sourceMappingURL=legacy.map'), 'legacy.map')
  assert.equal(sourceMapUrlOf('x\n/*# sourceMappingURL=b.map */'), 'b.map')
  assert.equal(
    sourceMapUrlOf('//# sourceMappingURL=one.map\n//# sourceMappingURL=two.map'),
    'two.map',
    'the last comment wins, as it does for Node',
  )
  assert.equal(sourceMapUrlOf('no comment here'), undefined)
})

/** A script with a data: map whose `sources` or payload is hostile, normalized end to end. */
function normalizeWithMap(sourceMapURL: string): ReturnType<typeof normalize> {
  const tree = makeTree('none')
  try {
    writeFileSync(tree.file, BODY)
    const url = pathToFileURL(tree.file).href
    const start = BODY.indexOf('function alpha')
    return normalize(
      payloadFor(url, start, BODY.indexOf('}', start) + 1, 1),
      fakeSource(new Map([['1', { url, sourceMapURL }]])),
      rule(tree),
    )
  } finally {
    tree.cleanup()
  }
}

test('a source path containing a stray percent sign does not abort normalization', () => {
  const map = { version: 3, sources: ['./100%zz.ts'], names: [], mappings: 'AAAA' }
  const url = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`
  assert.doesNotThrow(() => normalizeWithMap(url))
})

test('a data: map with a malformed percent escape resolves to nothing instead of throwing', () => {
  assert.deepEqual(normalizeWithMap('data:application/json,%E0%A4%A'), [])
})
