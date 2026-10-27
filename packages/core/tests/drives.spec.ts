/**
 * `realpath` and git on a `subst` drive and on a mapped network drive.
 *
 * The native realpath answers the final path (`C:\...`, `\\host\share\...`), not
 * the drive letter the path was reached through. These tests pin that git spells
 * the same repository the same way, so a root typed as `X:\` and one found by git
 * compare equal. Windows only; the drives are created for real.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { canonicalPath, realpath } from '../src/paths.js'

// Letters disjoint from the CLI's drive tests: `pnpm -r test` can run both packages at once.
function freeLetter(): string {
  for (const letter of 'XYZWV') if (!existsSync(`${letter}:\\`)) return `${letter}:`
  throw new Error('no free drive letter')
}

/** Run `body` with `dir` reachable as a drive. `kind` is how: `subst`, or a mapped admin share. */
function withDrive(kind: 'subst' | 'mapped', dir: string, body: (drive: string, target: string) => void): void {
  const drive = freeLetter()
  if (kind === 'subst') {
    execFileSync('subst', [drive, dir])
    try {
      body(drive, dir)
    } finally {
      execFileSync('subst', [drive, '/D'])
    }
    return
  }
  const unc = `\\\\localhost\\${dir.replace(':', '$')}`
  execFileSync('net', ['use', drive, unc])
  try {
    body(drive, unc)
  } finally {
    execFileSync('net', ['use', drive, '/delete', '/y'])
  }
}

const gitTop = (cwd: string): string =>
  execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' })
    .trim()
    .replace(/\//g, '\\')

for (const kind of ['subst', 'mapped'] as const) {
  test.group(`${kind} drive`, () => {
    test('realpath, canonicalPath and git spell the repository alike', () => {
      const dir = realpath(mkdtempSync(join(tmpdir(), 'cbd-drive-')))
      try {
        execFileSync('git', ['init', '-q'], { cwd: dir })
        mkdirSync(join(dir, 'sub'))
        writeFileSync(join(dir, 'sub', 'a.txt'), 'x')
        withDrive(kind, dir, (drive, target) => {
          // The drive letter is not a spelling of its own: it resolves to its target.
          assert.equal(realpath(`${drive}\\`), target)
          assert.equal(realpath(`${drive}\\sub`), join(target, 'sub'))
          assert.equal(canonicalPath(`${drive}\\sub\\missing\\x.ts`), join(target, 'sub', 'missing', 'x.ts'))
          // git, started from inside the drive, names the same directory.
          assert.equal(gitTop(`${drive}\\sub`).toLowerCase(), realpath(`${drive}\\sub`).replace(/\\sub$/, '').toLowerCase())
          // And its paths are repository-relative, so no drive letter reaches a comparison.
          const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
            cwd: `${drive}\\`,
            encoding: 'utf8',
          })
          assert.equal(status.trim(), '?? sub/a.txt')
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }).skip(process.platform !== 'win32', 'subst and mapped drives are Windows only')
  })
}
