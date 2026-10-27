/**
 * The CLI reached through a `subst` drive and a mapped network drive.
 *
 * The root it finds, and the selection it computes, must be the ones it gets from
 * the real path: git names the repository by its final path, and a drive-letter
 * spelling of the same directory must not make `--root`, the repository-root walk
 * or the dirty-tree check disagree. Windows only; the drives are created for real.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '@japa/runner'
import { defaultRoot } from '../src/args.js'
import { EXIT } from '../src/cli.js'
import { invoke, prepared } from './support/repo.js'

// Letters disjoint from core's drive tests: `pnpm -r test` can run both packages at once.
function freeLetter(): string {
  for (const letter of 'UTSRQ') if (!existsSync(`${letter}:\\`)) return `${letter}:`
  throw new Error('no free drive letter')
}

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

for (const kind of ['subst', 'mapped'] as const) {
  test.group(`cbd on a ${kind} drive`, () => {
    test('the root found from inside the drive is the real one', () => {
      const { root, cleanup } = prepared()
      try {
        withDrive(kind, root, (drive, target) => {
          assert.equal(defaultRoot(`${drive}\\`), target)
          assert.equal(defaultRoot(`${drive}\\src`), target)
        })
      } finally {
        cleanup()
      }
    }).skip(process.platform !== 'win32', 'subst and mapped drives are Windows only')

    test('build and select from the drive agree with the real path, dirty tree included', () => {
      const { repo, root, cleanup } = prepared()
      try {
        withDrive(kind, root, (drive) => {
          assert.equal(invoke(`${drive}\\`, 'build').code, EXIT.ok)
          repo.write('src/a.ts', 'export function add(a, b) {\n  return b + a;\n}\n')

          const viaDrive = invoke(`${drive}\\`, 'select')
          const direct = invoke(root, 'select')
          assert.equal(viaDrive.code, EXIT.ok)
          assert.deepEqual(viaDrive.out, direct.out)
          assert.ok(viaDrive.out.includes(`${join('tests', 'a.spec.ts')} > adds`))
        })
      } finally {
        cleanup()
      }
    }).skip(
      process.platform !== 'win32' || kind === 'mapped',
      // The fixture's shard names files by their local path; a share of the same
      // directory is a second spelling no realpath can unify, so only subst compares.
      'a subst drive resolves to the path the fixture recorded',
    )

    test('--root given as the drive letter names the same repository', () => {
      const { root, cleanup } = prepared()
      try {
        withDrive(kind, root, (drive) => {
          assert.equal(invoke(root, 'build', '--root', `${drive}\\`).code, EXIT.ok)
          assert.equal(invoke(`${drive}\\`, 'select').code, EXIT.ok)
        })
      } finally {
        cleanup()
      }
    }).skip(process.platform !== 'win32', 'subst and mapped drives are Windows only')
  })
}
