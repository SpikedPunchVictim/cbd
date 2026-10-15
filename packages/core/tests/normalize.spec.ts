import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { normalize, scan } from '../src/normalize.js'
import type { ScriptInfo, Source, V8ScriptCoverage } from '../src/types.js'

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixtureRoot = resolve(coreRoot, '../../fixture')

/** A source that yields no coverage of its own; the payload is supplied directly. */
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

interface FnSpec {
  name: string
  start: number
  end: number
  count: number
}

function payloadFor(url: string, functions: FnSpec[]): V8ScriptCoverage[] {
  return [
    {
      scriptId: '1',
      url,
      functions: functions.map((fn) => ({
        functionName: fn.name,
        isBlockCoverage: false,
        ranges: [{ startOffset: fn.start, endOffset: fn.end, count: fn.count }],
      })),
    },
  ]
}

const MODULE = [
  'function alpha() {',
  '  return 1',
  '}',
  'function beta() {',
  '  return 2',
  '}',
].join('\n')

function makeTree(): { root: string; outDir: string; file: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'cbd-normalize-'))
  const outDir = join(root, 'out-nomaps')
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, 'mod.js')
  writeFileSync(file, MODULE)
  return { root, outDir, file, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const span = (needle: string, from = 0): number => MODULE.indexOf(needle, from)
const closeBrace = (from: number): number => MODULE.indexOf('}', from) + 1

test('a function that did not run is absent from the touches', () => {
  const tree = makeTree()
  try {
    const alphaStart = span('function alpha')
    const betaStart = span('function beta')
    const payload = payloadFor(pathToFileURL(tree.file).href, [
      { name: 'alpha', start: alphaStart, end: closeBrace(alphaStart), count: 1 },
      { name: 'beta', start: betaStart, end: closeBrace(betaStart), count: 0 },
    ])
    const touched = normalize(payload, fakeSource(), {
      projection: [{ from: tree.outDir, to: tree.root }],
    })
    assert.deepEqual(
      touched.map((t) => t.key),
      ['alpha@0'],
    )
  } finally {
    tree.cleanup()
  }
})

test('line ranges are reported in original coordinates', () => {
  const tree = makeTree()
  try {
    const alphaStart = span('function alpha')
    const payload = payloadFor(pathToFileURL(tree.file).href, [
      { name: 'alpha', start: alphaStart, end: closeBrace(alphaStart), count: 1 },
    ])
    const [touch] = normalize(payload, fakeSource(), {
      projection: [{ from: tree.outDir, to: tree.root }],
    })
    assert.equal(touch?.file, join(tree.root, 'mod.ts'))
    assert.equal(touch?.startLine, 1)
    assert.equal(touch?.endLine, 3)
    assert.equal(touch?.via, 'projection')
  } finally {
    tree.cleanup()
  }
})

// The property the whole key scheme rests on. Ordinals are assigned over every
// function in the file, so a window that executes ONLY the middle `parse` still
// reports it as `parse@1` — not `parse@0`, which is what counting the executed
// set would have produced and what would make every key drift between windows.
test('ordinals come from the whole file, not the executed subset', () => {
  const tree = makeTree()
  try {
    const first = span('function alpha')
    const second = span('function beta')
    const third = span('}', second) + 4
    const both = [
      { name: 'parse', start: first, end: closeBrace(first), count: 1 },
      { name: 'parse', start: second, end: closeBrace(second), count: 1 },
      { name: 'parse', start: third, end: third + 2, count: 1 },
    ]
    const all = normalize(payloadFor(pathToFileURL(tree.file).href, both), fakeSource(), {
      projection: [{ from: tree.outDir, to: tree.root }],
    })
    assert.deepEqual(all.map((t) => t.key), ['parse@0', 'parse@1', 'parse@2'])

    const middleOnly = both.map((fn, i) => ({ ...fn, count: i === 1 ? 1 : 0 }))
    const survivor = normalize(
      payloadFor(pathToFileURL(tree.file).href, middleOnly),
      fakeSource(),
      { projection: [{ from: tree.outDir, to: tree.root }] },
    )
    assert.deepEqual(survivor.map((t) => t.key), ['parse@1'])
  } finally {
    tree.cleanup()
  }
})

test('the module body is identified, and means the file was loaded', () => {
  const tree = makeTree()
  try {
    const payload = payloadFor(pathToFileURL(tree.file).href, [
      { name: '', start: 0, end: MODULE.length, count: 1 },
    ])
    const touched = normalize(payload, fakeSource(), {
      projection: [{ from: tree.outDir, to: tree.root }],
    })
    assert.equal(touched[0]?.name, '<module>')
    assert.equal(touched[0]?.key, '<module>@0')
  } finally {
    tree.cleanup()
  }
})

test('scan reports definitions that normalize drops', () => {
  const tree = makeTree()
  try {
    const alphaStart = span('function alpha')
    const betaStart = span('function beta')
    const payload = payloadFor(pathToFileURL(tree.file).href, [
      { name: 'alpha', start: alphaStart, end: closeBrace(alphaStart), count: 1 },
      { name: 'beta', start: betaStart, end: closeBrace(betaStart), count: 0 },
    ])
    const options = { projection: [{ from: tree.outDir, to: tree.root }] }
    const all = scan(payload, fakeSource(), options)
    const ran = normalize(payload, fakeSource(), options)
    assert.equal(all.length, 2)
    assert.equal(ran.length, 1)
    assert.deepEqual(
      all.filter((d) => !d.executed).map((d) => d.key),
      ['beta@0'],
    )
  } finally {
    tree.cleanup()
  }
})

test('include and exclude filter on the original path, not the generated one', () => {
  const tree = makeTree()
  try {
    const alphaStart = span('function alpha')
    const payload = payloadFor(pathToFileURL(tree.file).href, [
      { name: 'alpha', start: alphaStart, end: closeBrace(alphaStart), count: 1 },
    ])
    const options = { projection: [{ from: tree.outDir, to: tree.root }] }
    const source = fakeSource()
    assert.equal(normalize(payload, source, { ...options, include: () => true }).length, 1)
    assert.equal(normalize(payload, source, { ...options, include: () => false }).length, 0)
    assert.equal(normalize(payload, source, { ...options, exclude: () => true }).length, 0)
    // The filter sees `mod.ts`, never `mod.js`, so a pattern for the source tree works.
    const sawOriginal = normalize(payload, source, {
      ...options,
      include: (file) => file.endsWith('mod.ts'),
    })
    assert.equal(sawOriginal.length, 1)
  } finally {
    tree.cleanup()
  }
})

test('a script the projection cannot place is skipped rather than guessed at', () => {
  const tree = makeTree()
  try {
    const payload = payloadFor(`file:///elsewhere/build/mod.js`, [
      { name: 'alpha', start: 0, end: 10, count: 1 },
    ])
    const touched = normalize(payload, fakeSource(), {
      projection: [{ from: tree.outDir, to: tree.root }],
    })
    assert.equal(touched.length, 0)
  } finally {
    tree.cleanup()
  }
})

// --- the real source-map path, against the fixture's actual build -----------

test('resolves through a real source map back to the TypeScript source', () => {
  const generated = join(fixtureRoot, 'out-maps/src/math.js')
  const mapPath = `${generated}.map`
  assert.ok(
    existsSync(mapPath),
    `fixture is not built: ${mapPath} missing — run \`pnpm --filter @cbd/fixture build\``,
  )

  const js = readFileSync(generated, 'utf8')
  const start = js.indexOf('function add')
  const end = js.indexOf('}', start) + 1
  assert.ok(start > 0 && end > start, 'could not locate `add` in the generated output')

  const url = pathToFileURL(generated).href
  const scripts = new Map<string, ScriptInfo>([
    ['1', { url, sourceMapURL: 'math.js.map' }],
  ])
  const payload = payloadFor(url, [{ name: 'add', start, end, count: 1 }])

  // projection is deliberately empty: a pass here proves the MAP did the work.
  const touched = normalize(payload, fakeSource(scripts), { projection: [] })

  assert.equal(touched.length, 1)
  const [touch] = touched
  assert.equal(touch?.via, 'source-map')
  assert.equal(touch?.file, join(fixtureRoot, 'src/math.ts'))
  assert.equal(touch?.key, 'add@0')
  assert.equal(touch?.startLine, 3)
  assert.equal(touch?.endLine, 5)
})
