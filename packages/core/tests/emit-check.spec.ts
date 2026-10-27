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
import { changesSince, type Change } from '../src/changes.js'
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

  test('adding an enum member is a change', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const base = `export enum E { A = 'a' }\n`
    const head = `export enum E { A = 'a', B = 'b' }\n`
    assert.equal(verdict(p, base, head).unchanged, false)
  })

  test('changing an enum value is a change', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    assert.equal(verdict(p, `export enum E { A = 1 }\n`, `export enum E { A = 2 }\n`).unchanged, false)
  })

  test('changing a namespace const is a change', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const base = `export namespace N { export const x = 1 }\n`
    const head = `export namespace N { export const x = 2 }\n`
    assert.equal(verdict(p, base, head).unchanged, false)
  })

  test('changing a static block is a change, lowered (es2020) or kept (es2022)', ({ cleanup }) => {
    const base = `export class C { static v = 0; static { C.v = 1 } }\n`
    const head = `export class C { static v = 0; static { C.v = 2 } }\n`
    for (const target of ['es2020', 'es2022']) {
      const p = project({ compilerOptions: { target } })
      cleanup(p.cleanup)
      assert.equal(verdict(p, base, head).unchanged, false, target)
    }
  })

  test('changing a const enum value is a change', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    assert.equal(verdict(p, `export const enum E { A = 1 }\n`, `export const enum E { A = 2 }\n`).unchanged, false)
    assert.equal(
      verdict(p, `export declare const enum E { A = 1 }\n`, `export declare const enum E { A = 2 }\n`).unchanged,
      false,
    )
  })

  test('erased edits beside an enum stay unchanged', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const base = `import type { T } from './t.js'\nexport interface I { a: number }\nexport enum E { A = 1 }\n`
    const head = `import type { T } from './t.js'\nimport type { U } from './u.js'\nexport interface I { a: number; b: string }\n// note\nexport enum E { A = 1 }\n`
    assert.equal(verdict(p, base, head).unchanged, true)
  })

  test('a body edit inside a source IIFE is unchanged (the function rule covers it)', ({ cleanup }) => {
    const p = project()
    cleanup(p.cleanup)
    const base = `export let x = 0\n;(function () { x = 1 })()\n`
    const head = `export let x = 0\n;(function () { x = 2 })()\n`
    assert.equal(verdict(p, base, head).unchanged, true)
  })

  test('a class field initializer edit is a change at every target and define mode', ({ cleanup }) => {
    const cases: Array<[string, string, string]> = [
      ['instance field', `export class C { x = 1 }\n`, `export class C { x = 2 }\n`],
      [
        'instance field with explicit constructor',
        `export class C { x = 1; constructor() { go() } }\ndeclare function go(): void\n`,
        `export class C { x = 2; constructor() { go() } }\ndeclare function go(): void\n`,
      ],
      ['static field', `export class C { static x = 1 }\n`, `export class C { static x = 2 }\n`],
      ['accessor field', `export class C { accessor x = 1 }\n`, `export class C { accessor x = 2 }\n`],
      ['arrow-valued field', `export class C { f = () => 1 }\n`, `export class C { f = () => 2 }\n`],
    ]
    for (const target of ['es2020', 'es2022']) {
      for (const useDefineForClassFields of [false, true]) {
        const p = project({ compilerOptions: { target, useDefineForClassFields } })
        cleanup(p.cleanup)
        for (const [name, base, head] of cases) {
          if (name === 'accessor field' && target === 'es2020') continue
          assert.equal(verdict(p, base, head).unchanged, false, `${name} ${target} define=${useDefineForClassFields}`)
        }
      }
    }
  })

  test('parameter properties, default parameters and a field without initializer behave', ({ cleanup }) => {
    const p = project({ compilerOptions: { target: 'es2020' } })
    cleanup(p.cleanup)
    assert.equal(
      verdict(p, `export class C { constructor(public a = 1) {} }\n`, `export class C { constructor(public a = 2) {} }\n`)
        .unchanged,
      false,
      'a parameter default stays in the hollowed signature, so it already differs',
    )
    assert.equal(verdict(p, `export class C { x: number }\n`, `export class C { x: string }\n`).unchanged, true)
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

test.group('bindingReads: a module-scope edit only functions can see', () => {
  /** Commit `before`, write `after`, and ask what the real git hunks prove. */
  function proof(before: string, after: string, pin = PIN) {
    const repo = tempRepo()
    mkdirSync(join(repo.root, 'node_modules'), { recursive: true })
    symlinkSync(TYPESCRIPT, join(repo.root, 'node_modules', 'typescript'), 'dir')
    repo.write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'es2022', module: 'esnext' } }))
    repo.write('.gitignore', 'node_modules/\n')
    repo.write('src/a.ts', before)
    const head = repo.commit('base')
    repo.write('src/a.ts', after)
    const file = join(repo.root, 'src/a.ts')
    const changes = changesSince({ root: repo.root, since: head, worktree: true }).map((c) => ({
      ...c,
      path: join(repo.root, c.path),
    }))
    const result = moduleScopeUnchangedFiles({
      root: repo.root,
      changes,
      entries: [{ glob: join(repo.root, 'src/**'), tsconfig: join(repo.root, 'tsconfig.json'), typescript: pin }],
      refs: [head],
      worktree: true,
    })
    repo.cleanup()
    return { read: result.bindingReads.get(file), warnings: result.warnings, files: result.files }
  }

  const withBody = (decl: string, body: string): string => `${decl}\nexport function f() {\n${body}\n}\n`

  test('a regex const read only inside a function narrows to that reference', () => {
    const { read } = proof(
      withBody('const U = /a/', '  return U.test("x")'),
      withBody('const U = /b/', '  return U.test("x")'),
    )
    assert.deepEqual(read?.names, ['U'])
    assert.deepEqual(read?.lines, [3])
    assert.equal(read?.typescript, PIN)
  })

  test('CRLF line endings still narrow', () => {
    const text = (n: number): string => `const N = ${String(n)}\r\nexport function f() {\r\n  return N\r\n}\r\n`
    assert.deepEqual(proof(text(1), text(2)).read?.lines, [3])
  })

  test('a number const read inside two functions names both reference sites', () => {
    const text = (n: number): string =>
      `const N = ${String(n)}\nexport function f() {\n  return N\n}\nexport const g = () => N + 1\n`
    const { read } = proof(text(1), text(2))
    assert.deepEqual(read?.lines, [3, 5])
  })

  test('a template of primitives, literals, operators and an earlier pure const narrow', () => {
    const text = (k: string): string =>
      `const A = 2\nconst T = [{ k: \`x${'${A}'}${k}\`, [A + 1]: -A * 3 }, !A, "s" + 1]\nexport function f() { return T }\n`
    assert.deepEqual(proof(text('a'), text('b')).read?.names, ['T'])
  })

  const escalates = (name: string, before: string, after: string): void => {
    test(`escalates: ${name}`, () => {
      const { read } = proof(before, after)
      assert.equal(read, undefined)
    })
  }
  const fnReads = (decl: string, extra = ''): string => `${decl}\nexport function f() { return U }\n${extra}`

  escalates('an exported binding', fnReads('export const U = 1'), fnReads('export const U = 2'))
  escalates(
    'a U+2028 in a string literal before the edit',
    fnReads('const S = "a b"\nconst U = 1', 'setup()\ndeclare function setup(): void\n'),
    fnReads('const S = "a b"\nconst U = 2', 'setup()\ndeclare function setup(): void\n'),
  )
  escalates(
    'a lone carriage return before the edit',
    fnReads('const S = "a" // x\rconst U = 1'),
    fnReads('const S = "a" // x\rconst U = 2'),
  )
  escalates('export { U }', fnReads('const U = 1', 'export { U }\n'), fnReads('const U = 2', 'export { U }\n'))
  escalates('export default U', fnReads('const U = 1', 'export default U\n'), fnReads('const U = 2', 'export default U\n'))
  escalates(
    'a re-export under another name',
    fnReads('const U = 1', 'export { U as V }\n'),
    fnReads('const U = 2', 'export { U as V }\n'),
  )
  escalates('a read at module scope', fnReads('const U = 1', 'console.log(U)\n'), fnReads('const U = 2', 'console.log(U)\n'))
  escalates(
    'a read in a class field initializer',
    fnReads('const U = 1', 'export class C { x = U }\n'),
    fnReads('const U = 2', 'export class C { x = U }\n'),
  )
  escalates(
    'a read in a static block',
    fnReads('const U = 1', 'export class C { static { console.log(U) } }\n'),
    fnReads('const U = 2', 'export class C { static { console.log(U) } }\n'),
  )
  escalates(
    'a read in a default parameter value',
    fnReads('const U = 1', 'export function g(a = U) { return a }\n'),
    fnReads('const U = 2', 'export function g(a = U) { return a }\n'),
  )
  escalates(
    'a read in a computed key of a module-level class',
    fnReads('const U = "k"', 'export class C { [U]() {} }\n'),
    fnReads('const U = "j"', 'export class C { [U]() {} }\n'),
  )
  escalates('a call initializer', fnReads('const U = compute()', 'declare function compute(): number\n'), fnReads('const U = compute(1)', 'declare function compute(): number\n'))
  escalates('a new Map() initializer', fnReads('const U = new Map()'), fnReads('const U = new Map([])'))
  escalates('a member access initializer', fnReads('const O = { b: 1 }\nconst U = O.b'), fnReads('const O = { b: 1 }\nconst U = O.b + 1'))
  escalates('a tagged template initializer', fnReads('const U = String.raw`a`'), fnReads('const U = String.raw`b`'))
  escalates('a function expression initializer', fnReads('const U = () => 1'), fnReads('const U = () => 2'))
  escalates('a template that substitutes an object', fnReads('const U = `${{}}`'), fnReads('const U = `${[]}`'))
  escalates('a spread', fnReads('const U = [...[1]]'), fnReads('const U = [...[2]]'))
  escalates('an old initializer that is pure and a new one that is not', fnReads('const U = 1'), fnReads('const U = Date.now()'))
  escalates('an old initializer that is not pure and a new one that is', fnReads('const U = Date.now()'), fnReads('const U = 1'))
  escalates(
    'a hunk that also edits other module-scope code',
    fnReads('const U = 1', 'setup()\ndeclare function setup(): void\n'),
    fnReads('const U = 2', 'setup(1)\ndeclare function setup(): void\n'),
  )
  escalates(
    'a hunk that also edits another binding that is exported',
    fnReads('const U = 1', 'export const W = 1\n'),
    fnReads('const U = 2', 'export const W = 2\n'),
  )
  escalates('another statement on the same line', 'const U = 1; const V = 1\nexport function f() { return U }\n', 'const U = 2; const V = 1\nexport function f() { return U }\n')
  escalates('a comment edit above the binding', fnReads('// a\nconst U = 1'), fnReads('// b\nconst U = 1'))
  escalates(
    'eval anywhere in the file',
    fnReads('const U = 1', 'export const e = (s: string) => eval(s)\n'),
    fnReads('const U = 2', 'export const e = (s: string) => eval(s)\n'),
  )
  escalates('a script with no import or export', 'const U = 1\nfunction f() { return U }\n', 'const U = 2\nfunction f() { return U }\n')
  escalates(
    'a let reassigned from a const that reads another let',
    fnReads('let V = 1\nconst U = V'),
    fnReads('let V = 1\nconst U = V + 1'),
  )
  escalates('a use before the declaration', 'const U = W\nconst W = 1\nexport function f() { return U }\n', 'const U = W + 1\nconst W = 1\nexport function f() { return U }\n')

  test('a shadowing parameter does not hide a real module-scope read', () => {
    const text = (n: number): string =>
      `const U = ${String(n)}\nexport function f(U: number) { return U }\nconsole.log(U)\n`
    assert.equal(proof(text(1), text(2)).read, undefined)
  })

  test('a shadowing local is not a reference: only the real reader is named', () => {
    const text = (n: number): string =>
      `const U = ${String(n)}\nexport function f(U: number) { return U }\nexport function g() {\n  { const U = 9; void U }\n  return U\n}\n`
    const { read } = proof(text(1), text(2))
    // Line 5 is g's read of the outer U; the parameter and the block-scoped U resolve elsewhere.
    assert.deepEqual(read?.lines, [5])
  })

  test('a pin the project does not match falls back with the warning', () => {
    const { read, warnings } = proof(
      withBody('const U = /a/', '  return U'),
      withBody('const U = /b/', '  return U'),
      '0.0.1',
    )
    assert.equal(read, undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /emitCheck skipped for .*: resolved typescript .*, pinned 0\.0\.1/)
  })
})
