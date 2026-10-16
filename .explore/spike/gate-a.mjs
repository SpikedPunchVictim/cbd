/**
 * Gate A: the startup floor, phi.
 *
 * The metric is S = (1-P)(1-phi)(1-r). phi is the part of a run you pay no matter how
 * little you select — framework startup, config loading, the module graph for shared
 * code. CBD chooses which tests run; it cannot make them load faster. So if phi is
 * large, no selection quality reaches the target, and that is worth knowing before B2
 * is written rather than after.
 *
 * Measure it by timing runs at several selection sizes and fitting
 *
 *     T(k) = a + b*k
 *
 * The intercept `a` is the floor, so phi = a / T(full). The slope `b` is the true
 * marginal cost per test — which is why r's effect on *time* is not the same as its
 * effect on *test count*, the assumption the whole payoff estimate rests on.
 *
 * The trick is that the small runs are nearly free, so you can afford several of them.
 * Only the single full run is expensive, and you probably already have that number.
 *
 * Runner-agnostic on purpose: `--list-cmd` prints one test path per line, in whatever
 * form your runner wants them, and `--run-cmd` is a shell command. Nothing here is CBD
 * code — this measures whether subsetting can pay *at all*, before any of the pipeline
 * exists.
 *
 * Usage:
 *   node gate-a.mjs --cwd <repo> \
 *     --list-cmd "find out/vs/platform -name '*.test.js' | sed 's|^out/||'" \
 *     --run-cmd "node test/unit/node/index.js" --run-flag --run \
 *     --full-cmd "node test/unit/node/index.js --runGlob 'vs/platform/**'" \
 *     --ks 1,10,100
 */
import { spawnSync } from 'node:child_process'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const cwd = arg('cwd', process.cwd())
const listCmd = arg('list-cmd')
const runCmd = arg('run-cmd')
const runFlag = arg('run-flag', null)
const fullCmd = arg('full-cmd', null)
const ks = arg('ks', '1,10,100').split(',').map((s) => s.trim())
const repeats = Number(arg('runs', '3'))
const timeout = Number(arg('timeout-ms', '600000'))

if (!listCmd || !runCmd) {
  console.error('need --list-cmd and --run-cmd')
  process.exit(2)
}

/** Wall time of a shell command, in seconds. Non-zero exits are expected (failures) and
 *  are not an error here — the measurement is time, not outcome. */
function time(command) {
  const started = performance.now()
  const result = spawnSync(command, {
    cwd,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    encoding: 'utf8',
  })
  const seconds = (performance.now() - started) / 1000
  return { seconds, status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const listed = spawnSync(listCmd, { cwd, shell: true, encoding: 'utf8' })
if (listed.status !== 0) {
  console.error(`--list-cmd failed:\n${listed.stderr}`)
  process.exit(2)
}
const all = listed.stdout.trim().split('\n').filter(Boolean)
if (all.length === 0) {
  console.error('--list-cmd printed no paths')
  process.exit(2)
}

// Evenly spaced rather than the first k: a prefix of a sorted list is one subtree, and
// the cost per test is not the same everywhere in a tree.
const sample = (k) =>
  k >= all.length
    ? all
    : Array.from({ length: k }, (_, i) => all[Math.floor((i * all.length) / k)])

console.log(`suite   : ${all.length} test file(s) under ${cwd}`)
console.log(`repeats : ${repeats} (1 for the full run)`)
console.log()

const points = []
for (const spec of ks) {
  const k = spec === 'all' ? all.length : Number(spec)
  const files = sample(k)
  const command = runFlag
    ? `${runCmd} ${files.map((f) => `${runFlag} '${f}'`).join(' ')}`
    : `${runCmd} ${files.map((f) => `'${f}'`).join(' ')}`

  const times = []
  // The full run is the expensive one, so it is never repeated; the small runs are
  // cheap and noisy, so they always are.
  const n = k === all.length ? 1 : repeats
  for (let i = 0; i < n; i += 1) times.push(time(command).seconds)
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]
  points.push({ k, median })
  console.log(`k=${String(k).padStart(5)}  ${median.toFixed(3)}s   (${times.map((t) => t.toFixed(2)).join(', ')})`)
}

let full = points.find((p) => p.k === all.length)?.median
if (full === undefined && fullCmd !== null) {
  full = time(fullCmd).seconds
  points.push({ k: all.length, median: full })
  console.log(`k=${String(all.length).padStart(5)}  ${full.toFixed(3)}s   (--full-cmd)`)
}

console.log()
if (full === undefined) {
  console.log('No full-suite run measured, so phi cannot be normalised. Pass --ks ...,all')
  console.log('or --full-cmd "<the full test command>".')
  process.exit(0)
}

// Least squares on T = a + b*k, over the linear region only. Beyond a quarter of the
// suite the curve bends (more modules loaded, more caches) and a straight line
// overestimates the intercept, which would flatter phi.
const linear = points.filter((p) => p.k <= all.length / 4)
console.log(`fitting over ${linear.length} point(s), k <= ${Math.round(all.length / 4)}`)
let a = 0
let b = 0
if (linear.length >= 2) {
  const n = linear.length
  const sk = linear.reduce((s, p) => s + p.k, 0)
  const st = linear.reduce((s, p) => s + p.median, 0)
  const skk = linear.reduce((s, p) => s + p.k * p.k, 0)
  const skt = linear.reduce((s, p) => s + p.k * p.median, 0)
  b = (n * skt - sk * st) / (n * skk - sk * sk)
  a = (st - b * sk) / n
} else {
  a = Math.min(...points.map((p) => p.median))
}

const phi = Math.max(a, 0) / full
console.log()
console.log(`T(full)        : ${full.toFixed(2)}s`)
console.log(`intercept a    : ${Math.max(a, 0).toFixed(3)}s`)
console.log(`slope b        : ${(b * 1000).toFixed(1)}ms per test file`)
console.log(`phi            : ${(phi * 100).toFixed(1)}%   <- the floor, and it is spent before any test runs`)
console.log()

const target = 0.6
console.log(`S_max = (1-P)(1-phi) with phi = ${(phi * 100).toFixed(1)}%:`)
for (const p of [0.1, 0.19, 0.25, 0.3]) {
  const smax = (1 - p) * (1 - phi)
  const verdict = smax >= target ? 'can reach 60%' : `cannot reach 60% (needs phi <= ${(((1 - target / (1 - p)) * 100)).toFixed(0)}%)`
  console.log(`  P(all)=${String(p).padEnd(5)}  S_max=${(smax * 100).toFixed(1)}%   ${verdict}`)
}
