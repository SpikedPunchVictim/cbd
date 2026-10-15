/**
 * A collector in embryo. Runs the fixture's suite with the in-process source
 * attached, normalises each test's window, and writes the result as JSON.
 *
 * Deliberately built the way A0 showed the real adapter must be: the handlers are
 * fully synchronous, because japa does not await `emit` and any `await` here
 * would defer the take past the window boundary.
 *
 * Usage: node collect-fixture.mjs <out-maps|out-nomaps> <output.json>
 */
import { configure, processCLIArgs, run } from '@japa/runner'
import { globSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inProcessSource, normalize } from '../dist/src/index.js'

const coreRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtureRoot = resolve(coreRoot, '../../fixture')
const build = process.argv[2]
const outFile = process.argv[3]

const perTest = new Map()
const viaCounts = { 'source-map': 0, projection: 0 }
let source = null

function collector() {
  return async ({ emitter }) => {
    source = await inProcessSource()

    emitter.on('test:start', (node) => {
      // Drain the pre-test window. Synchronous, so it lands inside the boundary.
      try {
        source.takeSync()
      } catch {
        // an unreadable window is reported as empty rather than crashing the run
      }
      perTest.set(node.title.expanded, [])
    })

    emitter.on('test:end', (node) => {
      let payload
      try {
        payload = source.takeSync()
      } catch {
        return
      }
      const touches = normalize(payload, source, {
        projection: [{ from: join(fixtureRoot, build), to: fixtureRoot }],
        include: (file) => file.startsWith(fixtureRoot),
      })
      for (const touch of touches) viaCounts[touch.via] += 1
      perTest.set(
        node.title.expanded,
        touches.map((touch) => `${touch.file}::${touch.key}`).sort(),
      )
    })
  }
}

configure({
  // A callback rather than a glob string: japa resolves glob strings against
  // its cwd, which would turn an absolute path into cwd + absolute path.
  files: () =>
    globSync(join(fixtureRoot, build, 'tests/**/*.spec.js')).map((p) => pathToFileURL(p)),
  plugins: [collector()],
})
processCLIArgs(process.argv.slice(4))
await run()

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(
  outFile,
  JSON.stringify({ build, fixtureRoot, viaCounts, tests: Object.fromEntries(perTest) }, null, 2),
)
source?.close()
