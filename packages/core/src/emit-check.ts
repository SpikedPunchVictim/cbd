/**
 * `emitCheck`: has a TypeScript file's module scope changed at runtime?
 *
 * A TypeScript commit mostly edits things the compiler erases: imports used only as
 * types, interfaces, aliases, annotations. The module-scope rule cannot tell, and on
 * a one-process suite it selects every test that loaded the file. This module asks
 * the project's own compiler instead of guessing.
 *
 * CBD reimplements no TypeScript semantics. The `typescript` package is resolved from
 * the tsconfig's directory (it is the consumer's, not a CBD dependency) and the
 * consumer's tsconfig drives the emit, because options such as `verbatimModuleSyntax`
 * and `emitDecoratorMetadata` change what survives. Both versions of the file are
 * transpiled, parsed as JavaScript, every function body is replaced by an empty
 * block (what remains is what runs when the module is evaluated), and the printed
 * skeletons are compared.
 *
 * Source maps are always off and comments are removed for the comparison only:
 * neither runs. Anything uncertain answers "changed", which keeps today's rules.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative } from 'node:path'
import type { Change } from './changes.js'
import { matchesAnyGlob } from './glob.js'
import type { EmitCheckEntry } from './select.js'

/** The slice of the TypeScript compiler API used; `any` because `typescript` is the consumer's. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Ts = any

/** Extensions the check applies to. A declaration file emits nothing and is excluded. */
const TS_SOURCE = /\.(?:[cm]?ts|tsx)$/i
const DECLARATION = /\.d\.[cm]?ts$/i

export interface ModuleScopeVerdict {
  /** True only when the module scope is proven identical in every compared version. */
  unchanged: boolean
  /** Why the check could not prove it, for tests and diagnostics. */
  why?: string
}

interface Project {
  ts: Ts
  options: object
}

const projects = new Map<string, Project | string>()

/** Resolve the project's TypeScript and tsconfig; a string is the reason it failed. */
function loadProject(tsconfig: string): Project | string {
  const cached = projects.get(tsconfig)
  if (cached !== undefined) return cached
  const loaded = load(tsconfig)
  projects.set(tsconfig, loaded)
  return loaded
}

function load(tsconfig: string): Project | string {
  const dir = dirname(tsconfig)
  let ts: Ts
  try {
    ts = createRequire(`${dir}/`)('typescript')
  } catch (error) {
    return `typescript is not resolvable from ${dir}: ${String(error)}`
  }
  // TypeScript 7 ships no JavaScript compiler API.
  if (
    ts === null ||
    typeof ts.transpileModule !== 'function' ||
    typeof ts.createSourceFile !== 'function' ||
    typeof ts.createPrinter !== 'function'
  ) {
    return `the typescript installed for ${dir} has no JavaScript transpile API`
  }
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile)
  if (read.error !== undefined) return `cannot read ${tsconfig}`
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dir, undefined, tsconfig)
  return {
    ts,
    options: {
      ...parsed.options,
      sourceMap: false,
      inlineSourceMap: false,
      inlineSources: false,
      removeComments: true,
    },
  }
}

function skeleton(project: Project, text: string, fileName: string): string {
  const { ts } = project
  const out = ts.transpileModule(text, {
    compilerOptions: project.options,
    fileName,
    reportDiagnostics: true,
  })
  const failed = (out.diagnostics ?? []).some((d: { category: number }) => d.category === ts.DiagnosticCategory.Error)
  if (failed) throw new Error('transpile reported an error')
  const kind = /x$/i.test(fileName) ? ts.ScriptKind.JSX : ts.ScriptKind.JS
  const js: string = out.outputText
  const source = ts.createSourceFile('emit.js', js, ts.ScriptTarget.Latest, true, kind)
  if ((source.parseDiagnostics ?? []).length > 0) throw new Error('emitted JavaScript did not parse')

  // Outermost function-like bodies only: nothing inside them runs at evaluation.
  const bodies: Array<[number, number]> = []
  const visit = (node: Ts): void => {
    if (ts.isFunctionLike(node) && node.body !== undefined) {
      bodies.push([node.body.getStart(source), node.body.end])
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  let hollow = js
  for (const [start, end] of bodies.sort((a, b) => b[0] - a[0])) {
    hollow = `${hollow.slice(0, start)}{}${hollow.slice(end)}`
  }
  const printer = ts.createPrinter({ removeComments: true })
  return printer.printFile(ts.createSourceFile('hollow.js', hollow, ts.ScriptTarget.Latest, true, kind))
}

/**
 * Is `head`'s module scope identical to every one of `bases` after the project's
 * own TypeScript compiles them? Any failure answers "changed" with the reason.
 */
export function compareModuleScope(
  tsconfig: string,
  fileName: string,
  bases: readonly string[],
  head: string,
): ModuleScopeVerdict {
  const project = loadProject(tsconfig)
  if (typeof project === 'string') return { unchanged: false, why: project }
  try {
    const wanted = skeleton(project, head, fileName)
    for (const base of bases) {
      if (skeleton(project, base, fileName) !== wanted) {
        return { unchanged: false, why: 'module scope differs' }
      }
    }
    return { unchanged: true }
  } catch (error) {
    return { unchanged: false, why: `transpile failed: ${String(error)}` }
  }
}

export interface EmitCheckInput {
  /** The repository root git runs in. */
  root: string
  /** Absolute-path changes, as `select` receives them. */
  changes: readonly Change[]
  entries: readonly EmitCheckEntry[]
  /** Refs whose version of each file must match the current one (the diff's bases). */
  refs: readonly string[]
  /** Compare against the worktree file; otherwise against HEAD. */
  worktree: boolean
}

function gitShow(root: string, ref: string, path: string): string | undefined {
  const rel = relative(root, path).split('\\').join('/')
  try {
    return execFileSync('git', ['show', `${ref}:./${rel}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
}

/**
 * The modified TypeScript files, under an opted-in glob, whose module scope the
 * project's compiler says did not change between every base ref and the current
 * version. Added, deleted, renamed and non-TypeScript files are never reported.
 */
export function moduleScopeUnchangedFiles(input: EmitCheckInput): { files: Set<string> } {
  const files = new Set<string>()
  if (input.entries.length === 0 || input.refs.length === 0) return { files }
  for (const change of input.changes) {
    if (change.status !== 'M') continue
    if (!TS_SOURCE.test(change.path) || DECLARATION.test(change.path)) continue
    const entry = input.entries.find((candidate) => matchesAnyGlob(change.path, [candidate.glob]) !== null)
    if (entry === undefined) continue

    let head: string | undefined
    if (input.worktree) {
      try {
        head = readFileSync(change.path, 'utf8')
      } catch {
        head = undefined
      }
    } else {
      head = gitShow(input.root, 'HEAD', change.path)
    }
    if (head === undefined) continue
    const bases = input.refs.map((ref) => gitShow(input.root, ref, change.path))
    if (bases.some((base) => base === undefined)) continue

    const verdict = compareModuleScope(entry.tsconfig, change.path, bases as string[], head)
    if (verdict.unchanged) files.add(change.path)
  }
  return { files }
}
