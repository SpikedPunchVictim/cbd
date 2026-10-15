/**
 * Reads a shard and says whether it looks like a map worth building.
 *
 * Deliberately not part of the package: this is measurement scaffolding for the
 * spike and never ships. It exists because a shard can be *well-formed and empty*
 * — complete footer, correct header, every test recorded with no touches — which
 * is exactly what a resolver misconfiguration looks like, and it is otherwise
 * indistinguishable from a suite that genuinely touches nothing.
 *
 * Usage: node inspect-shard.mjs <shard.jsonl> [pathPrefix]
 */
import { readFileSync } from 'node:fs'

const [, , shardPath, prefix] = process.argv
if (!shardPath) {
  console.error('usage: node inspect-shard.mjs <shard.jsonl> [pathPrefix]')
  process.exit(2)
}

const lines = readFileSync(shardPath, 'utf8').trim().split('\n')
const records = lines.map((line) => JSON.parse(line))

const header = records.find((r) => r.type === 'shard')
const footer = records.find((r) => r.type === 'footer')
const buckets = records.filter((r) => r.type === 'bucket')
const tests = records.filter((r) => r.type === 'test')

console.log(`shard      : ${shardPath}`)
console.log(`commit     : ${header?.commit}`)
console.log(`complete   : ${footer ? 'yes' : 'NO — the footer is missing, the run was cut short'}`)
console.log()

const bucketOf = (name) => buckets.find((b) => b.bucket === name)
for (const name of ['load', 'teardown', 'between']) {
  const bucket = bucketOf(name)
  console.log(`@${name.padEnd(8)} : ${bucket ? bucket.touches.length : 0} touches`)
}

const byStatus = tests.reduce((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {})
console.log(
  `tests      : ${tests.length} (${Object.entries(byStatus).map(([s, n]) => `${n} ${s}`).join(', ')})`,
)

const empty = tests.filter((t) => t.touches.length === 0)
console.log(
  `empty      : ${empty.length} window(s) with no touches` +
    (empty.length > 0 ? ` — e.g. ${empty.slice(0, 3).map((t) => t.title).join(' | ')}` : ''),
)

const files = new Map()
for (const test of tests) {
  for (const [file] of test.touches) files.set(file, (files.get(file) ?? 0) + 1)
}

const inScope = prefix ? [...files.keys()].filter((f) => f.startsWith(prefix)) : [...files.keys()]
console.log()
console.log(`distinct files reached : ${files.size}`)
if (prefix) {
  console.log(`  under ${prefix}`)
  console.log(`                       : ${inScope.length}`)
  console.log(`  outside it           : ${files.size - inScope.length}`)
}

const totalTouches = tests.reduce((n, t) => n + t.touches.length, 0)
console.log(`total touches          : ${totalTouches}`)
console.log(
  `mean per window        : ${tests.length === 0 ? 0 : (totalTouches / tests.length).toFixed(1)}`,
)
console.log()

console.log('most-reached files:')
for (const [file, count] of [...files.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)) {
  console.log(`  ${String(count).padStart(5)}  ${file}`)
}
