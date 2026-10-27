/**
 * `cbd.config.json` — one committed file at the repository root (CBD.md §9.3).
 *
 * **No dependency.** The file is read with `JSON.parse`; the shape is checked here
 * and documented for editors by `cbd.config.schema.json` beside this package. A
 * JSON-schema validator would be a dependency for a file CBD itself controls, and
 * the same mistake — an unknown key silently ignored — is caught by the explicit
 * key list below.
 *
 * **Globs are repository-relative and become absolute.** The map is keyed by the
 * absolute paths a recorded process reported, so every pattern is joined onto the
 * canonical root once, at load time. `include`/`exclude` are composed into the one
 * predicate `select` takes, which is also what keeps an `exclude` from being a
 * second semantics nobody tests.
 *
 * **`granularity` is a recording decision, not a selection one.** `"test"` takes a
 * window at every test boundary; `"group"` takes one per runner group, and every
 * test in the group carries the union. It travels to the recording process in
 * `CBD_GRANULARITY` (`cbd collect` sets it), so an adapter that never calls
 * `groupEnd` must not claim group support: the recorder would then flush the whole
 * run into one window.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CbdConfig } from './factory.js'
import { matchesAnyGlob } from './glob.js'
import type { AlwaysSelectEntry, SelectConfig } from './select.js'

/** The on-disk shape. Every key is optional; absent means the default. */
export interface CbdConfigFile {
  /** Editor hint, not read by CBD. */
  $schema?: string
  include?: string[]
  exclude?: string[]
  alwaysAll?: string[]
  /**
   * Tests every matching subset must include. Either a repo-relative test file or
   * `file > title`; `when` limits the trigger to changes matching those globs.
   */
  alwaysSelect?: Array<{ tests: string[]; when?: string[] }>
  /**
   * Globs naming files whose module state tests share. A change that selects one
   * test touching such a file pulls in every test that touched it.
   */
  sharedState?: string[]
  /**
   * Opt-in compile-time check. Maps globs of TypeScript files to the tsconfig whose
   * emit decides whether a change to module scope is visible at runtime. The
   * project's own `typescript` is used; absent means today's module-scope rule.
   */
  emitCheck?: Record<string, { tsconfig: string; typescript: string }>
  unknownPolicy?: 'all' | 'ignore'
  /**
   * Per-glob overrides for a file the map has never seen. First matching entry
   * wins; a known file is unaffected.
   */
  unknownPolicyFor?: Array<{ paths: string[]; policy: 'all' | 'ignore' }>
  betweenPolicy?: 'all' | 'ignore'
  testFiles?: string[]
  maxAgeCommits?: number
  strict?: boolean
  stateDir?: string
  /** Directory holding per-commit maps; absolute paths let worktrees share one set. */
  mapsDir?: string
  /**
   * When a coverage window is taken. `"test"` (default) is per test; `"group"`
   * takes once per runner group and every test in it shares the window. The
   * trade is take count against selection precision, and it is the only lever on
   * a large single-process suite's recording overhead.
   */
  granularity?: 'test' | 'group'
}

export interface LoadedConfig {
  config: CbdConfig
  path: string
}

const KEYS = new Set([
  '$schema',
  'include',
  'exclude',
  'alwaysAll',
  'alwaysSelect',
  'sharedState',
  'emitCheck',
  'unknownPolicy',
  'unknownPolicyFor',
  'betweenPolicy',
  'testFiles',
  'testFilePolicy',
  'maxAgeCommits',
  'strict',
  'stateDir',
  'mapsDir',
  'granularity',
])

export function configPath(root: string): string {
  return join(root, 'cbd.config.json')
}

/**
 * Reads the repository's config if it has one.
 *
 * A missing file is not an error — every key has a default, and a project that has
 * never configured CBD should be able to run `cbd select` and get the safe answer.
 * A malformed one is an error, because ignoring it changes the answer silently.
 */
export function loadConfig(root: string): LoadedConfig | undefined {
  return loadConfigFile(configPath(root), root)
}

/**
 * Reads a config from an explicit path — the CLI's `--config`.
 *
 * Same answers as `loadConfig`: absent is the default, malformed is an error. The
 * `root` is still the repository the config applies to; a config does not move the
 * repository, it only changes which changes and test files are considered.
 */
export function loadConfigFile(path: string, root: string): LoadedConfig | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`cbd: cannot read ${path}: ${String(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`cbd: ${path} is not valid JSON: ${String(error)}`)
  }
  return { config: { ...parseConfig(parsed, root, path), configFile: realpathSync(path) }, path }
}

function strings(raw: unknown, key: string, path: string): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    throw new Error(`cbd: ${path} "${key}" must be an array of strings`)
  }
  return raw as string[]
}

const policy = (raw: unknown, key: string, path: string): 'all' | 'ignore' | undefined => {
  if (raw === undefined) return undefined
  if (raw !== 'all' && raw !== 'ignore') {
    throw new Error(`cbd: ${path} "${key}" must be "all" or "ignore"`)
  }
  return raw
}

/** The real path of the deepest part that exists, so a symlinked spelling cannot hide an ancestor. */
function resolveExisting(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    const parent = dirname(path)
    return parent === path ? path : join(resolveExisting(parent), basename(path))
  }
}

/** A repository-relative glob becomes absolute, because the map is keyed absolutely. */
const absoluteGlobs = (root: string, globs: string[]): string[] =>
  globs.map((glob) => (isAbsolute(glob) ? glob : join(root, glob)))

/**
 * Turns the file's shape into the config `createCbd` takes.
 *
 * Exported separately from `loadConfig` so a caller that already has parsed JSON —
 * the CLI's `--config`, a test, an editor integration — uses one validator rather
 * than a second copy of these checks.
 */
export function parseConfig(raw: unknown, root: string, path: string = configPath(root)): CbdConfig {
  // One canonical root for the globs and the returned config. Building the globs
  // against a symlinked spelling while the factory resolves changed paths against
  // the realpath made `include` reject every change — a silent zero-test answer.
  const canonical = realpathSync(resolve(root))
  const file = asObject(raw, path)
  checkKnownKeys(file, path)
  checkScalars(file, path)
  const stateDir = file.stateDir
  if (typeof stateDir === 'string') {
    const resolved = resolve(canonical, stateDir)
    const rel = relative(canonical, resolved)
    // The state directory is the pool `gc` deletes from; empty or escaping the
    // root would make it a repository cleaner.
    if (
      stateDir === '' ||
      isAbsolute(stateDir) ||
      rel === '' ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel)
    ) {
      throw new Error(
        `cbd: ${path} "stateDir" must name a non-empty directory under the root, not "${stateDir}"`,
      )
    }
  }
  const mapsDir = file.mapsDir
  if (typeof mapsDir === 'string') {
    // `gc` prunes this directory's children. The root or one of its ancestors
    // holds the sources, so it can only be a mistake; a shared directory outside
    // the root (an absolute path) is the supported case.
    const resolved = resolveExisting(resolve(canonical, mapsDir))
    const rel = relative(resolved, canonical)
    if (!(rel === '..' || rel.startsWith(`..${sep}`)) && !isAbsolute(rel)) {
      throw new Error(
        `cbd: ${path} "mapsDir" must be a directory of its own, not the repository root or a parent of it: "${mapsDir}"`,
      )
    }
  }
  const select = selectFrom(file, canonical, path)
  return {
    root: canonical,
    ...(file.stateDir === undefined ? {} : { stateDir: file.stateDir as string }),
    ...(file.mapsDir === undefined ? {} : { mapsDir: file.mapsDir as string }),
    ...(file.granularity === undefined ? {} : { granularity: file.granularity as 'test' | 'group' }),
    ...(Object.keys(select).length === 0 ? {} : { select }),
  }
}

function asObject(raw: unknown, path: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`cbd: ${path} must contain a JSON object`)
  }
  return raw as Record<string, unknown>
}

/** The key list is the typo guard: a misspelled `includ` must not silently do nothing. */
function checkKnownKeys(file: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(file)) {
    if (!KEYS.has(key)) throw new Error(`cbd: ${path} has an unknown key "${key}"`)
  }
}

function checkScalars(file: Record<string, unknown>, path: string): void {
  if (file.granularity !== undefined && file.granularity !== 'test' && file.granularity !== 'group') {
    throw new Error(`cbd: ${path} "granularity" must be "test" or "group"`)
  }
  if (file.stateDir !== undefined && typeof file.stateDir !== 'string') {
    throw new Error(`cbd: ${path} "stateDir" must be a string`)
  }
  if (file.mapsDir !== undefined) {
    if (typeof file.mapsDir !== 'string' || file.mapsDir === '') {
      throw new Error(`cbd: ${path} "mapsDir" must be a non-empty string`)
    }
  }
  if (file.maxAgeCommits !== undefined) {
    if (
      typeof file.maxAgeCommits !== 'number' ||
      !Number.isInteger(file.maxAgeCommits) ||
      file.maxAgeCommits < 0
    ) {
      throw new Error(`cbd: ${path} "maxAgeCommits" must be a non-negative integer`)
    }
  }
  if (file.strict !== undefined && typeof file.strict !== 'boolean') {
    throw new Error(`cbd: ${path} "strict" must be a boolean`)
  }
}

/** `file > title` names one test; a bare path names every test the file defines. */
function parseAlwaysSelectTest(raw: string, root: string, where: string): AlwaysSelectEntry['tests'][number] {
  const separator = ' > '
  const at = raw.indexOf(separator)
  const file = (at === -1 ? raw : raw.slice(0, at)).trim()
  const title = at === -1 ? undefined : raw.slice(at + separator.length).trim()
  if (file === '') throw new Error(`cbd: ${where} has an empty test file`)
  if (title !== undefined && title === '') throw new Error(`cbd: ${where} has an empty test title`)
  const absolute = isAbsolute(file) ? file : join(root, file)
  return title === undefined ? { file: absolute } : { file: absolute, title }
}

/**
 * `alwaysSelect` — tests that cannot appear in coverage and must always run.
 *
 * Validated strictly, because dropping a malformed entry would make the list
 * silently stop protecting the very tests it exists for.
 */
function alwaysSelect(raw: unknown, root: string, path: string): AlwaysSelectEntry[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    throw new Error(`cbd: ${path} "alwaysSelect" must be an array`)
  }
  return raw.map((entry, index) => {
    const where = `alwaysSelect[${String(index)}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`cbd: ${path} ${where} must be an object with "tests" and optional "when"`)
    }
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key !== 'tests' && key !== 'when') {
        throw new Error(`cbd: ${path} ${where} has an unknown key "${key}"`)
      }
    }
    const tests = strings(record.tests, `${where}.tests`, path)
    if (tests === undefined || tests.length === 0) {
      throw new Error(`cbd: ${path} ${where}.tests must be a non-empty array of strings`)
    }
    const when = strings(record.when, `${where}.when`, path)
    if (when !== undefined && when.length === 0) {
      throw new Error(`cbd: ${path} ${where}.when must not be empty when present`)
    }
    return {
      tests: tests.map((test) => parseAlwaysSelectTest(test, root, `${where}.tests`)),
      ...(when === undefined ? {} : { when: absoluteGlobs(root, when) }),
    }
  })
}

/**
 * Per-glob overrides for an unknown file.
 *
 * First matching entry wins, so a narrow `all` can precede a broad `ignore`. Only
 * `all` and `ignore` are values: a "warn" policy would be useless to a consumer
 * that turns every warning into a full run.
 */
function unknownPolicyFor(
  raw: unknown,
  root: string,
  path: string,
): SelectConfig['unknownPolicyFor'] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    throw new Error(`cbd: ${path} "unknownPolicyFor" must be an array`)
  }
  return raw.map((entry, index) => {
    const where = `unknownPolicyFor[${String(index)}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`cbd: ${path} ${where} must be an object with "paths" and "policy"`)
    }
    const record = entry as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key !== 'paths' && key !== 'policy') {
        throw new Error(`cbd: ${path} ${where} has an unknown key "${key}"`)
      }
    }
    const paths = strings(record.paths, `${where}.paths`, path)
    if (paths === undefined || paths.length === 0) {
      throw new Error(`cbd: ${path} ${where}.paths must be a non-empty array of strings`)
    }
    if (record.policy !== 'all' && record.policy !== 'ignore') {
      throw new Error(`cbd: ${path} ${where}.policy must be "all" or "ignore"`)
    }
    return { paths: absoluteGlobs(root, paths), policy: record.policy }
  })
}

/**
 * `emitCheck`: glob -> `{ tsconfig, typescript }`, paths made absolute against the root.
 *
 * The exact compiler version is required. The check is only sound when the compiler
 * that decides "identical emit" is the one the tests run with, so a bare tsconfig
 * string is refused rather than guessed at.
 */
function emitCheck(raw: unknown, root: string, path: string): SelectConfig['emitCheck'] | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `cbd: ${path} "emitCheck" must be an object mapping globs to { "tsconfig", "typescript" }`,
    )
  }
  return Object.entries(raw as Record<string, unknown>).map(([glob, value]) => {
    const where = `"emitCheck" entry "${glob}"`
    const pin = `pin the exact typescript version the tests run with, e.g. { "tsconfig": "tsconfig.json", "typescript": "5.9.3" }`
    if (glob === '' || value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`cbd: ${path} ${where} must be an object; ${pin}`)
    }
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (key !== 'tsconfig' && key !== 'typescript') {
        throw new Error(`cbd: ${path} ${where} has an unknown key "${key}"`)
      }
    }
    const tsconfig = record.tsconfig
    if (typeof tsconfig !== 'string' || tsconfig === '') {
      throw new Error(`cbd: ${path} ${where} needs a non-empty "tsconfig" path`)
    }
    const version = record.typescript
    if (version === undefined) throw new Error(`cbd: ${path} ${where} must ${pin}`)
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      throw new Error(`cbd: ${path} ${where} "typescript" must be an exact typescript version such as "5.9.3", not a range`)
    }
    return {
      glob: isAbsolute(glob) ? glob : join(root, glob),
      tsconfig: isAbsolute(tsconfig) ? tsconfig : join(root, tsconfig),
      typescript: version,
    }
  })
}

function selectFrom(file: Record<string, unknown>, root: string, path: string): SelectConfig {
  const include = strings(file.include, 'include', path)
  const exclude = strings(file.exclude, 'exclude', path)
  // An empty list compiles to a predicate that rejects every path: a subset with
  // no tests and exit 0, rather than "no restriction".
  if (include !== undefined && include.length === 0) {
    throw new Error(`cbd: ${path} "include" must not be empty; omit it to consider every path`)
  }
  if (exclude !== undefined && exclude.length === 0) {
    throw new Error(`cbd: ${path} "exclude" must not be empty; omit it to exclude nothing`)
  }
  const alwaysAll = strings(file.alwaysAll, 'alwaysAll', path)
  const sharedState = strings(file.sharedState, 'sharedState', path)
  const emitChecks = emitCheck(file.emitCheck, root, path)
  const alwaysSelected = alwaysSelect(file.alwaysSelect, root, path)
  const unknownPolicyOverrides = unknownPolicyFor(file.unknownPolicyFor, root, path)
  const testFiles = strings(file.testFiles, 'testFiles', path)
  const testFilePolicy = file.testFilePolicy
  if (
    testFilePolicy !== undefined &&
    testFilePolicy !== 'known' &&
    testFilePolicy !== 'all'
  ) {
    throw new Error(`cbd: ${path} "testFilePolicy" must be "known" or "all"`)
  }
  const unknownPolicy = policy(file.unknownPolicy, 'unknownPolicy', path)
  const betweenPolicy = policy(file.betweenPolicy, 'betweenPolicy', path)

  // One predicate: inside include (when given) and outside exclude (when given).
  const includeGlobs = include === undefined ? null : absoluteGlobs(root, include)
  const excludeGlobs = exclude === undefined ? null : absoluteGlobs(root, exclude)
  const predicate = (changed: string): boolean => {
    if (includeGlobs !== null && matchesAnyGlob(changed, includeGlobs) === null) return false
    if (excludeGlobs !== null && matchesAnyGlob(changed, excludeGlobs) !== null) return false
    return true
  }

  const select: SelectConfig = {}
  if (include !== undefined || exclude !== undefined) select.include = predicate
  if (alwaysAll !== undefined) select.alwaysAll = absoluteGlobs(root, alwaysAll)
  if (alwaysSelected !== undefined) select.alwaysSelect = alwaysSelected
  if (sharedState !== undefined) select.sharedState = absoluteGlobs(root, sharedState)
  if (emitChecks !== undefined && emitChecks.length > 0) select.emitCheck = emitChecks
  if (unknownPolicyOverrides !== undefined) select.unknownPolicyFor = unknownPolicyOverrides
  if (testFiles !== undefined) select.testFiles = absoluteGlobs(root, testFiles)
  if (testFilePolicy !== undefined) select.testFilePolicy = testFilePolicy
  if (unknownPolicy !== undefined) select.unknownPolicy = unknownPolicy
  if (betweenPolicy !== undefined) select.betweenPolicy = betweenPolicy
  if (file.maxAgeCommits !== undefined) select.maxAgeCommits = file.maxAgeCommits as number
  if (file.strict !== undefined) select.strict = file.strict as boolean
  return select
}
