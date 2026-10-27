/**
 * `emitCheck`: the project's own TypeScript decides whether a file's module scope
 * changed at runtime. CBD reimplements none of TypeScript, so these tests drive a
 * real compiler (a pinned 5.x dev dependency; this repository's own `typescript`
 * is 7.x, which has no JS transpile API, and that case is a fallback test too).
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '@japa/runner'
import { compareModuleScope, moduleScopeUnchangedFiles } from '../src/emit-check.js'
import type { Change } from '../src/changes.js'
import { tempRepo } from './support/git.js'

const TYPESCRIPT = realpathSync(fileURLToPath(new URL('../../node_modules/typescript5', import.meta.url)))
const PIN = (JSON.parse(readFileSync(join(TYPESCRIPT, 'package.json'), 'utf8')) as { version: string }).version

interface Project {
  dir: string
  tsconfig: string
  cleanup: () => void
}

function project(options: { compilerOptions?: object; withTypescript?: boolean } = {}): Project {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cbd-emit-')))
  if (options.withTypescript !== false) {
    mkdirSync(join(dir, 'node_modules'))
    symlinkSync(TYPESCRIPT, join(dir, 'node_modules', 'typescript'), 'dir')
  }
  const tsconfig = join(dir, 'tsconfig.json')
  writeFileSync(
    tsconfig,
    JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext', ...options.compilerOptions } }),
  )
  return { dir, tsconfig, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const verdict = (p: Project, base: string, head: string): ReturnType<typeof compareModuleScope> =>
  compareModuleScope(p.tsconfig, join(p.dir, 'src/a.ts'), [base], head, PIN)

test.group('compareModuleScope', () => {
  test('a type-only module-scope change is unchanged', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const base = `export interface A { x: number }\nexport function f(): number { return 1 }\n`
    const head = `export interface A { x: number; y: string }\ntype Id = string\nexport function f(): number { return 1 }\n`
    assert.equal(verdict(p, base, head).unchanged, true)
  })

  test('comments and line shifts are not behaviour', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const base = `export const a = 1\n`
    const head = `// a note\n\n\nexport const a = 1 /* inline */\n`
    assert.equal(verdict(p, base, head).unchanged, true)
  })

  test('a changed module-scope value is a change', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    assert.equal(verdict(p, `export const a = 1\n`, `export const a = 2\n`).unchanged, false)
  })

  test('a new, used value import is a change', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const base = `export const a = 1\n`
    const head = `import { b } from './b.js'\nexport const a = b\n`
    assert.equal(verdict(p, base, head).unchanged, false)
  })

  test('an import used only as a type is erased, so unchanged', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const base = `export const a = 1\n`
    const head = `import type { B } from './b.js'\nexport const a: B = 1 as any\n`
    assert.equal(verdict(p, base, head).unchanged, true)
  })

  test('a change inside a function body leaves the module scope unchanged', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const base = `export function f() { return 1 }\nexport class C { m() { return 1 } }\n`
    const head = `export function f() { return 2 }\nexport class C { m() { return 3 } }\n`
    assert.equal(verdict(p, base, head).unchanged, true)
  })

  test('a class field initializer is module-scope work and is a change', ({ cleanup }) => {
    const p = project({ compilerOptions: { useDefineForClassFields: true } })
    cleanup(p.cleanup)
    const base = `export class C { static x = 1 }\n`
    const head = `export class C { static x = 2 }\n`
    assert.equal(verdict(p, base, head).unchanged, false)
  })

  test('a decorator change is a change under emitDecoratorMetadata', ({ cleanup }) => {
    const p = project({ compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } })
    cleanup(p.cleanup)
    const dec = `declare function dec(t: object, k: string): void\n`
    const base = `${dec}export class C { @dec x: string = '' }\n`
    const head = `${dec}export class C { @dec x: number = 0 }\n`
    // The property type is erased in plain emit, but design:type metadata records it.
    assert.equal(verdict(p, base, head).unchanged, false)
  })

  test('the same property type change is unchanged without decorator metadata', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const base = `export class C { x!: string }\n`
    const head = `export class C { x!: number }\n`
    assert.equal(verdict(p, base, head).unchanged, true)
  })

  test('every base version must match, not just one', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const result = compareModuleScope(
      p.tsconfig,
      join(p.dir, 'src/a.ts'),
      [`export const a = 1\n`, `export const a = 2\n`],
      `export const a = 1\n`,
      PIN,
    )
    assert.equal(result.unchanged, false)
  })

  test('a matching pin runs the check and reports the compiler version', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const result = verdict(p, `export interface A {}\n`, `export interface B {}\n`)
    assert.equal(result.unchanged, true)
    assert.equal(result.typescript, PIN)
  })

  test('a pin that differs from the resolved compiler is a fallback that says so', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const result = compareModuleScope(
      p.tsconfig,
      join(p.dir, 'src/a.ts'),
      [`export interface A {}\n`],
      `export interface B {}\n`,
      '0.0.1',
    )
    assert.equal(result.unchanged, false)
    assert.match(result.why ?? '', new RegExp(`resolved typescript ${PIN.replaceAll('.', '\\.')}, pinned 0\\.0\\.1`))
  })

  test('typescript missing from the project is a fallback', ({ cleanup }) => {
    const p = project({ withTypescript: false })
    cleanup(p.cleanup)
    const result = verdict(p, `export interface A {}\n`, `export interface B {}\n`)
    assert.equal(result.unchanged, false)
    assert.match(result.why ?? '', /typescript/)
  })

  test('a syntax error in either side is a fallback', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const result = verdict(p, `export const a = 1\n`, `export const a = = 1\n`)
    assert.equal(result.unchanged, false)
    assert.match(result.why ?? '', /transpile/)
  })

  test('an unreadable tsconfig is a fallback', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const result = compareModuleScope(join(p.dir, 'absent.json'), join(p.dir, 'src/a.ts'), ['x'], 'x', PIN)
    assert.equal(result.unchanged, false)
  })

  test('a TypeScript without the JS transpile API (7.x) is a fallback', ({ cleanup }) => {
    const p = project({ withTypescript: false })
    cleanup(p.cleanup)
    mkdirSync(join(p.dir, 'node_modules/typescript'), { recursive: true })
    writeFileSync(join(p.dir, 'node_modules/typescript/package.json'), '{"name":"typescript","main":"index.js"}')
    writeFileSync(join(p.dir, 'node_modules/typescript/index.js'), 'module.exports = { version: "7.0.0" }')
    const result = verdict(p, `export const a = 1\n`, `export const a = 1\n`)
    assert.equal(result.unchanged, false)
  })
})

test.group('moduleScopeUnchangedFiles', () => {
  const entryFor = (p: Project): { glob: string; tsconfig: string; typescript: string } => ({
    glob: join(p.dir, 'src/**'),
    tsconfig: p.tsconfig,
    typescript: PIN,
  })

  function repoWith(base: Record<string, string>) {
    const repo = tempRepo()
    // The project is the repository root itself.
    mkdirSync(join(repo.root, 'node_modules'), { recursive: true })
    symlinkSync(TYPESCRIPT, join(repo.root, 'node_modules', 'typescript'), 'dir')
    repo.write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext' } }))
    repo.write('.gitignore', 'node_modules/\n')
    for (const [path, text] of Object.entries(base)) repo.write(path, text)
    repo.commit('base')
    return repo
  }

  const modified = (root: string, path: string, status: Change['status'] = 'M'): Change => ({
    path: join(root, path),
    status,
    hunks: [],
  })

  test('compares the base commit with the worktree file', ({ cleanup }) => {
    const repo = repoWith({ 'src/a.ts': `export interface A { x: number }\nexport const v = 1\n` })
    cleanup(repo.cleanup)
    repo.write('src/a.ts', `export interface A { x: number; y: number }\nexport const v = 1\n`)
    const result = moduleScopeUnchangedFiles({
      root: repo.root,
      changes: [modified(repo.root, 'src/a.ts')],
      entries: [{ glob: join(repo.root, 'src/**'), tsconfig: join(repo.root, 'tsconfig.json'), typescript: PIN }],
      refs: [repo.head()],
      worktree: true,
    })
    assert.deepEqual([...result.files.keys()], [join(repo.root, 'src/a.ts')])
  })

  test('a value change is not reported', ({ cleanup }) => {
    const repo = repoWith({ 'src/a.ts': `export const v = 1\n` })
    cleanup(repo.cleanup)
    repo.write('src/a.ts', `export const v = 2\n`)
    const result = moduleScopeUnchangedFiles({
      root: repo.root,
      changes: [modified(repo.root, 'src/a.ts')],
      entries: [{ glob: join(repo.root, 'src/**'), tsconfig: join(repo.root, 'tsconfig.json'), typescript: PIN }],
      refs: [repo.head()],
      worktree: true,
    })
    assert.equal(result.files.size, 0)
  })

  test('added, deleted and renamed files, other extensions and unmatched globs are skipped', ({ cleanup }) => {
    const repo = repoWith({ 'src/a.ts': `export const v = 1\n`, 'src/b.js': `export const v = 1\n` })
    cleanup(repo.cleanup)
    repo.write('src/b.js', `export const v = 1 // c\n`)
    repo.write('other/c.ts', `export const v = 1\n`)
    const entries = [{ glob: join(repo.root, 'src/**'), tsconfig: join(repo.root, 'tsconfig.json'), typescript: PIN }]
    const result = moduleScopeUnchangedFiles({
      root: repo.root,
      changes: [
        modified(repo.root, 'src/a.ts', 'A'),
        modified(repo.root, 'src/a.ts', 'D'),
        modified(repo.root, 'src/a.ts', 'R'),
        modified(repo.root, 'src/b.js'),
        modified(repo.root, 'other/c.ts'),
      ],
      entries,
      refs: [repo.head()],
      worktree: true,
    })
    assert.equal(result.files.size, 0)
  })

  test('a file absent at the base ref is skipped', ({ cleanup }) => {
    const repo = repoWith({ 'src/a.ts': `export const v = 1\n` })
    cleanup(repo.cleanup)
    repo.write('src/new.ts', `export const v = 1\n`)
    const result = moduleScopeUnchangedFiles({
      root: repo.root,
      changes: [modified(repo.root, 'src/new.ts')],
      entries: [{ glob: join(repo.root, 'src/**'), tsconfig: join(repo.root, 'tsconfig.json'), typescript: PIN }],
      refs: [repo.head()],
      worktree: true,
    })
    assert.equal(result.files.size, 0)
  })

  test('without typescript in the project nothing is reported', ({ cleanup }) => {
    const repo = repoWith({ 'src/a.ts': `export interface A {}\n` })
    cleanup(repo.cleanup)
    rmSync(join(repo.root, 'node_modules'), { recursive: true, force: true })
    repo.write('src/a.ts', `export interface B {}\n`)
    const result = moduleScopeUnchangedFiles({
      root: repo.root,
      changes: [modified(repo.root, 'src/a.ts')],
      entries: [{ glob: join(repo.root, 'src/**'), tsconfig: join(repo.root, 'tsconfig.json'), typescript: PIN }],
      refs: [repo.head()],
      worktree: true,
    })
    assert.equal(result.files.size, 0)
  })

  test('a mismatched pin is reported once per entry as a warning and skips the file', ({ cleanup }) => {
    const repo = repoWith({ 'src/a.ts': `export interface A {}\n`, 'src/b.ts': `export interface A {}\n` })
    cleanup(repo.cleanup)
    repo.write('src/a.ts', `export interface B {}\n`)
    repo.write('src/b.ts', `export interface B {}\n`)
    const result = moduleScopeUnchangedFiles({
      root: repo.root,
      changes: [modified(repo.root, 'src/a.ts'), modified(repo.root, 'src/b.ts')],
      entries: [{ glob: join(repo.root, 'src/**'), tsconfig: join(repo.root, 'tsconfig.json'), typescript: '0.0.1' }],
      refs: [repo.head()],
      worktree: true,
    })
    assert.equal(result.files.size, 0)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0]!, /emitCheck skipped for .*src\/\*\*: resolved typescript .*, pinned 0\.0\.1/)
  })

  test('an entry list of one unused project is harmless', () => {
    const p = project()
    try {
      const result = moduleScopeUnchangedFiles({
        root: p.dir,
        changes: [],
        entries: [entryFor(p)],
        refs: [],
        worktree: true,
      })
      assert.equal(result.files.size, 0)
    } finally {
      p.cleanup()
    }
  })
})
