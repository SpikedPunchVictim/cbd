/**
 * The whole chain against a real run: the fixture's suite → shard → map → query.
 *
 * Everything except the wiring that connects japa's events to the Recorder is
 * production code, so this is the closest thing yet to the real adapter — and the
 * only test that exercises the lifecycle end to end, including the footer that
 * makes an interrupted shard detectable.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import type { Change } from '../src/changes.js'
import { buildMap, testsForFunction } from '../src/map.js'
import { loadMap, saveMap } from '../src/map.js'
import { select } from '../src/select.js'
import { parseShard, summarizeShard } from '../src/shard.js'

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const fixtureRoot = resolve(coreRoot, '../../fixture')

/**
 * The build-side scan for a fixture build.
 *
 * A v2 shard carries no paths, so the projection and the include scope are applied
 * by `buildMap`, not the recorder. `out-maps` has source maps, so projection is a
 * fallback there; `out-nomaps` needs it.
 */
const scanFor = (build: string): { projection: { from: string; to: string }[]; include: (file: string) => boolean } => ({
  projection: [{ from: join(fixtureRoot, build), to: fixtureRoot }],
  include: (file) => file.startsWith(fixtureRoot),
})

function record(build: string, shardPath: string): void {
  execFileSync(
    process.execPath,
    [join(coreRoot, 'scripts/record-fixture.mjs'), build, shardPath],
    { stdio: 'pipe' },
  )
}

test('a real run yields a complete shard, a map, and a working query', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-record-'))
  try {
    const shardPath = join(dir, 'shard.jsonl')
    record('out-maps', shardPath)

    // 1. The shard is complete — the footer is present, so nothing was truncated.
    const records = parseShard(readFileSync(shardPath, 'utf8'), shardPath)
    const summary = summarizeShard(records)
    assert.equal(summary.header.commit, 'fixture-head')

    // 2. Every test was recorded, and the skipped one is not mistaken for a pass.
    const byStatus = summary.tests.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1
      return acc
    }, {})
    assert.equal(summary.tests.length, 43)
    assert.equal(byStatus['passed'], 42)
    assert.equal(byStatus['skipped'], 1, 'a skipped test was recorded as something else')

    // The raw buckets hold byte ranges; the claims below are about files and
    // function names, so they are read from the map, where resolution has happened.
    const map = buildMap([{ name: 'shard.jsonl', records }], {
      commit: 'fixture-head',
      scan: scanFor('out-maps'),
    })

    // 3. The load bucket holds the imports. Every fixture module is imported
    //    before the first test starts, so its module body lands here — and
    //    nowhere else, which is why no test window ever contains one.
    assert.ok(map.load.length > 0, 'the @load bucket is empty; the import window was lost')
    const loadedSources = new Set(
      map.load
        .filter((ref) => ref[0].startsWith(join(fixtureRoot, 'src/')) && ref[1] === '<module>@0')
        .map((ref) => ref[0]),
    )
    assert.equal(
      loadedSources.size,
      11,
      `expected all 11 source modules to be recorded as loaded, got ${loadedSources.size}`,
    )
    // Import phase is not exclusively module bodies — a `test.group` definition
    // callback runs there too — so the claim is the one that matters: a module
    // body never turns up inside a test window. A function reaches `map.files`
    // only through a test, so a `<module>@0` row there is exactly that.
    for (const functions of Object.values(map.files)) {
      assert.equal(functions['<module>@0'], undefined, 'a module body appeared inside a test window')
    }

    // 4. Work that ran outside any window — abandoned timers, group teardown.
    assert.ok(
      map.between.length > 0,
      'the @between bucket is empty; out-of-window activity was attributed to a test',
    )
    // `group.each.setup` fires between one test's end and the next one's start, so
    // what it touches is unattributable and lands in @between rather than in the
    // test that appears to own it. Conservative, but the map has to treat such
    // code as reaching every test — and that inflates @between on suites that lean
    // on per-test setup, which is worth knowing before trusting an all-rate.
    assert.ok(
      map.between.some((ref) => ref[0] === join(fixtureRoot, 'tests/grouped.spec.ts')),
      'expected the group setup hooks to be recorded as out-of-window activity',
    )

    // 5. Shard -> map -> disk -> memory -> query.
    assert.equal(map.tests.length, 42, 'the skipped test should not reach the map')

    const saved = saveMap(dir, map)
    assert.ok(saved.bytes > 1000, `map is suspiciously small: ${saved.bytes} bytes`)
    const loaded = loadMap(dir, 'fixture-head')
    assert.equal(loaded.bytes, saved.bytes)
    assert.ok(loaded.parseMs >= 0)

    const reaching = testsForFunction(loaded.map, join(fixtureRoot, 'src/math.ts'), 'add@0')
    assert.ok(
      reaching.some((t) => t.title === 'add sums two numbers'),
      `query returned: ${reaching.map((t) => t.title).join(', ')}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * `select` against the real recorded map, rather than the hand-built one the unit
 * tests use. The unit tests pin each rule's logic; this one checks that a map
 * produced by an actual run has the shape `select` expects — the join between the
 * two halves of the pipeline, which nothing else exercises.
 */
test('select works against a map built from a real recording', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbd-select-'))
  try {
    const shardPath = join(dir, 'shard.jsonl')
    record('out-maps', shardPath)
    const records = parseShard(readFileSync(shardPath, 'utf8'), shardPath)
    const map = buildMap([{ name: 'shard.jsonl', records }], {
      commit: 'fixture-head',
      scan: scanFor('out-maps'),
    })

    const mathFile = join(fixtureRoot, 'src/helpers.ts')
    const slug = map.files[mathFile]?.['slug@0']
    assert.ok(slug, 'expected slug@0 in src/helpers.ts')

    // A change landing inside the mapped function.
    const inside: Change = {
      path: mathFile,
      status: 'M',
      hunks: [{ start: slug.startLine, end: slug.startLine }],
    }
    const selection = select(map, [inside], { alwaysAll: ['**/package.json'] })

    assert.equal(selection.mode, 'subset')
    assert.deepEqual(selection.tests, slug.tests)
    assert.equal(selection.untested.length, 0)
    assert.equal(selection.unmapped.length, 0)

    // The cross-cutting property. It belongs to the FILE, not to one function:
    // a change inside `slug` reaches only its own callers, but a change to the
    // shared module reaches every test that goes through any of its exports —
    // which is the case a filename-based rule cannot express at all.
    const wholeFile = new Set<number>()
    for (const entry of Object.values(map.files[mathFile]!)) {
      for (const index of entry.tests) wholeFile.add(index)
    }
    assert.ok(
      wholeFile.size >= 5,
      `expected several tests to reach src/helpers.ts, got ${wholeFile.size}`,
    )
    // And a change outside every function widens to exactly that set.
    const outside = select(map, [{ path: mathFile, status: 'M', hunks: [{ start: 1, end: 1 }] }])
    assert.deepEqual(outside.tests, [...wholeFile].sort((a, b) => a - b))

    // A change to a file the map never saw escalates, as rule 7 requires.
    const unknown: Change = {
      path: join(fixtureRoot, 'src/brand-new.ts'),
      status: 'M',
      hunks: [{ start: 1, end: 1 }],
    }
    assert.equal(select(map, [unknown]).mode, 'all')

    // And a package.json change, which the map genuinely cannot answer for.
    const manifest: Change = { path: join(fixtureRoot, 'package.json'), status: 'M', hunks: [] }
    const escalated = select(map, [manifest], { alwaysAll: ['**/package.json'] })
    assert.equal(escalated.mode, 'all')
    assert.deepEqual(escalated.tests, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
