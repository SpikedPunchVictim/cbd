/**
 * Guards amendment 1's premise.
 *
 * The path-projection work in A2 only matters because the no-maps build cannot
 * be joined back to `src/` by a source map. If a future edit to a tsconfig
 * quietly turns maps on for both builds, the projection tests would still pass
 * while testing nothing. So assert the difference structurally rather than
 * trusting the config.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function inspect(build) {
  const dir = join(root, build)
  const files = walk(dir)
  const js = files.filter((f) => f.endsWith('.js'))
  const maps = files.filter((f) => f.endsWith('.map'))
  const withComment = js.filter((f) => readFileSync(f, 'utf8').includes('sourceMappingURL'))
  return { build, js: js.length, maps: maps.length, withComment: withComment.length }
}

const maps = inspect('out-maps')
const nomaps = inspect('out-nomaps')

console.log('build        js files   .map files   js with sourceMappingURL')
for (const r of [maps, nomaps]) {
  console.log(`  ${r.build.padEnd(12)} ${String(r.js).padStart(4)} ${String(r.maps).padStart(11)} ${String(r.withComment).padStart(18)}`)
}

const problems = []
if (maps.maps === 0) problems.push('out-maps has no .map files — the mapped path is not being exercised')
if (maps.withComment !== maps.js) problems.push('out-maps: not every .js carries a sourceMappingURL')
if (nomaps.maps !== 0) problems.push('out-nomaps has .map files — it is supposed to have none')
if (nomaps.withComment !== 0) problems.push('out-nomaps has sourceMappingURL comments — it is supposed to have none')
if (maps.js !== nomaps.js) problems.push(`builds differ in module count (${maps.js} vs ${nomaps.js})`)

if (problems.length) {
  console.error('\nFAILED:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('\nOK: out-maps is joined to src/ by source maps; out-nomaps is not, by construction.')
