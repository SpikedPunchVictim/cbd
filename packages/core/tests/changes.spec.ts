import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { changesSince, parseUnifiedDiff } from '../src/changes.js'
import { tempRepo } from './support/git.js'

test('a modification yields a hunk on the old side', () => {
  const repo = tempRepo()
  try {
    repo.write('a.ts', 'one\ntwo\nthree\n')
    const base = repo.commit('base')
    repo.write('a.ts', 'one\nTWO\nthree\n')

    const [change] = changesSince({ root: repo.root, since: base })
    assert.equal(change?.path, 'a.ts')
    assert.equal(change?.status, 'M')
    assert.equal(change?.from, undefined, 'a plain modification is not a rename')
    assert.deepEqual(change?.hunks, [{ start: 2, end: 2 }])
    assert.deepEqual(change?.newHunks, [{ start: 2, end: 2 }])
  } finally {
    repo.cleanup()
  }
})

test('an addition reports the file as new, with no old-side range', () => {
  const repo = tempRepo()
  try {
    repo.write('a.ts', 'one\n')
    const base = repo.commit('base')
    repo.write('b.ts', 'x\ny\n')
    repo.commit('add b')

    const change = changesSince({ root: repo.root, since: base }).find((c) => c.path === 'b.ts')
    assert.equal(change?.status, 'A')
    // Additions have nothing on the old side, so no range is claimable for them.
    assert.deepEqual(change?.hunks, [])
    // ...and everything on the new side, which is what an oracle needs.
    assert.deepEqual(change?.newHunks, [{ start: 1, end: 2 }])
    // An added file is inserted at the start of an empty old side.
    assert.deepEqual(change?.insertions, [0])
  } finally {
    repo.cleanup()
  }
})

test('a deletion keeps its old-side range, which is all it has', () => {
  const repo = tempRepo()
  try {
    repo.write('gone.ts', '1\n2\n3\n4\n')
    repo.write('keep.ts', 'k\n')
    const base = repo.commit('base')
    repo.remove('gone.ts')
    repo.commit('delete')

    const change = changesSince({ root: repo.root, since: base }).find((c) => c.path === 'gone.ts')
    assert.equal(change?.status, 'D')
    assert.deepEqual(change?.hunks, [{ start: 1, end: 4 }])
    assert.deepEqual(change?.newHunks, [], 'a deletion has no new-side range')
  } finally {
    repo.cleanup()
  }
})

test('a pure insertion into an existing file carries its insertion point', () => {
  const repo = tempRepo()
  try {
    repo.write('a.ts', 'one\ntwo\nthree\n')
    const base = repo.commit('base')
    repo.write('a.ts', 'one\ntwo\nthree\nfour\nfive\n')

    const [change] = changesSince({ root: repo.root, since: base })
    // No old-side lines exist for the new block, so it is not a hunk — and that
    // is exactly why `select` ignored it before `cbd-81h.1`.
    assert.deepEqual(change?.hunks, [])
    assert.deepEqual(change?.insertions, [3])
    assert.deepEqual(change?.newHunks, [{ start: 4, end: 5 }])
  } finally {
    repo.cleanup()
  }
})

test('a rename carries the path it came from', () => {
  const repo = tempRepo()
  try {
    repo.write('old.ts', 'alpha\nbeta\ngamma\n')
    const base = repo.commit('base')
    repo.git(['mv', 'old.ts', 'new.ts'])
    repo.commit('rename')

    const [change] = changesSince({ root: repo.root, since: base })
    assert.equal(change?.path, 'new.ts')
    assert.equal(change?.status, 'R')
    assert.equal(change?.from, 'old.ts')
  } finally {
    repo.cleanup()
  }
})

test('a rename with modification reports both the old path and the hunks', () => {
  const repo = tempRepo()
  try {
    repo.write('old.ts', 'alpha\nbeta\ngamma\ndelta\n')
    const base = repo.commit('base')
    repo.git(['mv', 'old.ts', 'new.ts'])
    repo.write('new.ts', 'alpha\nBETA\ngamma\ndelta\n')
    repo.commit('rename and edit')

    const [change] = changesSince({ root: repo.root, since: base })
    assert.equal(change?.path, 'new.ts')
    assert.equal(change?.status, 'R')
    assert.equal(change?.from, 'old.ts')
    assert.deepEqual(change?.hunks, [{ start: 2, end: 2 }])
  } finally {
    repo.cleanup()
  }
})

/**
 * The range trap. Three hunks accumulate offset as you read down the file, so by
 * the third one the worktree-side line number is far from the map-commit one. The
 * map's function ranges were measured at the map's commit, so only the old-side
 * numbers are comparable — using new-side ones would push the third hunk into the
 * *following* function and select the wrong callers, silently.
 */
test('hunks use old-side line numbers, which do not drift as earlier hunks grow', () => {
  const repo = tempRepo()
  try {
    const original = [
      'function one() {', // 1
      '  return 1', // 2
      '}', // 3
      'function two() {', // 4
      '  return 2', // 5
      '}', // 6
      'function three() {', // 7
      '  return 3', // 8
      '}', // 9
      'function four() {', // 10
      '  return 4', // 11
      '}', // 12
    ].join('\n')
    repo.write('a.ts', `${original}\n`)
    const base = repo.commit('base')

    // Grow the first function by two lines, then edit the third. The third
    // function's line number moves from 7 to 9 in the worktree.
    const edited = [
      'function one() {', // 1
      '  const a = 1', // 2  added
      '  const b = 2', // 3  added
      '  return a + b', // 4  changed
      '}', // 5
      'function two() {', // 6
      '  return 2', // 7
      '}', // 8
      'function THREE() {', // 9  <- was line 7
      '  return 3', // 10
      '}', // 11
      'function four() {', // 12
      '  return 4', // 13
      '}', // 14
    ].join('\n')
    repo.write('a.ts', `${edited}\n`)

    const [change] = changesSince({ root: repo.root, since: base })
    assert.equal(change?.path, 'a.ts')

    // Old-side: the first function is lines 1-2, the third is line 7.
    const starts = change?.hunks.map((h) => h.start)
    assert.ok(starts?.includes(7), `third hunk should start at old-side line 7, got ${starts}`)
    assert.equal(
      starts?.includes(9),
      false,
      'a hunk used the worktree line number, which has drifted by the hunks above it',
    )

    // The same hunk on the new side is line 9 — the drift the selector must not
    // see and the oracle must.
    const newStarts = change?.newHunks?.map((h) => h.start)
    assert.ok(newStarts?.includes(9), `the new-side hunk should start at 9, got ${newStarts}`)
  } finally {
    repo.cleanup()
  }
})

test('parseUnifiedDiff keeps a file with no hunks, such as a pure mode change', () => {
  const diff = [
    'diff --git a/script.sh b/script.sh',
    'old mode 100644',
    'new mode 100755',
  ].join('\n')
  const [change] = parseUnifiedDiff(diff)
  assert.equal(change?.path, 'script.sh')
  assert.deepEqual(change?.hunks, [])
})

test('nothing changed yields nothing', () => {
  const repo = tempRepo()
  try {
    repo.write('a.ts', 'one\n')
    const base = repo.commit('base')
    assert.deepEqual(changesSince({ root: repo.root, since: base }), [])
  } finally {
    repo.cleanup()
  }
})

// `cbd-0na.1`: `git diff` never lists an untracked file, so a new file under
// include was invisible and `select` answered "nothing changed".
test('an untracked file is a change in worktree mode', () => {
  const repo = tempRepo()
  try {
    repo.write('a.ts', 'one\n')
    const base = repo.commit('base')
    repo.write('src/new.ts', 'import pg from "pg"\n')

    const change = changesSince({ root: repo.root, since: base }).find(
      (entry) => entry.path === 'src/new.ts',
    )
    assert.equal(change?.status, 'A')
    assert.deepEqual(change?.hunks, [], 'an untracked file has no old side')
    assert.deepEqual(change?.insertions, [0], 'a new file is inserted at the start')
  } finally {
    repo.cleanup()
  }
})

test('an untracked file under a subdirectory root is relative to that root', () => {
  const repo = tempRepo()
  try {
    repo.write('packages/app/src/a.ts', 'one\n')
    const base = repo.commit('base')
    repo.write('packages/app/src/new.ts', 'two\n')

    // The same coordinate `git diff --relative` uses: `src/new.ts`, not the
    // repository-relative path, so the factory's `resolve(root, …)` is right.
    const changes = changesSince({ root: join(repo.root, 'packages/app'), since: base })
    assert.deepEqual(changes.map((change) => change.path), ['src/new.ts'])
  } finally {
    repo.cleanup()
  }
})

test('an ignored untracked file is not a change', () => {
  const repo = tempRepo()
  try {
    repo.write('.gitignore', '*.gen.ts\n')
    repo.write('a.ts', 'one\n')
    const base = repo.commit('base')
    repo.write('src/data.gen.ts', 'generated\n')
    repo.write('src/new.ts', 'hand-written\n')

    const paths = changesSince({ root: repo.root, since: base }).map((entry) => entry.path)
    assert.deepEqual(paths, ['src/new.ts'])
  } finally {
    repo.cleanup()
  }
})

test('--no-worktree asks about a commit, so untracked files are not changes', () => {
  const repo = tempRepo()
  try {
    repo.write('a.ts', 'one\n')
    const base = repo.commit('base')
    repo.write('src/new.ts', 'untracked\n')

    assert.deepEqual(changesSince({ root: repo.root, since: base, worktree: false }), [])
  } finally {
    repo.cleanup()
  }
})
