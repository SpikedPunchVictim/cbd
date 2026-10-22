/**
 * `cbd.config.json` — the one committed file (CBD.md §9.3).
 *
 * The loader is where a typo becomes a wrong selection, so the invalid cases matter
 * as much as the valid one: an unknown key is refused rather than ignored, and a
 * policy value outside the two the selector implements is refused too.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { configPath, loadConfig, loadConfigFile, parseConfig } from '../src/config.js'

function tempRoot(): { root: string; cleanup: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cbd-config-')))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test.group('cbd.config.json', () => {
  test('a full file becomes an absolute-glob select config', () => {
    const { root, cleanup } = tempRoot()
    try {
      const config = parseConfig(
        {
          $schema: './node_modules/@spikedpunch/cbd/cbd.config.schema.json',
          include: ['src/**'],
          exclude: ['**/*.d.ts'],
          alwaysAll: ['pnpm-lock.yaml', '**/package.json'],
          alwaysSelect: [
            {
              tests: ['tests/drain.spec.ts', 'tests/pipeline.spec.ts > no import outside the package'],
              when: ['edge/pipeline/src/**'],
            },
          ],
          unknownPolicy: 'all',
          unknownPolicyFor: [{ paths: ['tools/**'], policy: 'ignore' }],
          betweenPolicy: 'ignore',
          testFiles: ['**/*.spec.ts'],
          testFilePolicy: 'known',
          maxAgeCommits: 50,
          strict: true,
          stateDir: 'build/cbd',
          mapsDir: '../shared/maps',
        },
        root,
      )

      assert.equal(config.root, root)
      assert.equal(config.stateDir, 'build/cbd')
      assert.equal(config.mapsDir, '../shared/maps')
      const select = config.select!
      assert.equal(select.unknownPolicy, 'all')
      assert.deepEqual(select.unknownPolicyFor, [
        { paths: [join(root, 'tools/**')], policy: 'ignore' },
      ])
      assert.equal(select.betweenPolicy, 'ignore')
      assert.equal(select.testFilePolicy, 'known')
      assert.equal(select.maxAgeCommits, 50)
      assert.equal(select.strict, true)
      assert.deepEqual(select.alwaysAll, [join(root, 'pnpm-lock.yaml'), join(root, '**/package.json')])
      assert.deepEqual(select.alwaysSelect, [
        {
          tests: [
            { file: join(root, 'tests/drain.spec.ts') },
            { file: join(root, 'tests/pipeline.spec.ts'), title: 'no import outside the package' },
          ],
          when: [join(root, 'edge/pipeline/src/**')],
        },
      ])

      // include and exclude are one predicate over the map's absolute keys.
      assert.equal(select.include!(join(root, 'src/a.ts')), true)
      assert.equal(select.include!(join(root, 'src/types.d.ts')), false)
      assert.equal(select.include!(join(root, 'docs/readme.md')), false)

      // A test file glob is absolute too, and matches at any depth.
      assert.equal(select.testFiles!.join(','), join(root, '**/*.spec.ts'))
    } finally {
      cleanup()
    }
  })

  test('globs are built against the canonical root', () => {
    // `tmpdir()` sits behind a symlink on macOS. Building include globs from the
    // raw spelling made every real change miss and select nothing.
    const raw = mkdtempSync(join(tmpdir(), 'cbd-config-link-'))
    try {
      const config = parseConfig({ include: ['src/**'] }, raw)
      const canonical = realpathSync(raw)
      assert.equal(config.root, canonical)
      assert.equal(config.select!.include!(join(canonical, 'src/a.ts')), true)
      assert.equal(config.select!.include!(join(canonical, 'docs/a.md')), false)
    } finally {
      rmSync(raw, { recursive: true, force: true })
    }
  })

  test('an empty file is the safe default', () => {
    const { root, cleanup } = tempRoot()
    try {
      const config = parseConfig({}, root)
      assert.deepEqual(config, { root })
    } finally {
      cleanup()
    }
  })

  test('an unknown key is refused rather than ignored', () => {
    const { root, cleanup } = tempRoot()
    try {
      assert.throws(() => parseConfig({ includ: ['src/**'] }, root), /unknown key "includ"/)
    } finally {
      cleanup()
    }
  })

  test('policy and type mistakes are named', () => {
    const { root, cleanup } = tempRoot()
    try {
      assert.throws(() => parseConfig({ unknownPolicy: 'maybe' }, root), /"unknownPolicy" must be/)
      assert.throws(
        () => parseConfig({ testFilePolicy: 'every' }, root),
        /"testFilePolicy" must be "known" or "all"/,
      )
      assert.throws(() => parseConfig({ include: 'src/**' }, root), /"include" must be an array/)
      assert.throws(() => parseConfig({ maxAgeCommits: -1 }, root), /non-negative integer/)
      assert.throws(() => parseConfig({ maxAgeCommits: 1.5 }, root), /non-negative integer/)
      assert.throws(() => parseConfig({ strict: 'yes' }, root), /"strict" must be a boolean/)
      assert.throws(() => parseConfig(null, root), /must contain a JSON object/)
    } finally {
      cleanup()
    }
  })

  test('mapsDir is a non-empty string when present', () => {
    const { root, cleanup } = tempRoot()
    try {
      assert.throws(() => parseConfig({ mapsDir: '' }, root), /"mapsDir" must be a non-empty string/)
      assert.throws(() => parseConfig({ mapsDir: 1 }, root), /"mapsDir" must be a non-empty string/)
    } finally {
      cleanup()
    }
  })

  test('alwaysSelect entries are validated, not dropped when malformed', () => {
    const { root, cleanup } = tempRoot()
    try {
      assert.throws(
        () => parseConfig({ alwaysSelect: 'tests/a.spec.ts' }, root),
        /"alwaysSelect" must be an array/,
      )
      assert.throws(
        () => parseConfig({ alwaysSelect: [{ when: ['src/**'] }] }, root),
        /alwaysSelect\[0\]\.tests must be a non-empty array/,
      )
      assert.throws(
        () => parseConfig({ alwaysSelect: [{ tests: [] }] }, root),
        /alwaysSelect\[0\]\.tests must be a non-empty array/,
      )
      assert.throws(
        () => parseConfig({ alwaysSelect: [{ tests: ['a.spec.ts'], when: [] }] }, root),
        /alwaysSelect\[0\]\.when must not be empty/,
      )
      assert.throws(
        () => parseConfig({ alwaysSelect: [{ tests: ['a.spec.ts'], extra: true }] }, root),
        /alwaysSelect\[0\] has an unknown key "extra"/,
      )
      assert.throws(
        () => parseConfig({ alwaysSelect: [{ tests: ['a.spec.ts > '] }] }, root),
        /empty test title/,
      )
    } finally {
      cleanup()
    }
  })

  test('unknownPolicyFor entries are validated', () => {
    const { root, cleanup } = tempRoot()
    try {
      assert.throws(
        () => parseConfig({ unknownPolicyFor: 'tools/**' }, root),
        /"unknownPolicyFor" must be an array/,
      )
      assert.throws(
        () => parseConfig({ unknownPolicyFor: [{ paths: [] }] }, root),
        /unknownPolicyFor\[0\]\.paths must be a non-empty array/,
      )
      assert.throws(
        () => parseConfig({ unknownPolicyFor: [{ paths: ['a/**'], policy: 'warn' }] }, root),
        /unknownPolicyFor\[0\]\.policy must be "all" or "ignore"/,
      )
      assert.throws(
        () => parseConfig({ unknownPolicyFor: [{ paths: ['a/**'], extra: 1 }] }, root),
        /unknownPolicyFor\[0\] has an unknown key "extra"/,
      )
    } finally {
      cleanup()
    }
  })

  test('granularity: test is accepted, group is refused as not built', () => {
    const { root, cleanup } = tempRoot()
    try {
      assert.doesNotThrow(() => parseConfig({ granularity: 'test' }, root))
      assert.throws(() => parseConfig({ granularity: 'group' }, root), /not built yet/)
    } finally {
      cleanup()
    }
  })

  test('a missing file means defaults; a malformed one is an error', () => {
    const { root, cleanup } = tempRoot()
    try {
      assert.equal(loadConfig(root), undefined)

      writeFileSync(configPath(root), '{ not json')
      assert.throws(() => loadConfig(root), /not valid JSON/)

      writeFileSync(configPath(root), JSON.stringify({ include: ['src/**'] }))
      const loaded = loadConfig(root)!
      assert.equal(loaded.path, configPath(root))
      assert.equal(loaded.config.configFile, realpathSync(configPath(root)))
      assert.equal(loaded.config.select!.include!(join(root, 'src/a.ts')), true)
    } finally {
      cleanup()
    }
  })

  test('an explicit path reads the same rules against the given root', () => {
    const { root, cleanup } = tempRoot()
    try {
      const path = join(root, 'elsewhere.json')
      writeFileSync(path, JSON.stringify({ exclude: ['**/*.d.ts'] }))

      const loaded = loadConfigFile(path, root)!
      assert.equal(loaded.path, path)
      assert.equal(loaded.config.root, root)
      assert.equal(loaded.config.select!.include!(join(root, 'src/types.d.ts')), false)
      assert.equal(loaded.config.select!.include!(join(root, 'src/a.ts')), true)

      assert.equal(loadConfigFile(join(root, 'absent.json'), root), undefined)
    } finally {
      cleanup()
    }
  })
})

test('stateDir must name a directory under the root', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cbd-state-')))
  try {
    for (const stateDir of ['', '.', '..', '/tmp/elsewhere']) {
      assert.throws(
        () => parseConfig({ stateDir }, root),
        /"stateDir" must name a non-empty directory under the root/,
        stateDir,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an empty include or exclude is refused instead of matching nothing', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cbd-include-')))
  try {
    assert.throws(() => parseConfig({ include: [] }, root), /"include" must not be empty/)
    assert.throws(() => parseConfig({ exclude: [] }, root), /"exclude" must not be empty/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
