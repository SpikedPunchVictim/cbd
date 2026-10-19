/**
 * A throwaway git repository per test.
 *
 * Copied from the core's test support rather than imported: the CLI package is a
 * published boundary like any other, and a test that reaches across packages would
 * make the CLI's build depend on core's test sources. Real `git` for the same
 * reason as there — `select` reads hunk coordinates, and a stub would only agree
 * with my own assumptions.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface TempRepo {
  root: string
  git(args: string[]): string
  write(path: string, content: string): void
  commit(message: string): string
  head(): string
  cleanup(): void
}

export function tempRepo(): TempRepo {
  const root = mkdtempSync(join(tmpdir(), 'cbd-cli-'))
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
    commit(message: string): string {
      git(['add', '-A'])
      git(['commit', '-q', '-m', message])
      return git(['rev-parse', 'HEAD']).trim()
    },
    head: () => git(['rev-parse', 'HEAD']).trim(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
