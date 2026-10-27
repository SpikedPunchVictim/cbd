import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from '../src/paths.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '@japa/runner'
import { normalize } from '../src/normalize.js'
import { canonicalProjectionRules, projectPath } from '../src/projection.js'
import type { ScriptInfo, Source, V8ScriptCoverage } from '../src/types.js'

const rules = [{ from: '/repo/out-nomaps', to: '/repo' }]

test('projects a nested compiled path back to its source', () => {
  assert.equal(projectPath('/repo/out-nomaps/src/math.js', rules, 'linux'), '/repo/src/math.ts')
})

test('projects a deeply nested path without losing depth', () => {
  assert.equal(projectPath('/repo/out-nomaps/src/a/b/c.js', rules, 'linux'), '/repo/src/a/b/c.ts')
})

test('returns null for a file outside the output directory', () => {
  assert.equal(projectPath('/repo/src/math.ts', rules, 'linux'), null)
})

// The prefix trap: a plain startsWith would rewrite this to /repo-extra/...,
// silently pointing the map at files that do not exist.
test('does not match a sibling directory sharing the prefix', () => {
  assert.equal(projectPath('/repo/out-nomaps-extra/src/math.js', rules, 'linux'), null)
})

test('honours a custom extension map', () => {
  const custom = [{ from: '/repo/out', to: '/repo', extensions: { '.mjs': '.mts' } }]
  assert.equal(projectPath('/repo/out/a/b.mjs', custom, 'linux'), '/repo/a/b.mts')
})

test('leaves an extension it has no mapping for unchanged', () => {
  assert.equal(projectPath('/repo/out-nomaps/src/theme.css', rules, 'linux'), '/repo/src/theme.css')
})

test('tries rules in order, so a narrow rule can precede a broad one', () => {
  const ordered = [
    { from: '/repo/out-nomaps/generated', to: '/repo/gen' },
    { from: '/repo/out-nomaps', to: '/repo' },
  ]
  assert.equal(projectPath('/repo/out-nomaps/generated/x.js', ordered, 'linux'), '/repo/gen/x.ts')
  assert.equal(projectPath('/repo/out-nomaps/src/x.js', ordered, 'linux'), '/repo/src/x.ts')
})

test('tolerates a trailing slash on either prefix', () => {
  const trailing = [{ from: '/repo/out-nomaps/', to: '/repo/' }]
  assert.equal(projectPath('/repo/out-nomaps/src/x.js', trailing, 'linux'), '/repo/src/x.ts')
})

// ---------------------------------------------------------------------------
// The alias trap.
//
// Node resolves symlinks when it turns a module path into a URL, so the script URL
// V8 reports is a realpath, while a prefix written into a config is exactly as
// typed. On macOS `os.tmpdir()` is `/var/...` whose realpath is `/private/var/...`,
// so a rule using the symlinked prefix matches no script at all: every script is
// dropped, the map comes out empty, and every change degrades to `mode: all` for
// ever — no error, no under-selection, just no speedup at all.
// ---------------------------------------------------------------------------

const MODULE = ['function alpha() {', '  return 1', '}', ''].join('\n')

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

function payloadFor(url: string): V8ScriptCoverage[] {
  return [
    {
      scriptId: '1',
      url,
      functions: [
        {
          functionName: 'alpha',
          isBlockCoverage: false,
          ranges: [{ startOffset: 0, endOffset: MODULE.indexOf('}') + 1, count: 1 }],
        },
      ],
    },
  ]
}

/** A real directory, plus a symlink pointing at it. Returns the real path. */
function makeSymlinkedTree(): { dir: string; cleanup: () => void } {
  // `realpathSync` first, so the tree's own root is already canonical and the only
  // alias left in play is the one this test creates.
  const dir = realpath(mkdtempSync(join(tmpdir(), 'cbd-projection-')))
  mkdirSync(join(dir, 'real/out/src'), { recursive: true })
  writeFileSync(join(dir, 'real/out/src/mod.js'), MODULE)
  symlinkSync(join(dir, 'real'), join(dir, 'link'), 'dir')
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a from-prefix reached through a symlink still matches', () => {
  const tree = makeSymlinkedTree()
  try {
    // The real path is what Node reports; the link is what a config would say.
    const url = pathToFileURL(join(tree.dir, 'real/out/src/mod.js')).href
    const touched = normalize(payloadFor(url), fakeSource(), {
      projection: [{ from: join(tree.dir, 'link/out'), to: join(tree.dir, 'real') }],
    })

    assert.equal(
      touched.length,
      1,
      'every script was dropped, so the map would have come out empty',
    )
    assert.equal(touched[0]?.file, join(tree.dir, 'real/src/mod.ts'))
  } finally {
    tree.cleanup()
  }
})

// Pins the deliberate asymmetry, so it does not get "fixed" into a different bug.
test('canonicalizes the from-prefix but leaves the to-prefix as written', () => {
  const tree = makeSymlinkedTree()
  try {
    const [rule] = canonicalProjectionRules([
      { from: join(tree.dir, 'link/out'), to: join(tree.dir, 'link') },
    ])
    assert.equal(rule?.from, join(tree.dir, 'real/out'))
    assert.equal(
      rule?.to,
      join(tree.dir, 'link'),
      'the to-prefix has to keep agreeing with the repo root changesSince was handed',
    )
  } finally {
    tree.cleanup()
  }
})

test('the rule prefix itself projects without a trailing slash', () => {
  assert.equal(projectPath('/repo/out-nomaps', rules, 'linux'), '/repo')
})
