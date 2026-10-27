/**
 * A service that runs from a COPY of its build must be keyed by where its code
 * lives, not by where it ran.
 *
 * This is the shape every deployed lane has (ADR-0006). The lane runs the server
 * out of `.deploy/<lane>/`, a project's `tsc` emits inline source maps, and the
 * copy's maps resolve — correctly — to the copy's own `../src/*.ts`. The map is then
 * keyed by a path no repository diff can produce, and the failure is not loud: on
 * a real service suite, one handler held 3 tests at the checkout path and 2 *different*
 * tests under the lane path, the overlap empty. A change to it returned a
 * complete-looking subset that silently omitted the tests reaching it over HTTP.
 *
 * The fixture is the real one, copied: `fixture/out-maps` carries genuine maps whose
 * `sources` is `../../src/x.ts`, so copying `out-maps` and `src` under a staging root
 * reproduces the lane exactly, maps and all.
 *
 * The union itself is not re-tested here: that two shards reaching one key union
 * their tests is `map.spec.ts` — "two shards naming one test union its touches rather
 * than splitting it". What these tests pin is that both paths become ONE key.
 */
import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { realpath } from '../src/paths.js'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { normalize } from '../src/normalize.js'
import { relocatePath } from '../src/relocate.js'
import type { ScriptInfo, Source, V8ScriptCoverage } from '../src/types.js'

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixtureRoot = resolve(coreRoot, '../../fixture')

// These spell POSIX paths literally; the win32 rewrite is covered by `rebase` in windows.spec.ts.
const onWindows = process.platform === 'win32'
const POSIX_LITERALS = 'fixture paths are POSIX literals'

const rules = [{ from: '/repo/.deploy/lane', to: '/repo' }]

test('rewrites a nested path under the staging root back to the checkout', () => {
  assert.equal(
    relocatePath('/repo/.deploy/lane/api/key-server/src/handler.ts', rules),
    '/repo/api/key-server/src/handler.ts',
  )
}).skip(onWindows, POSIX_LITERALS)

test('leaves a path no rule covers unchanged, byte for byte', () => {
  const file = '/repo/api/key-server/src/handler.ts'
  assert.equal(relocatePath(file, rules), file, 'a rule that matches nothing must change nothing')
}).skip(onWindows, POSIX_LITERALS)

test('does not match a sibling directory sharing the prefix', () => {
  assert.equal(relocatePath('/repo/.deploy/lane-extra/src/x.ts', rules), '/repo/.deploy/lane-extra/src/x.ts')
}).skip(onWindows, POSIX_LITERALS)

test('tolerates a trailing slash on either prefix', () => {
  const trailing = [{ from: '/repo/.deploy/lane/', to: '/repo/' }]
  assert.equal(relocatePath('/repo/.deploy/lane/src/x.ts', trailing), '/repo/src/x.ts')
}).skip(onWindows, POSIX_LITERALS)

// The deliberate difference from `projectPath`. A copy of a tree has the same file
// names as the tree, so relocating `helpers.js` to `helpers.ts` would name a file
// that does not exist — and the map would hold a key no diff produces.
test('never swaps extensions, unlike a projection', () => {
  assert.equal(relocatePath('/repo/stage/src/helpers.js', [{ from: '/repo/stage', to: '/repo' }]), '/repo/src/helpers.js')
}).skip(onWindows, POSIX_LITERALS)

test('tries rules in order, so a narrow rule can precede a broad one', () => {
  const ordered = [
    { from: '/repo/stage/generated', to: '/repo/gen' },
    { from: '/repo/stage', to: '/repo' },
  ]
  assert.equal(relocatePath('/repo/stage/generated/x.ts', ordered), '/repo/gen/x.ts')
  assert.equal(relocatePath('/repo/stage/src/x.ts', ordered), '/repo/src/x.ts')
}).skip(onWindows, POSIX_LITERALS)

// The alias trap, which `projectPath` has its own test for and relocation inherits.
// Node reports realpaths, a prefix in a config is exactly as typed, and on macOS
// `/tmp` is `/private/tmp` — so a rule spelled the symlinked way would match nothing,
// leaving every staged path unknown-file and every change in `mode: all`.
test('a from-prefix reached through a symlink still matches', () => {
  const dir = realpath(mkdtempSync(join(tmpdir(), 'cbd-relocate-')))
  try {
    mkdirSync(join(dir, 'real/stage/src'), { recursive: true })
    symlinkSync(join(dir, 'real'), join(dir, 'link'), 'dir')
    assert.equal(
      relocatePath(join(dir, 'real/stage/src/x.ts'), [{ from: join(dir, 'link/stage'), to: dir }]),
      join(dir, 'src/x.ts'),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The reproduction, through `normalize`, on the real fixture's maps.
// ---------------------------------------------------------------------------

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

/** The fixture's build, copied under a staging root — a lane in miniature. */
function stageBuild(): { staging: string; cleanup: () => void } {
  const generated = join(fixtureRoot, 'out-maps/src/math.js')
  assert.ok(
    existsSync(`${generated}.map`),
    `fixture is not built: ${generated}.map missing — run \`pnpm --filter @spikedpunch/cbd-fixture build\``,
  )
  // Realpath'd first, so the only alias in play is one a test creates on purpose.
  const staging = join(realpath(mkdtempSync(join(tmpdir(), 'cbd-relocate-scan-'))), 'lane')
  cpSync(join(fixtureRoot, 'out-maps'), join(staging, 'out-maps'), { recursive: true })
  cpSync(join(fixtureRoot, 'src'), join(staging, 'src'), { recursive: true })
  return { staging, cleanup: () => rmSync(dirname(staging), { recursive: true, force: true }) }
}

/** What a window of the staged copy records for `add`. */
function takeFrom(build: string, sourceMapURL: string) {
  const js = readFileSync(build, 'utf8')
  const start = js.indexOf('function add')
  const end = js.indexOf('}', start) + 1
  assert.ok(start > 0 && end > start, 'could not locate `add` in the generated output')
  const url = pathToFileURL(build).href
  return {
    url,
    payload: payloadFor(url, [{ name: 'add', start, end, count: 1 }]),
    scripts: new Map<string, ScriptInfo>([['1', { url, sourceMapURL }]]),
  }
}

test('a build run from a copy is keyed under the copy', () => {
  const build = stageBuild()
  try {
    const staged = join(build.staging, 'out-maps/src/math.js')
    const { payload, scripts } = takeFrom(staged, 'math.js.map')
    const touched = normalize(payload, fakeSource(scripts))

    assert.equal(touched.length, 1)
    assert.equal(
      touched[0]?.file,
      join(build.staging, 'src/math.ts'),
      'if this ever came back as the fixture path, the defect this file exists for is gone',
    )
  } finally {
    build.cleanup()
  }
})

test('a relocation rule keys the same script where the rest of the toolchain names it', () => {
  const build = stageBuild()
  try {
    const staged = join(build.staging, 'out-maps/src/math.js')
    const { payload, scripts } = takeFrom(staged, 'math.js.map')
    const touched = normalize(payload, fakeSource(scripts), {
      relocate: [{ from: build.staging, to: fixtureRoot }],
    })

    const inPlace = takeFrom(join(fixtureRoot, 'out-maps/src/math.js'), 'math.js.map')

    assert.equal(touched.length, 1)
    assert.equal(touched[0]?.file, join(fixtureRoot, 'src/math.ts'))
    assert.equal(touched[0]?.key, 'add@0')
    assert.equal(
      touched[0]?.file,
      normalize(inPlace.payload, fakeSource(inPlace.scripts))[0]?.file,
      'the copy and the original must produce ONE key, or the map holds two entries for one file',
    )
  } finally {
    build.cleanup()
  }
})

test('a rule covering nothing leaves the resolved path alone', () => {
  const build = stageBuild()
  try {
    const staged = join(build.staging, 'out-maps/src/math.js')
    const { payload, scripts } = takeFrom(staged, 'math.js.map')
    const touched = normalize(payload, fakeSource(scripts), {
      relocate: [{ from: '/somewhere/else', to: '/repo' }],
    })

    assert.equal(touched[0]?.file, join(build.staging, 'src/math.ts'))
  } finally {
    build.cleanup()
  }
})
