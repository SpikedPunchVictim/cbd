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
import { join, resolve, sep } from 'node:path'
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

/** Files each test read, and directories it listed: both are selection relevance. */
function readByTest(map: CoverageMap, kind: 'reads' | 'dirReads'): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>()
  for (const [path, indices] of Object.entries(map[kind] ?? {})) {
    for (const index of indices) {
      const set = out.get(index) ?? new Set<string>()
      set.add(path)
      out.set(index, set)
    }
  }
  // A group's members share one set instead of each getting a copy; a member that
  // also has its own entries (or is in another group) gets a union.
  for (const group of map.readGroups ?? []) {
    const shared = new Set(group[kind])
    if (shared.size === 0) continue
    for (const index of group.tests) {
      const own = out.get(index)
      out.set(index, own === undefined ? shared : new Set([...own, ...shared]))
    }
  }
  return out
}

/** Tests with an invisible dependency: any in-scope change can explain a flip. */
function opaqueTests(map: CoverageMap): Set<number> {
  const out = new Set<number>()
  for (const indices of Object.values(map.opaque ?? {})) for (const index of indices) out.add(index)
  return out
}

/**
 * A map's tests as outcomes. A failure is in `nonGreen`, by identity alone, so its
 * index (-1) names no touches and no reads: the other side of the flip carries them.
 */
function outcomesOf(map: CoverageMap): Array<{ test: TestEntry; index: number }> {
  const out = map.tests.map((test, index) => ({ test, index }))
  for (const entry of map.nonGreen ?? []) {
    out.push({
      test: {
        title: entry.title,
        file: entry.file,
        ...(entry.ordinal === undefined ? {} : { ordinal: entry.ordinal }),
        status: 'failed',
      },
      index: -1,
    })
  }
  return out
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
    const readsBefore = readByTest(before, 'reads')
    const readsAfter = readByTest(after, 'reads')
    const dirsBefore = readByTest(before, 'dirReads')
    const dirsAfter = readByTest(after, 'dirReads')
    const opaqueBefore = opaqueTests(before)
    const opaqueAfter = opaqueTests(after)
    const prior = new Map<string, { test: TestEntry; index: number }>()
    for (const { test, index } of outcomesOf(before)) prior.set(keyOf(test), { test, index })

    for (const { test, index: at } of outcomesOf(after)) {
      const earlier = prior.get(keyOf(test))
      if (earlier === undefined) continue
      const from = earlier.test.status
      const to = test.status
      if (from !== 'passed' && from !== 'failed') continue
      if (to !== 'passed' && to !== 'failed') continue
      if (from === to) continue

      const relevant = (files: Set<string> | undefined): boolean =>
        files !== undefined && [...files].some((file) => changed.has(file))
      // A listed directory is relevant when any changed path is under it.
      const underListed = (dirs: Set<string> | undefined): boolean =>
        dirs !== undefined &&
        [...dirs].some((dir) => [...changed].some((file) => file === dir || file.startsWith(`${dir}${sep}`)))
      const spec = test.file === null ? undefined : resolve(options.root, test.file)
      if (
        opaqueBefore.has(earlier.index) ||
        opaqueAfter.has(at) ||
        relevant(touchedBefore.get(earlier.index)) ||
        relevant(touchedAfter.get(at)) ||
        relevant(readsBefore.get(earlier.index)) ||
        relevant(readsAfter.get(at)) ||
        underListed(dirsBefore.get(earlier.index)) ||
        underListed(dirsAfter.get(at)) ||
        (spec !== undefined && changed.has(spec))
      ) {
        continue
      }

      const key = keyOf(test)
      const group = groups.get(key) ?? { file: test.file, title: test.title, flips: [] }
      group.flips.push({
        from: observation(before.commit, before.builtAt, earlier.test),
        to: observation(after.commit, after.builtAt, test),
      })
      groups.set(key, group)
    }
  }

  return {
    maps: maps.length,
    flaky: [...groups.values()].sort(
      (a, b) => a.title.localeCompare(b.title) || (a.file ?? '').localeCompare(b.file ?? ''),
    ),
  }
}
