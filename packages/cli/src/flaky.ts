/**
 * `cbd flaky` — tests whose recorded outcome flips with no relevant change.
 *
 * A map keeps each test's last status. Two maps in a row that disagree are a
 * regression, a fix, or a flake; the difference is whether anything the test
 * reached changed between their commits. This reads the maps the repository keeps
 * (the same pool `gc` prunes), compares each adjacent pair in recording order, and
 * reports a flip only when neither map's touched files nor the test's own file
 * changed between the two commits. A test whose touching code changed is not called
 * flaky — it was answering a different tree.
 *
 * The command reports; it does not quarantine. A flip with no changed file is
 * evidence, and a test that is flaky on CI may be perfectly stable here.
 */
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  changesSince,
  loadMap,
  type CoverageMap,
  type TestEntry,
} from '@spikedpunch/cbd'

export interface FlakyOptions {
  /** Repository root. */
  root: string
  /** Relative to `root`; `.cbd` unless the config says otherwise. */
  stateDir?: string
  /** Where per-commit maps live instead of `<stateDir>/maps`. */
  mapsDir?: string
}

export interface FlakyObservation {
  commit: string
  builtAt: string
  status: 'passed' | 'failed'
  durationMs?: number
}

export interface FlakyFlip {
  from: FlakyObservation
  to: FlakyObservation
}

export interface FlakyTest {
  file: string | null
  title: string
  flips: FlakyFlip[]
}

export interface FlakyResult {
  /** Maps that could be read, not entries in the directory. */
  maps: number
  flaky: FlakyTest[]
}

const keyOf = (test: TestEntry): string =>
  `${test.file ?? ''}\u0000${test.title}\u0000${String(test.ordinal ?? 0)}`

/** The files each test reached, from the map's inverse index. */
function touchedByTest(map: CoverageMap): Map<number, Set<string>> {
  const touched = new Map<number, Set<string>>()
  for (const [file, functions] of Object.entries(map.files)) {
    for (const entry of Object.values(functions)) {
      for (const index of entry.tests) {
        const set = touched.get(index) ?? new Set<string>()
        set.add(file)
        touched.set(index, set)
      }
    }
  }
  return touched
}

const observation = (commit: string, builtAt: string, test: TestEntry): FlakyObservation => ({
  commit,
  builtAt,
  status: test.status as 'passed' | 'failed',
  ...(test.durationMs === undefined ? {} : { durationMs: test.durationMs }),
})

export function findFlaky(options: FlakyOptions): FlakyResult {
  const stateDir = options.stateDir ?? '.cbd'
  const base =
    options.mapsDir === undefined
      ? join(options.root, stateDir, 'maps')
      : resolve(options.root, options.mapsDir)

  let commits: string[] = []
  try {
    commits = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    // No state directory is no history, not a failure.
  }

  const maps: CoverageMap[] = []
  for (const commit of commits) {
    try {
      maps.push(loadMap(options.root, commit, stateDir, options.mapsDir).map)
    } catch {
      // A map that cannot be read is not evidence; skip it rather than stop.
    }
  }
  maps.sort((a, b) => a.builtAt.localeCompare(b.builtAt) || a.commit.localeCompare(b.commit))

  const groups = new Map<string, FlakyTest>()
  for (let index = 0; index + 1 < maps.length; index += 1) {
    const before = maps[index]!
    const after = maps[index + 1]!
    let changed: Set<string>
    try {
      changed = new Set(
        changesSince({
          root: options.root,
          since: before.commit,
          to: after.commit,
          worktree: false,
        }).map((change) => resolve(options.root, change.path)),
      )
    } catch {
      // Two maps whose commits cannot be diffed (a rewritten branch, a shared
      // mapsDir from another checkout) are not a basis for calling a test flaky.
      continue
    }

    const touchedBefore = touchedByTest(before)
    const touchedAfter = touchedByTest(after)
    const prior = new Map<string, { test: TestEntry; index: number }>()
    before.tests.forEach((test, at) => prior.set(keyOf(test), { test, index: at }))

    after.tests.forEach((test, at) => {
      const earlier = prior.get(keyOf(test))
      if (earlier === undefined) return
      const from = earlier.test.status
      const to = test.status
      if (from !== 'passed' && from !== 'failed') return
      if (to !== 'passed' && to !== 'failed') return
      if (from === to) return

      const relevant = (files: Set<string> | undefined): boolean =>
        files !== undefined && [...files].some((file) => changed.has(file))
      const spec = test.file === null ? undefined : resolve(options.root, test.file)
      if (
        relevant(touchedBefore.get(earlier.index)) ||
        relevant(touchedAfter.get(at)) ||
        (spec !== undefined && changed.has(spec))
      ) {
        return
      }

      const key = keyOf(test)
      const group = groups.get(key) ?? { file: test.file, title: test.title, flips: [] }
      group.flips.push({
        from: observation(before.commit, before.builtAt, earlier.test),
        to: observation(after.commit, after.builtAt, test),
      })
      groups.set(key, group)
    })
  }

  return {
    maps: maps.length,
    flaky: [...groups.values()].sort(
      (a, b) => a.title.localeCompare(b.title) || (a.file ?? '').localeCompare(b.file ?? ''),
    ),
  }
}
