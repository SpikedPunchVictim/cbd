/**
 * Does V8 report zero-count functions inside a script that has coverage?
 *
 * This decides how `name@ordinal` keys can be assigned. If a script's payload
 * contains only the functions that ran, an ordinal computed from "the functions
 * I can see" would differ between windows: a window calling only the second
 * `parse` would have to call it `parse@0`, while a window calling both would
 * call it `parse@0` and `parse@1`. Keys would then be unstable, and the map
 * would silently mismatch on every selection.
 *
 * If zero-count siblings ARE present, ordinal can be computed over the file's
 * whole function list and stays put.
 */
import inspector from 'node:inspector'
import fs from 'node:fs'

const dir = new URL('./ordinal-corpus/', import.meta.url)
fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })

fs.writeFileSync(new URL('m.mjs', dir), [
  'export const alpha = { parse() { return 1 } }',
  'export const beta  = { parse() { return 2 } }',
  'export const gamma = { parse() { return 3 } }',
  'export function solo() { return 4 }',
  'export function neverCalled() { return 5 }',
].join('\n'))

const session = new inspector.Session()
session.connect()
const post = (m, p = {}) =>
  new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))))

await post('Profiler.enable')
await post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })

const mod = await import(new URL('m.mjs', dir).href)
mod.beta.parse() // call ONLY the middle same-named function

const { result } = await post('Profiler.takePreciseCoverage')
const script = result.find((s) => s.url.endsWith('m.mjs'))

console.log('script present in payload:', Boolean(script))
console.log('functions reported:')
for (const fn of script.functions) {
  console.log(
    `  ${JSON.stringify(fn.functionName).padEnd(16)} count=${fn.ranges[0].count}`,
  )
}

const names = script.functions.map((f) => f.functionName)
const zeroCount = script.functions.filter((f) => f.ranges[0].count === 0)
console.log()
console.log(`zero-count functions present: ${zeroCount.length}`)
console.log(`all zero-count siblings visible: ${zeroCount.some((f) => f.functionName === 'gamma')}`)
console.log(`'neverCalled' visible: ${names.includes('neverCalled')}`)

await post('Profiler.stopPreciseCoverage')
session.disconnect()
