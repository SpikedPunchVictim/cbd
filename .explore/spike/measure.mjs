/**
 * CBD spike S1/S4: the three assumptions the whole per-test-delta design rests on.
 *
 *   S1a  `takePreciseCoverage` with `callCount: true` RETURNS AND RESETS counts,
 *        so each take is a per-window delta. If false, the delta design is dead.
 *   S1b  the in-process inspector's `post` completes synchronously on the main
 *        thread (which would allow a `takeSync()` from a hook nobody awaits).
 *   S4   the cost curve: ms per take, and payload bytes per take, as a function
 *        of loaded-script / function count. This is what turns the unmeasured
 *        "take() cost grows with loaded functions" risk row into a number.
 *
 * Also checks that `Debugger.scriptParsed` carries `sourceMapURL` (the Normalizer's
 * single code path for in-process and remote sources).
 *
 * Usage: node measure.mjs <N> [M] [TAKES]
 *   N = number of generated modules (each with M exported functions)
 */
import inspector from 'node:inspector'
import { performance } from 'node:perf_hooks'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const N = Number(process.argv[2] ?? 500)
const M = Number(process.argv[3] ?? 10)
const TAKES = Number(process.argv[4] ?? 100)
const CALLS_PER_TAKE = 200
const CORPUS = new URL(`./corpus-${N}/`, import.meta.url)

// ---------------------------------------------------------------- generate
function generate() {
  const dir = CORPUS
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const map = {
    version: 3, file: 'm0.mjs', sources: ['m0.ts'],
    sourcesContent: ['export function f0(a: number) { return a + 1 }'],
    names: [], mappings: '',
  }
  const inlineMap = '//# sourceMappingURL=data:application/json;base64,'
    + Buffer.from(JSON.stringify(map)).toString('base64')
  for (let i = 0; i < N; i++) {
    let src = ''
    for (let j = 0; j < M; j++) {
      src += `export function f${j}(a) { return a + ${j + 1} }\n`
    }
    src += `export default ${i}\n`
    if (i === 0) src += inlineMap + '\n'   // exercises the sourceMapURL path
    fs.writeFileSync(new URL(`m${i}.mjs`, dir), src)
  }
  return fs.readdirSync(dir).length
}

// ---------------------------------------------------------------- session
const session = new inspector.Session()
session.connect()

const post = (method, params = {}) => new Promise((resolve, reject) =>
  session.post(method, params, (err, res) => err ? reject(err) : resolve(res)))

const scripts = new Map()          // scriptId -> {url, sourceMapURL}
session.on('Debugger.scriptParsed', (e) => {
  scripts.set(e.params.scriptId, {
    url: e.params.url, sourceMapURL: e.params.sourceMapURL,
  })
})

const fileCount = generate()

await post('Profiler.enable')
await post('Debugger.enable')
await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })

// ---------------------------------------------------------------- load
const t0 = performance.now()
const mods = []
for (let i = 0; i < N; i++) {
  mods.push(await import(new URL(`m${i}.mjs`, CORPUS).href))
}
const loadMs = performance.now() - t0

const findScript = (moduleIdx) => {
  const suffix = `m${moduleIdx}.mjs`
  for (const [id, s] of scripts) if (s.url.endsWith(suffix)) return [id, s]
  return null
}

// ---------------------------------------------------------------- S1a: does take reset?
const target = findScript(1)                        // m1.mjs, loaded, not yet called
const countFor = (cov, scriptId) => {
  const s = cov.find(c => c.scriptId === scriptId)
  if (!s) return null
  return s.functions
    .flatMap(f => f.ranges)
    .reduce((acc, r) => acc + r.count, 0)
}
mods[1].f0(1)                                       // exactly one call
const [tid] = target
const covA = (await post('Profiler.takePreciseCoverage')).result
const afterCall = countFor(covA, tid)
const covB = (await post('Profiler.takePreciseCoverage')).result
const afterIdle = countFor(covB, tid)

// ---------------------------------------------------------------- S1b: sync post?
let fired = false
session.post('Profiler.takePreciseCoverage', {}, () => { fired = true })
const postIsSync = fired

// ---------------------------------------------------------------- S4: cost curve
//
// Two call patterns, because the number that decides the optimisation is which
// term dominates V8's cost:
//   "spread"  touches a wide slice of the corpus  -> cost ~ serialising many counts
//   "narrow"  touches a handful of modules       -> cost ~ scanning all loaded scripts
// A real server looks like "narrow" (thousands of loaded functions, a test touches
// few). If narrow is as expensive as spread, the cost is the scan of loaded scripts
// and filtering by URL early cannot help; if narrow is cheap, payload dominates and
// filtering pays.
async function bench(pick) {
  const takeMs = []
  let payloadBytes = 0, scriptsWithCounts = 0, fnsWithCounts = 0
  for (let i = 0; i < TAKES + 5; i++) {
    for (const fn of pick(i)) fn()
    const s = performance.now()
    const cov = (await post('Profiler.takePreciseCoverage')).result
    const dt = performance.now() - s
    if (i < 5) continue                                  // warmup
    takeMs.push(dt)
    payloadBytes = Math.max(payloadBytes, JSON.stringify(cov).length)
    scriptsWithCounts = cov.filter(c =>
      c.functions.some(f => f.ranges.some(r => r.count > 0))).length
    fnsWithCounts = cov.reduce((a, c) =>
      a + c.functions.filter(f => f.ranges.some(r => r.count > 0)).length, 0)
  }
  const sorted = [...takeMs].sort((a, b) => a - b)
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
  return {
    meanMs: +(takeMs.reduce((a, b) => a + b, 0) / takeMs.length).toFixed(3),
    p50Ms: +pct(0.5).toFixed(3),
    p95Ms: +pct(0.95).toFixed(3),
    maxMs: +sorted[sorted.length - 1].toFixed(3),
    payloadKB: Math.round(payloadBytes / 1024),
    scriptsWithCounts, fnsWithCounts,
  }
}

const spread = await bench((i) => Array.from({ length: CALLS_PER_TAKE }, (_, c) => {
  const m = mods[(c * 7 + i) % mods.length]
  return () => m[`f${c % M}`](c)
}))

const NARROW_MODULES = 8
const narrow = await bench((i) => Array.from({ length: CALLS_PER_TAKE }, (_, c) => {
  const m = mods[(i * 3 + (c % NARROW_MODULES)) % mods.length]
  return () => m[`f${c % M}`](c)
}))

const sm = findScript(0)
await post('Profiler.stopPreciseCoverage')
session.disconnect()

console.log(JSON.stringify({
  N, M, TAKES, fileCount,
  totalScriptsParsed: scripts.size,
  totalFunctions: N * M,
  loadMs: Math.round(loadMs),
  reset: { afterCall, afterIdle, resets: afterCall > 0 && (afterIdle ?? 0) === 0 },
  postIsSync,
  sourceMapURL: sm ? (sm[1].sourceMapURL ? 'present' : 'ABSENT') : 'script-not-found',
  sourceMapURLSample: sm && sm[1].sourceMapURL
    ? sm[1].sourceMapURL.slice(0, 48) + '…' : null,
  spread, narrow,
  // what a 900-test suite pays at 2 takes/test, at the "narrow" (realistic) cost
  projOverheadSec_900tests_x2: +(narrow.meanMs * 900 * 2 / 1000).toFixed(1),
}, null, 2))
