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
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import type { Change } from './changes.js'
import { matchesAnyGlob } from './glob.js'
import { proveBindingRead, type BindingRead } from './binding-read.js'
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
  /** The compiler version that produced a proven verdict. */
  typescript?: string
  /** True when the whole project was unusable (not resolvable, wrong version), not one file. */
  skipped?: boolean
}

interface Project {
  ts: Ts
  options: object
  version: string
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
    version: String(ts.version),
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
  const hollowed = printer.printFile(ts.createSourceFile('hollow.js', hollow, ts.ScriptTarget.Latest, true, kind))
  return `${hollowed}\n${synthesizedConstructs(project, text, fileName).join('\n')}`
}

/**
 * The source text of every construct whose emit TypeScript wraps in a function it
 * synthesizes, and which runs when the module loads: enums (`(function (E) {...})(E || (E = {}))`),
 * namespaces, class static blocks (an IIFE below ES2022) and class field initializers
 * (moved into the constructor). The hollowing above empties
 * those wrappers too, because the emitted JavaScript does not say which functions the
 * source wrote. A hunk in such a construct lies outside every mapped source function, so
 * nothing else would catch it. Appending the construct's own source text, printed to drop
 * comments and layout, makes any edit inside it a difference. A const enum is included:
 * a type-checked emit inlines its members into importing files, so its declaring file's
 * emit may not change when it does. Ambient namespaces and non-const `declare enum`s emit
 * nothing and are left out.
 */
function synthesizedConstructs(project: Project, text: string, fileName: string): string[] {
  const { ts } = project
  const kind = /x$/i.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind)
  const printer = ts.createPrinter({ removeComments: true })
  const found: string[] = []
  const hasModifier = (node: Ts, modifier: number): boolean =>
    (ts.getCombinedModifierFlags(node) & modifier) !== 0
  const visit = (node: Ts): void => {
    const isConst = ts.isEnumDeclaration(node) && hasModifier(node, ts.ModifierFlags.Const)
    const ambient = hasModifier(node, ts.ModifierFlags.Ambient)
    const wanted =
      (ts.isEnumDeclaration(node) && (!ambient || isConst)) ||
      (ts.isModuleDeclaration(node) && !ambient) ||
      ts.isClassStaticBlockDeclaration(node) ||
      // A field initializer is not inside any function in the source, but below ES2022 (or
      // without useDefineForClassFields) TypeScript moves an instance one into the emitted
      // constructor, which is hollowed. Static and `accessor` fields included.
      (ts.isPropertyDeclaration(node) && node.initializer !== undefined)
    if (wanted) {
      // Outermost only: the printed text of a construct includes everything inside it.
      found.push(printer.printNode(ts.EmitHint.Unspecified, node, source))
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
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
  pinned: string,
): ModuleScopeVerdict {
  const project = loadProject(tsconfig)
  if (typeof project === 'string') return { unchanged: false, why: project, skipped: true }
  // The compiler resolved here may not be the one the tests run with; a different
  // version (or a different transpiler) can emit differently, so only an exact match counts.
  if (project.version !== pinned) {
    return {
      unchanged: false,
      why: `resolved typescript ${project.version}, pinned ${pinned}`,
      skipped: true,
    }
  }
  try {
    const wanted = skeleton(project, head, fileName)
    for (const base of bases) {
      if (skeleton(project, base, fileName) !== wanted) {
        return { unchanged: false, why: 'module scope differs' }
      }
    }
    return { unchanged: true, typescript: project.version }
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

/** `tsconfig.json`, `tsconfig.app.json`, `jsconfig.json`: a name that configures an emit wherever it sits. */
const CONFIG_NAME = /^[jt]sconfig(?:\..+)?\.json$/i

/**
 * The tsconfig and the local files it extends, absolute. `extends` that names a
 * package resolves into node_modules and cannot be part of a diff.
 */
function configChain(ts: Ts, tsconfig: string, seen = new Set<string>()): Set<string> {
  if (seen.has(tsconfig)) return seen
  seen.add(tsconfig)
  const read = ts.readConfigFile(tsconfig, ts.sys.readFile)
  const extended: unknown = read.config?.extends
  const names = typeof extended === 'string' ? [extended] : Array.isArray(extended) ? extended : []
  for (const name of names) {
    if (typeof name !== 'string' || !(name.startsWith('.') || isAbsolute(name))) continue
    const path = resolve(dirname(tsconfig), name)
    configChain(ts, path.endsWith('.json') ? path : `${path}.json`, seen)
  }
  return seen
}

/** Do all of the refs name one commit (`HEAD` and the map's hash often do)? */
function singleCommit(root: string, refs: readonly string[]): boolean {
  try {
    const commits = new Set(
      refs.map((ref) =>
        execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      ),
    )
    return commits.size === 1
  } catch {
    return false
  }
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
export function moduleScopeUnchangedFiles(input: EmitCheckInput): {
  /** Path to the compiler version that proved it. */
  files: Map<string, string>
  /** One per entry that could not run at all (wrong or missing compiler). */
  warnings: string[]
  /**
   * Modified files whose module-scope hunks only edit a side-effect-free initializer of a
   * binding that functions alone read (see `binding-read.ts`), with the compiler that proved it.
   */
  bindingReads: Map<string, BindingRead & { typescript: string }>
} {
  const files = new Map<string, string>()
  const bindingReads = new Map<string, BindingRead & { typescript: string }>()
  const warnings: string[] = []
  const warned = new Set<string>()
  if (input.entries.length === 0 || input.refs.length === 0) return { files, warnings, bindingReads }
  // Both versions of a file are compiled under the tsconfig as it is now, so a
  // tsconfig edited in the range emits the base differently from how the map's run
  // saw it, and identical module scope proves nothing. Any change to a file that
  // configures this entry's emit withdraws the entry's verdicts.
  const changedPaths = new Set(input.changes.map((change) => change.path))
  const configChanged = (entry: EmitCheckEntry): boolean => {
    const project = loadProject(entry.tsconfig)
    const chain = typeof project === 'string' ? new Set([entry.tsconfig]) : configChain(project.ts, entry.tsconfig)
    for (const path of changedPaths) {
      if (chain.has(path) || CONFIG_NAME.test(basename(path))) return true
    }
    return false
  }
  const withdrawn = new Map<EmitCheckEntry, boolean>()
  for (const change of input.changes) {
    if (change.status !== 'M') continue
    if (!TS_SOURCE.test(change.path) || DECLARATION.test(change.path)) continue
    const entry = input.entries.find((candidate) => matchesAnyGlob(change.path, [candidate.glob]) !== null)
    if (entry === undefined) continue
    if (!withdrawn.has(entry)) withdrawn.set(entry, configChanged(entry))
    if (withdrawn.get(entry) === true) {
      if (!warned.has(entry.glob)) {
        warned.add(entry.glob)
        warnings.push(`emitCheck skipped for ${entry.glob}: a tsconfig changed in this range`)
      }
      continue
    }

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

    const verdict = compareModuleScope(
      entry.tsconfig,
      change.path,
      bases as string[],
      head,
      entry.typescript,
    )
    if (verdict.unchanged) files.set(change.path, verdict.typescript!)
    else if (verdict.why === 'module scope differs') {
      // The hunks are in one version's lines and the map is in another's, so only a
      // single commit (the map's) and a change carrying both sides can be placed.
      const project = loadProject(entry.tsconfig)
      const base = bases[0]
      if (
        typeof project !== 'string' &&
        singleCommit(input.root, input.refs) &&
        base !== undefined &&
        change.newHunks !== undefined &&
        (change.insertions ?? []).length === 0 &&
        (change.newInsertions ?? []).length === 0
      ) {
        const proof = proveBindingRead(project.ts, project.options, change.path, base, head, change.hunks, change.newHunks)
        if (proof.ok) bindingReads.set(change.path, { ...proof.read, typescript: project.version })
      }
    } else if (verdict.skipped === true && !warned.has(entry.glob)) {
      warned.add(entry.glob)
      warnings.push(`emitCheck skipped for ${entry.glob}: ${verdict.why ?? 'unusable compiler'}`)
    }
  }
  return { files, warnings, bindingReads }
}
