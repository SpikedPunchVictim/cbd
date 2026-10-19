/**
 * Gate B — how often does a real change force `mode: all`, and how wide is the
 * selection when it does not?
 *
 * Two numbers, from one read-only pass over a coverage map and a commit range
 * (ADR-0004, `cbd-2ev`):
 *
 *   P(all)  the share of commits that escalate. `P >= 0.40` makes `S >= 0.60`
 *           arithmetically impossible at any `r`, so this number can end the
 *           project without writing B2.
 *
 *   r       for every changed line, `|testsForLine(map, file, line)| / |tests|`
 *           — the fraction of the suite that line would still run. Reported as
 *           p50 and p90 as well as the mean: escalation that correlates with the
 *           changes developers most want to be fast makes the mean a lie.
 *
 * **This is not a replay.** The map is the one recorded at `--commit` (the
 * repository's HEAD by default), and the range is the commits before it. Applying
 * a HEAD map to a historical diff is a deliberate approximation and its error is
 * in the safe direction for the most part: a file that did not exist at the
 * map's commit is unknown to it and escalates, which inflates P(all) rather than
 * flattering it. The exception is a function whose lines moved between the
 * commit and HEAD — that misattributes which function a line is in, and can go
 * either way. `cbd-vqc`'s replay harness is what removes the approximation.
 *
 * **`include` is a choice, and it is the one that moves the number.** A change
 * outside `include` is ignored, so the scope must be the suite's own: the
 * packages a developer would expect this suite to answer for. The default is the
 * backend tree the recorded suite exercises; `--include typescript` is the
 * pessimistic whole-repo bound. Both are reported so the difference is visible.
 *
 * Usage:
 *   node scripts/gate-b.mjs --repo /path/to/repo --shards /path/to/shard-dir
 *     [--commit HEAD] [--range 100] [--include typescript/api,typescript/libs,...]
 *     [--json out.json]
 *
 * The shard directory holds `shard.ndjson` (the test process) and
 * `shard.service.ndjson` (the service), the pair a recorded run writes.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import {
  buildMap,
  matchesAnyGlob,
  parseUnifiedDiff,
  select,
  testsForLine,
} from '../dist/src/index.js'
import { parseShard } from '../dist/src/adapter.js'

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`)
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`)
    options[key] = value
    i += 1
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.repo === undefined || options.shards === undefined) {
  throw new Error('gate-b: --repo and --shards are required')
}

// The map's keys are the paths the recorded process reported, and a recorded
// process on macOS sees `/private/tmp` where a shell may say `/tmp`. Canonicalize
// the root the same way the run did, or every file is unknown by spelling alone.
const repo = realpathSync(resolve(options.repo))
const shardDir = resolve(options.shards)
const range = Number(options.range ?? 100)
const commit = options.commit ?? 'HEAD'
/** The backend tree the recorded suite exercises. See the header. */
const DEFAULT_INCLUDE = [
  'typescript/api',
  'typescript/libs',
  'typescript/sdk',
  'typescript/stores',
  'typescript/tests/stores',
]
const includes = (options.include ?? DEFAULT_INCLUDE.join(',')).split(',').filter(Boolean)
const includePrefixes = includes.map((prefix) => resolve(repo, prefix))
/**
 * Documentation inside a package is not something the runtime loads, and a README
 * change is not a reason to run the suite. Excluding it is a config decision, not
 * a hole: `alwaysAll` still covers the manifests, and any code or data file the
 * map cannot see still escalates.
 */
/** Prefixes that are out of this suite's scope even though an include prefix covers them. */
const excludes = (options.exclude ?? '').split(',').filter(Boolean).map((prefix) => resolve(repo, prefix))
const excludedExtensions = new Set(
  (options['exclude-ext'] ?? '').split(',').filter(Boolean).map((extension) => `.${extension}`),
)
const include = (file) =>
  !excludedExtensions.has(extname(file)) &&
  !excludes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)) &&
  includePrefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`))

/**
 * The safety net from §8.3 rule 1. Deliberately the same shape FINDINGS §3
 * measured: lockfiles, package manifests, compiler and test configuration. A
 * dependency bump changes what the map cannot see, and a tsconfig change moves
 * every range in the project.
 */
const ALWAYS_ALL = [
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/package.json',
  '**/tsconfig*.json',
  '**/vitest.config.*',
  '**/jest.config.*',
  '**/.mocharc.*',
  '**/test.config.*',
]

/**
 * `select`'s defaults, unless the run names its own. Worth naming for this repo:
 * the default glob that matches anything under a tests directory calls every
 * helper and fixture a "test file", so §8.3 rule 3 answers with an empty test
 * list and rule 7 escalates — even when the map has per-test evidence for that
 * helper. The stores suites keep 16 helpers under `tests/stores/lib/`, so the
 * default over-fires. Naming the spec and test suffixes instead is the accurate
 * config for these suites.
 */
const TEST_FILES = (
  options['test-files'] ?? '**/*.spec.*,**/*.test.*,**/__tests__/**,**/tests/**'
).split(',')

// ---------------------------------------------------------------------------
// The map, and the range
// ---------------------------------------------------------------------------

const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
const mapCommit = git(['rev-parse', commit]).trim()

const readShard = (name) => {
  const path = join(shardDir, name)
  return { name, records: parseShard(readFileSync(path, 'utf8'), path) }
}
const map = buildMap([readShard('shard.ndjson'), readShard('shard.service.ndjson')], {
  commit: mapCommit,
})

const totalTests = map.tests.length
if (totalTests === 0) throw new Error('gate-b: the map has no tests')

const commits = git(['rev-list', '--no-merges', `-${String(range)}`, commit])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)

// ---------------------------------------------------------------------------
// One commit
// ---------------------------------------------------------------------------

/**
 * New-side line numbers for added files, which `Change.hunks` cannot carry: an
 * added file has no old side, and `parseUnifiedDiff` correctly records old-side
 * coordinates only. For every other status the old side is the map's coordinate
 * system and `Change.hunks` already has it.
 */
function addedLinesByFile(diff) {
  const out = new Map()
  for (const block of diff.split(/^diff --git /m).slice(1)) {
    if (!/^new file mode/m.test(block)) continue
    const named = /^\+\+\+ b\/(.+)$/m.exec(block)
    if (named === null) continue
    const lines = []
    for (const hunk of block.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      for (let line = start; line < start + count; line += 1) lines.push(line)
    }
    out.set(named[1], lines)
  }
  return out
}

const testsDefinedIn = (file) => {
  const indices = []
  map.tests.forEach((entry, index) => {
    if (entry.file === file) indices.push(index)
  })
  return indices
}

/** The changed lines of one file, in the map's coordinates (new-side for an addition). */
function changedLines(change, relativePath, added) {
  if (change.status === 'A') return added.get(relativePath) ?? []
  const lines = []
  for (const hunk of change.hunks) {
    for (let line = hunk.start; line <= hunk.end; line += 1) lines.push(line)
  }
  return lines
}

/**
 * What fraction of the suite one line selects, under the same rules `select` uses.
 * `mode: all` is the whole suite whichever line is looked at; a test file selects
 * its own tests; a known file answers per line; a file the map saw but no test
 * reaches has nothing to run.
 */
function lineFraction(selection, change) {
  if (selection.mode === 'all') return { kind: 'escalated', of: () => 1 }
  if (matchesAnyGlob(change.path, TEST_FILES) !== null) {
    const fraction = testsDefinedIn(change.path).length / totalTests
    return { kind: 'test-file', of: () => fraction }
  }
  if (map.files[change.path] !== undefined) {
    return {
      kind: 'function',
      of: (line) => testsForLine(map, change.path, line).length / totalTests,
    }
  }
  if (map.seen.includes(change.path)) return { kind: 'untested', of: () => 0 }
  // Unknown and not escalated only if a policy ignored it; the config here never
  // does, so this is the conservative answer if it ever happens.
  return { kind: 'unknown', of: () => 1 }
}

function measureCommit(sha, distance) {
  const diff = git(['show', '--format=', '--unified=0', '--find-renames', '--no-color', sha])
  const parsed = parseUnifiedDiff(diff).filter((change) => include(resolve(repo, change.path)))
  const changes = parsed
    .map((change) => ({
      ...change,
      // `select` compares against the map, whose keys are absolute paths.
      path: resolve(repo, change.path),
      ...(change.from === undefined ? {} : { from: resolve(repo, change.from) }),
    }))

  if (changes.length === 0) return null

  const selection = select(
    map,
    changes,
    {
      include,
      alwaysAll: ALWAYS_ALL,
      unknownPolicy: 'all',
      betweenPolicy: 'all',
      testFiles: TEST_FILES,
    },
    { commit: mapCommit, distance, dirty: false },
  )

  const added = addedLinesByFile(diff)
  const samples = []
  const subsetSamples = []
  const kinds = {}
  for (const [index, change] of changes.entries()) {
    const { kind, of } = lineFraction(selection, change)
    for (const line of changedLines(change, parsed[index].path, added)) {
      const fraction = of(line)
      samples.push(fraction)
      if (selection.mode === 'subset') subsetSamples.push(fraction)
      const bucket = (kinds[kind] ??= { lines: 0, sum: 0 })
      bucket.lines += 1
      bucket.sum += fraction
    }
  }

  return {
    commit: sha.slice(0, 8),
    files: changes.length,
    mode: selection.mode,
    selected: selection.tests.length / totalTests,
    why: selection.reasons.filter((reason) => reason.kind === 'all').map((reason) => reason.why),
    /** What forced it, named, for the breakdown a reader needs after the headline. */
    allReasons: selection.reasons
      .filter((reason) => reason.kind === 'all')
      .map((reason) => ({ why: reason.why, file: reason.file === undefined ? null : reason.file.replace(`${repo}/`, '') })),
    lines: samples.length,
    kinds,
    samples,
    subsetSamples,
  }
}

const measured = []
for (const [index, sha] of commits.entries()) {
  const result = measureCommit(sha, index)
  if (result !== null) measured.push(result)
}

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

const quantile = (values, q) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[rank]
}

const escalated = measured.filter((entry) => entry.mode === 'all')
const allRate = measured.length === 0 ? 0 : escalated.length / measured.length
const lineSamples = measured.flatMap((entry) => entry.samples)
const meanR = lineSamples.length === 0 ? 0 : lineSamples.reduce((a, b) => a + b, 0) / lineSamples.length
const p50 = quantile(lineSamples, 0.5)
const p90 = quantile(lineSamples, 0.9)

/**
 * The distribution over lines the selector actually answered. This is the `r` in
 * `S = (1-P)(1-r)`: an escalated commit is not a selection, it is `P`, and
 * counting its lines as `r = 1` here would charge the same escalation twice.
 */
const subsetLines = measured.flatMap((entry) => entry.subsetSamples)
const subsetMean = subsetLines.length === 0 ? 0 : subsetLines.reduce((a, b) => a + b, 0) / subsetLines.length
const subsetP50 = quantile(subsetLines, 0.5)
const subsetP90 = quantile(subsetLines, 0.9)
/** What one changed line costs, escalated commits included. `1 - this` is the saving. */
const impliedS = (1 - allRate) * (1 - subsetMean)

/** Which rule produced each line's fraction, so the mean can be read. */
const byKind = {}
for (const entry of measured) {
  for (const [kind, bucket] of Object.entries(entry.kinds)) {
    const target = (byKind[kind] ??= { lines: 0, sum: 0 })
    target.lines += bucket.lines
    target.sum += bucket.sum
  }
}
for (const bucket of Object.values(byKind)) bucket.mean = bucket.lines === 0 ? 0 : bucket.sum / bucket.lines
/** The largest mean r that still reaches S = 0.60 at this all-rate. */
const maxMeanR = allRate >= 0.4 ? 0 : 1 - 0.6 / (1 - allRate)

const stripSamples = ({ samples: _samples, subsetSamples: _subset, ...rest }) => rest

const why = {}
for (const entry of escalated) {
  const name = entry.why[0] ?? 'unknown'
  why[name] = (why[name] ?? 0) + 1
}

const report = {
  map: {
    commit: mapCommit,
    tests: totalTests,
    files: Object.keys(map.files).length,
    seen: map.seen.length,
  },
  range: {
    commits: commits.length,
    withScopedChanges: measured.length,
    include: includes,
    newest: commits[0] === undefined ? null : git(['log', '-1', '--format=%ci', commits[0]]).trim(),
    oldest: commits.at(-1) === undefined ? null : git(['log', '-1', '--format=%ci', commits.at(-1)]).trim(),
  },
  allRate: { escalated: escalated.length, measured: measured.length, p: allRate, why },
  blastRadius: {
    /** Over every changed line, with an escalated commit's lines counted at 1. */
    lines: lineSamples.length,
    mean: meanR,
    p50,
    p90,
    /** Over the lines the selector answered — the `r` in `S = (1-P)(1-r)`. */
    subset: { lines: subsetLines.length, mean: subsetMean, p50: subsetP50, p90: subsetP90 },
    byKind,
    maxMeanR,
    /** `S = (1-P)(1-r)`, the product ADR-0004 gates on. */
    S: impliedS,
    fits: measured.length > 0 && allRate < 0.4 && impliedS >= 0.6,
  },
  /**
   * A handful of commits the selector answered with a subset, and a handful it
   * escalated. The rates are the headline; these are what a reader asks for next.
   */
  examples: {
    subset: measured
      .filter((entry) => entry.mode === 'subset')
      .slice(0, 10)
      .map(stripSamples),
    all: escalated.slice(0, 10).map(stripSamples),
  },
  commits: measured.map(stripSamples),
}

console.log(`map        ${mapCommit.slice(0, 8)} · ${String(totalTests)} tests · ${String(report.map.files)} files`)
console.log(
  `range      ${String(measured.length)} of ${String(commits.length)} commits touch the scope · ${report.range.oldest} .. ${report.range.newest}`,
)
console.log(`include    ${includes.join(', ')}`)
console.log('')
console.log(`P(all)     ${escalated.length}/${measured.length} = ${(allRate * 100).toFixed(1)}%`)
console.log(`  by reason  ${Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${String(n)}`).join(' · ') || '—'}`)
console.log(
  `r (answered) ${(subsetMean * 100).toFixed(1)}% mean · ${(subsetP50 * 100).toFixed(1)}% p50 · ${(subsetP90 * 100).toFixed(1)}% p90   ${String(subsetLines.length)} lines`,
)
console.log(
  `r (all lines) ${(meanR * 100).toFixed(1)}% mean · ${(p50 * 100).toFixed(1)}% p50 · ${(p90 * 100).toFixed(1)}% p90   ${String(lineSamples.length)} lines (escalated at 1)`,
)
console.log(
  `  by kind   ${
    Object.entries(byKind)
      .sort((a, b) => b[1].lines - a[1].lines)
      .map(([kind, bucket]) => `${kind} ${String(bucket.lines)} @ ${(bucket.mean * 100).toFixed(1)}%`)
      .join(' · ') || '—'
  }`,
)
console.log(
  `  S        (1-P)(1-r) = ${(impliedS * 100).toFixed(1)}% · at this P(all), r <= ${(maxMeanR * 100).toFixed(1)}% is required`,
)
for (const entry of report.examples.subset) {
  console.log(
    `  subset     ${entry.commit} · ${String(entry.files)} files · ${String(entry.lines)} lines · runs ${(entry.selected * 100).toFixed(1)}%`,
  )
}
console.log(
  `GATE B     ${
    measured.length === 0
      ? 'no measurement: no commit in the range touches the include scope'
      : allRate >= 0.4
        ? 'FAILS: P(all) >= 40% is impossible at any r'
        : report.blastRadius.fits
          ? 'passes on these numbers'
          : `FAILS: S = ${(impliedS * 100).toFixed(1)}% < 60% (r above the ceiling for this all-rate)`
  }`,
)

if (options.json !== undefined) {
  writeFileSync(isAbsolute(options.json) ? options.json : resolve(options.json), JSON.stringify(report, null, 2))
  console.log(`json       ${resolve(options.json)}`)
}
