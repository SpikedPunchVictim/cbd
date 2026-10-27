/**
 * Keeping japa from importing spec files a selection does not need.
 *
 * `applyTests` filters by title, and japa applies that filter *after* it has
 * imported every spec file, so a subset run pays the full import cost: on a suite
 * whose time is mostly module loading, the subset takes as long as the whole run.
 * The selection already says which file each test lives in, so the files can be
 * narrowed before the import instead.
 *
 * **The mechanism is japa's own `filters.files`.** The planner resolves each
 * suite's `files` (a glob, a list, or a function) to URLs and then greps them
 * against `filters.files` before anything is imported. Setting it from a plugin
 * works for every way a consumer can spell `files`, including the function form,
 * which rewriting the suites' `files` could not reach.
 *
 * **The rule is that a file leaves the run only when the selection proves it can.**
 * Loading too much costs time; loading too little is a missed test. So every doubt
 * ends in "narrow nothing" and the title filter alone applies:
 *
 *   - no file information (a v1 selection, or no selection);
 *   - any selected test with no file, or a file that is not an absolute path that
 *     exists here (a relative or relocated path cannot be trusted to name the
 *     file japa will resolve, and a filter that matches nothing is a miss);
 *   - a `filters.files` the caller already set (`--files`), which is theirs.
 *
 * **Spellings.** The planner greps `URL.pathname`, which is percent-encoded and,
 * when the project root is a symlink, may spell the directory differently from the
 * path a map recorded. Each selected file is named by its encoded pathname, and by
 * its real path and the configured `cwd`'s spelling of it, so a symlinked checkout
 * does not turn a known file into an unmatched one. Naming an extra spelling can
 * only load a file that was already going to match.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SelectionTest } from '@spikedpunch/cbd'

/** The corner of japa's normalized config this module reads and writes. */
export interface NarrowableConfig {
  cwd?: string
  filters: { files?: string[] }
}

/**
 * Narrows `config.filters.files` to the files holding `tests`.
 *
 * Returns whether it narrowed. `false` always means "japa will import everything
 * its `files` match", never "import nothing".
 */
export function narrowFiles(config: NarrowableConfig, tests: SelectionTest[] | undefined): boolean {
  if (tests === undefined || tests.length === 0) return false
  if (config.filters.files !== undefined && config.filters.files.length > 0) return false

  const files = new Set<string>()
  for (const test of tests) {
    if (test.file === null || !isAbsolute(test.file)) return false
    files.add(test.file)
  }

  const spellings = new Set<string>()
  for (const file of files) {
    const real = realpathOrUndefined(file)
    if (real === undefined) return false
    for (const spelling of [file, real, ...underCwd(config.cwd, file, real)]) {
      spellings.add(pathToFileURL(spelling).pathname)
    }
  }

  config.filters.files = [...spellings]
  return true
}

/** The same file as japa would spell it if `cwd` is a symlink to, or from, the real root. */
function underCwd(cwd: string | undefined, file: string, real: string): string[] {
  if (cwd === undefined) return []
  const realCwd = realpathOrUndefined(cwd)
  const roots = realCwd === undefined ? [cwd] : [cwd, realCwd]
  const spelled: string[] = []
  for (const from of [file, real]) {
    for (const root of roots) {
      const inside = relative(root, from)
      if (inside === '' || (inside === '..' || inside.startsWith(`..${sep}`)) || isAbsolute(inside)) continue
      for (const to of roots) spelled.push(resolve(to, inside))
    }
  }
  return spelled
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** Where the guard reports; replaceable so a test can observe it. */
export interface GuardSink {
  write(text: string): void
  fail(): void
}

const processSink: GuardSink = {
  write: (text) => void process.stderr.write(text),
  fail: () => {
    process.exitCode = 1
  },
}

/**
 * Fails the run if narrowing left it with no test to start.
 *
 * Narrowing is only safe if the spelling of every selected file matches what
 * japa resolves; a spelling that does not leaves a suite with no files, and the
 * run would end green having run nothing. A selection that chose tests must start
 * at least one, so zero starts at `runner:end` is an error that names the files.
 * (A skipped test still emits `test:start`, so it is not mistaken for none.)
 */
export function guardNarrowed(
  emitter: { on(eventName: string, listener: () => void): unknown },
  files: readonly string[],
  sink: GuardSink = processSink,
): void {
  let started = 0
  emitter.on('test:start', () => {
    started += 1
  })
  emitter.on('runner:end', () => {
    if (started > 0) return
    sink.write(
      'cbd: the selection was narrowed to these files, but no test started, so none of them ' +
        'matched a spec file japa resolved:\n' +
        files.map((file) => `  ${file}\n`).join('') +
        'Failing the run rather than reporting a pass with nothing run.\n',
    )
    sink.fail()
  })
}
