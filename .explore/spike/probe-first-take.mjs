/**
 * Why is the `@load` window empty on VS Code?
 *
 * On the fixture the load window is full of module bodies. On VS Code it captures
 * nothing, and `Recorder.#bucket` does not write an empty bucket — so "captured
 * nothing" and "never captured" look identical from the shard. This separates the
 * three possibilities: the take returns nothing, the take throws, or normalize
 * drops everything.
 *
 * Run from the VS Code root:
 *   node .explore/spike/probe-first-take.mjs
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { inProcessSource, normalize } from '/Users/spikedpunchvictim/projects/cbd/packages/core/dist/src/index.js'

const VS = '/Users/spikedpunchvictim/temp/cbd-b0/vscode'

// The globals VS Code's own runner installs before loading anything. Modules that
// read them throw at import without this.
globalThis._VSCODE_PRODUCT_JSON = JSON.parse(readFileSync(`${VS}/product.json`, 'utf8'))
globalThis._VSCODE_PACKAGE_JSON = JSON.parse(readFileSync(`${VS}/package.json`, 'utf8'))
globalThis._VSCODE_FILE_ROOT = pathToFileURL(`${VS}/out`).href

const MODULES = [
  'out/vs/platform/instantiation/common/instantiationService.js',
  'out/vs/platform/instantiation/common/graph.js',
  'out/vs/platform/instantiation/common/descriptors.js',
  'out/vs/platform/instantiation/common/serviceCollection.js',
  'out/vs/platform/markers/common/markerService.js',
  'out/vs/platform/keybinding/common/keybindingResolver.js',
  'out/vs/base/common/lifecycle.js',
  'out/vs/base/common/event.js',
  'out/vs/base/common/async.js',
  'out/vs/base/common/uri.js',
]

const source = await inProcessSource()

const t0 = performance.now()
for (const module of MODULES) {
  await import(pathToFileURL(`${VS}/${module}`).href)
}
const t1 = performance.now()

let payload = null
let thrown = null
try {
  payload = source.takeSync()
} catch (error) {
  thrown = error
}
const t2 = performance.now()

console.log(`imported    : ${MODULES.length} modules in ${(t1 - t0).toFixed(0)} ms`)
if (thrown) {
  console.log(`takeSync    : THREW — ${thrown.message}`)
} else {
  const functions = payload.reduce((n, script) => n + script.functions.length, 0)
  const executed = payload.reduce(
    (n, script) => n + script.functions.filter((fn) => fn.ranges[0].count > 0).length,
    0,
  )
  console.log(`takeSync    : ${(t2 - t1).toFixed(0)} ms`)
  console.log(`  scripts   : ${payload.length}`)
  console.log(`  functions : ${functions} (${executed} with a non-zero count)`)
}

const touches = normalize(payload ?? [], source, { include: (file) => file.startsWith(`${VS}/src`) })
const t3 = performance.now()
console.log(`normalize   : ${(t3 - t2).toFixed(0)} ms → ${touches.length} touches`)
console.log()
for (const touch of touches.slice(0, 10)) {
  console.log(`  ${touch.file.replace(`${VS}/`, '')} ${touch.key} ${touch.startLine}-${touch.endLine}`)
}
