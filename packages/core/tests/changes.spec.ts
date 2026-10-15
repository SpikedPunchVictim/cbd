import assert from 'node:assert/strict'
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
