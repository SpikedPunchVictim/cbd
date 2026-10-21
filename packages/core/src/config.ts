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
 * **`granularity` is accepted but only `"test"` is supported.** It is in the design
 * document and in every example config; a v1 that rejected it would fail on a file
 * the documentation tells a reader to write. `"group"` is a real design lever, not
 * a typo, so it is refused with a message that says it is not built yet rather than
 * silently ignored.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
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
  /** Only `"test"` is implemented; the key is accepted for the documented config. */
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
  return { config: { ...parseConfig(parsed, root), configFile: realpathSync(path) }, path }
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
export function parseConfig(raw: unknown, root: string): CbdConfig {
  const path = configPath(root)
  // One canonical root for the globs and the returned config. Building the globs
  // against a symlinked spelling while the factory resolves changed paths against
  // the realpath made `include` reject every change — a silent zero-test answer.
  const canonical = realpathSync(resolve(root))
  const file = asObject(raw, path)
  checkKnownKeys(file, path)
  checkScalars(file, path)
  const select = selectFrom(file, canonical, path)
  return {
    root: canonical,
    ...(file.stateDir === undefined ? {} : { stateDir: file.stateDir as string }),
    ...(file.mapsDir === undefined ? {} : { mapsDir: file.mapsDir as string }),
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
  if (file.granularity !== undefined && file.granularity !== 'test') {
    throw new Error(
      `cbd: ${path} "granularity" is only "test" in v1; "${String(file.granularity)}" is a B2 lever and is not built yet`,
    )
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

function selectFrom(file: Record<string, unknown>, root: string, path: string): SelectConfig {
  const include = strings(file.include, 'include', path)
  const exclude = strings(file.exclude, 'exclude', path)
  const alwaysAll = strings(file.alwaysAll, 'alwaysAll', path)
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
  if (unknownPolicyOverrides !== undefined) select.unknownPolicyFor = unknownPolicyOverrides
  if (testFiles !== undefined) select.testFiles = absoluteGlobs(root, testFiles)
  if (testFilePolicy !== undefined) select.testFilePolicy = testFilePolicy
  if (unknownPolicy !== undefined) select.unknownPolicy = unknownPolicy
  if (betweenPolicy !== undefined) select.betweenPolicy = betweenPolicy
  if (file.maxAgeCommits !== undefined) select.maxAgeCommits = file.maxAgeCommits as number
  if (file.strict !== undefined) select.strict = file.strict as boolean
  return select
}
