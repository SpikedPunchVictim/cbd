/**
 * A throwaway git repository per test.
 *
 * Real `git`, not a fake: `changesSince` shells out and its whole job is to read
 * git's hunk coordinates correctly, so a stub would test the parser against my own
 * assumptions rather than against what git actually emits.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface TempRepo {
  root: string
  git(args: string[]): string
  write(path: string, content: string): void
  remove(path: string): void
  commit(message: string): string
  head(): string
  cleanup(): void
}

export function tempRepo(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), 'cbd-git-'))
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' })

  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'CBD Test'])
  git(['config', 'commit.gpgsign', 'false'])

  const write = (path: string, content: string): void => {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }

  return {
    root,
    git,
    write,
    remove: (path: string) => rmSync(join(root, path), { force: true }),
    commit(message: string): string {
      git(['add', '-A'])
      git(['commit', '-q', '-m', message])
      return git(['rev-parse', 'HEAD']).trim()
    },
    head: () => git(['rev-parse', 'HEAD']).trim(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
