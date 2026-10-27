import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { changesSince, mergeChanges, parseUnifiedDiff, type Change } from '../src/changes.js'
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
    assert.deepEqual(change?.newInsertions, [0], 'the hole is at the start of the new side')
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

/**
 * `select --since` needs the change between a caller's base and the map's commit
 * read on the map's side. The old side belongs to the caller's base, whose line
 * numbers moved, so a selector comparing them with the map's function ranges
 * names the wrong function and silently drops the tests that reach the changed
 * one. `to` is how that second side is asked for, and untracked files are not
 * part of a two-commit question.
 */
test('a two-commit diff reports hunks on the side of the commit it ends at', () => {
  const repo = tempRepo()
  try {
    repo.write('a.ts', 'one\ntwo\nthree\nfour\nfive\n')
    const base = repo.commit('base')
    repo.write('a.ts', 'one\nnew-a\nnew-b\ntwo\nthree\nFOUR\nfive\n')
    const end = repo.commit('end')
    repo.write('untracked.ts', 'not part of the commit\n')

    const changes = changesSince({ root: repo.root, since: base, to: end })
    assert.deepEqual(changes.map((change) => change.path), ['a.ts'])

    const [change] = changes
    // Old side: line 4. New side: lines 2-3 (the insertion) and line 6.
    assert.deepEqual(change?.hunks, [{ start: 4, end: 4 }])
    assert.deepEqual(change?.newHunks, [
      { start: 2, end: 3 },
      { start: 6, end: 6 },
    ])
  } finally {
    repo.cleanup()
  }
})

test('an in-file deletion reports a new-side insertion point', () => {
  const repo = tempRepo()
  try {
    repo.write('a.ts', 'one\ntwo\nthree\n')
    const base = repo.commit('base')
    repo.write('a.ts', 'one\nthree\n')

    const [change] = changesSince({ root: repo.root, since: base })
    assert.deepEqual(change?.hunks, [{ start: 2, end: 2 }])
    assert.deepEqual(change?.newHunks, [], 'there are no new-side lines to range over')
    assert.deepEqual(change?.newInsertions, [1], 'the deleted line left a hole after line 1')
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

test('a failed untracked listing refuses the selection instead of dropping new files', () => {
  const diff =
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-one\n+TWO\n'
  const exec = (args: string[]): string => {
    if (args.includes('diff')) return diff
    throw new Error('simulated failure')
  }

  // The diff was readable, but the new-file list was not. A selection that cannot
  // see an untracked file may answer with a subset that silently omits it, so the
  // answer is an error rather than the incomplete change set.
  assert.throws(
    () => changesSince({ root: '/repo', since: 'HEAD', exec }),
    /git ls-files --others failed in \/repo/,
  )
})

// `cbd select --since` asks about two baselines at once: the one the caller named
// and the map's commit, which is what the recording covers. One answer is the union.
test('mergeChanges unions hunks by path and keeps a rename', () => {
  const fromBase: Change[] = [
    { path: '/r/a.ts', status: 'A', hunks: [{ start: 3, end: 4 }], insertions: [2], newHunks: [{ start: 3, end: 4 }] },
    { path: '/r/b.ts', status: 'M', hunks: [{ start: 1, end: 1 }] },
    { path: '/r/renamed.ts', status: 'R', from: '/r/old.ts', hunks: [] },
  ]
  const fromMap: Change[] = [
    { path: '/r/a.ts', status: 'M', hunks: [{ start: 1, end: 1 }, { start: 3, end: 4 }] },
    { path: '/r/b.ts', status: 'D', hunks: [{ start: 1, end: 2 }] },
  ]

  const merged = mergeChanges(fromBase, fromMap)
  assert.deepEqual(merged.map((change) => change.path).sort(), ['/r/a.ts', '/r/b.ts', '/r/renamed.ts'])

  const a = merged.find((change) => change.path === '/r/a.ts')!
  assert.deepEqual(a.hunks, [
    { start: 1, end: 1 },
    { start: 3, end: 4 },
  ])
  assert.deepEqual(a.insertions, [2])
  assert.equal(a.status, 'A')

  // A modification on the map side wins over a deletion on the base side: the
  // file is not simply gone, and the function rules can still answer.
  const b = merged.find((change) => change.path === '/r/b.ts')!
  assert.equal(b.status, 'M')
  assert.deepEqual(b.hunks, [
    { start: 1, end: 2 },
  ])

  const renamed = merged.find((change) => change.path === '/r/renamed.ts')!
  assert.equal(renamed.from, '/r/old.ts')
})

test('mergeChanges deduplicates the same hunk seen from both sides', () => {
  const one: Change = { path: '/r/a.ts', status: 'M', hunks: [{ start: 2, end: 2 }] }
  const merged = mergeChanges([one], [{ ...one, hunks: [{ start: 2, end: 2 }] }])
  assert.deepEqual(merged[0]?.hunks, [{ start: 2, end: 2 }])
})

test('a non-ASCII path survives the diff and the untracked list', () => {
  const repo = tempRepo()
  try {
    repo.write('src/café.ts', 'const x = 1\n')
    repo.write('src/plain.ts', 'const p = 1\n')
    const base = repo.commit('base')
    repo.write('src/café.ts', 'const x = 2\n')
    repo.write('src/naïve.ts', 'const n = 1\n')

    const changes = changesSince({ root: repo.root, since: base })
    assert.deepEqual(
      changes.map((entry) => [entry.path, entry.status]).sort(),
      [
        ['src/café.ts', 'M'],
        ['src/naïve.ts', 'A'],
      ],
    )
  } finally {
    repo.cleanup()
  }
})

test('--no-worktree reads the range from the map to HEAD', () => {
  const repo = tempRepo()
  try {
    repo.write('src/a.ts', 'a1\na2\na3\na4\na5\n')
    const base = repo.commit('A')
    repo.write('src/a.ts', 'n1\nn2\na1\na2\nX\na4\na5\n')
    repo.write('src/added.ts', 'x\n')
    repo.commit('B')

    const changes = changesSince({ root: repo.root, since: base, worktree: false })
    const modified = changes.find((entry) => entry.path === 'src/a.ts')!
    const added = changes.find((entry) => entry.path === 'src/added.ts')!
    // A→B: the edit is at the map's line 3 and B's line 5; the reverse direction
    // would report hunks 1-2 (the insertion as a deletion) and mark added.ts D.
    assert.deepEqual(modified.hunks, [{ start: 3, end: 3 }])
    assert.deepEqual(modified.newHunks, [
      { start: 1, end: 2 },
      { start: 5, end: 5 },
    ])
    assert.equal(added.status, 'A')
  } finally {
    repo.cleanup()
  }
})

// git appends a TAB to `---`/`+++` when the path contains a space. Keeping it made
// the change match no include glob, so a spaced file's tests were silently not
// selected.
test('a path containing a space is reported without git’s separator', () => {
  const repo = tempRepo()
  try {
    repo.write('src/my file.ts', 'one\n')
    const base = repo.commit('base')
    repo.write('src/my file.ts', 'two\n')

    const [change] = changesSince({ root: repo.root, since: base })
    assert.equal(change?.path, 'src/my file.ts')
    // The header paths agree, so this is a modification — not a rename from the
    // untabbed spelling to the tabbed one.
    assert.equal(change?.from, undefined)
    assert.equal(change?.status, 'M')
  } finally {
    repo.cleanup()
  }
})

// The separator between the two sides of `diff --git` is ` b/`, which a path may
// itself contain.
test('a path containing " b/" is split at the right separator', () => {
  const repo = tempRepo()
  try {
    repo.write('x b/del.ts', 'keep\n')
    const base = repo.commit('base')
    repo.remove('x b/del.ts')

    const [change] = changesSince({ root: repo.root, since: base })
    assert.equal(change?.path, 'x b/del.ts')
    assert.equal(change?.status, 'D')
  } finally {
    repo.cleanup()
  }
})

// `git ls-files -z` is NUL-separated, so its output needs no trimming — and
// trimming rewrites a name whose last byte is a space.
test('an untracked name keeps significant whitespace', () => {
  const repo = tempRepo()
  try {
    repo.write('a.ts', 'one\n')
    const base = repo.commit('base')
    repo.write('trailing ', 'x\n')

    const added = changesSince({ root: repo.root, since: base }).find((entry) => entry.status === 'A')
    assert.equal(added?.path, 'trailing ')
  } finally {
    repo.cleanup()
  }
})

// The parser strips `a/` and `b/` from every header. A user's own git config can
// rename or remove those prefixes, and a path that keeps one matches no include
// glob and no map entry, so the change was silently dropped.
for (const [name, config] of [
  ['diff.mnemonicPrefix', [['diff.mnemonicPrefix', 'true']]],
  ['diff.noprefix', [['diff.noprefix', 'true']]],
  [
    'diff.srcPrefix and diff.dstPrefix',
    [
      ['diff.srcPrefix', 'old/'],
      ['diff.dstPrefix', 'new/'],
    ],
  ],
] as const) {
  test(`${name} in the user's git config does not change the reported paths`, () => {
    const repo = tempRepo()
    try {
      repo.write('src/a.ts', 'one\ntwo\n')
      repo.write('src/gone.ts', 'x\n')
      const base = repo.commit('base')
      repo.write('src/a.ts', 'one\nTWO\n')
      repo.git(['mv', 'src/gone.ts', 'src/moved.ts'])
      for (const [key, value] of config) repo.git(['config', key, value])

      const changes = changesSince({ root: repo.root, since: base })
      assert.deepEqual(
        changes.map((c) => [c.path, c.from, c.status]),
        [
          ['src/a.ts', undefined, 'M'],
          ['src/moved.ts', 'src/gone.ts', 'R'],
        ],
      )
    } finally {
      repo.cleanup()
    }
  })
}

// A textconv driver rewrites what the hunks are computed from, so the line numbers
// no longer describe the committed file.
test('a configured textconv driver does not change the reported hunks', () => {
  const repo = tempRepo()
  try {
    repo.write('.gitattributes', '*.ts diff=cbdtest\n')
    repo.write('a.ts', 'one\ntwo\nthree\n')
    const base = repo.commit('base')
    repo.write('a.ts', 'one\ntwo\nTHREE\n')
    repo.git(['config', 'diff.cbdtest.textconv', 'head -n 1'])

    const [change] = changesSince({ root: repo.root, since: base })
    assert.deepEqual(change?.hunks, [{ start: 3, end: 3 }])
  } finally {
    repo.cleanup()
  }
})

// Under `-U0` an added `++ x` is printed `+++ x`, and a removed `-- x` is printed
// `--- x`; both are body lines, not file headers.
test('an added or removed body line that looks like a header is not read as one', () => {
  const repo = tempRepo()
  try {
    repo.write('a.ts', 'one\n-- gone\ntwo\n')
    const base = repo.commit('base')
    repo.write('a.ts', 'one\ntwo\n++ x\n')

    const changes = changesSince({ root: repo.root, since: base })
    assert.deepEqual(
      changes.map((c) => [c.path, c.status]),
      [['a.ts', 'M']],
    )
    assert.deepEqual(changes[0]?.hunks, [{ start: 2, end: 2 }])
  } finally {
    repo.cleanup()
  }
})

test('a quoted path with an astral character is decoded whole', () => {
  const repo = tempRepo()
  // A double quote cannot appear in a Windows file name; the emoji alone still makes git quote the path.
  const name = process.platform === 'win32' ? 'q😀.ts' : 'q"😀.ts'
  try {
    repo.write('keep.ts', 'k\n')
    const base = repo.commit('base')
    repo.write(name, 'x\n')
    repo.commit('add')

    const change = changesSince({ root: repo.root, since: base }).find((c) => c.status === 'A')
    assert.equal(change?.path, name)
  } finally {
    repo.cleanup()
  }
})
