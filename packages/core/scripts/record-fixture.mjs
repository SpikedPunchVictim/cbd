/**
 * Runs the fixture's suite under the real Recorder and writes a shard.
 *
 * This is the closest thing yet to the actual adapter: the lifecycle wiring, the
 * buckets and the shard are all production code paths, with only the plumbing
 * that connects japa's events to the Recorder living here.
 *
 * Usage: node record-fixture.mjs <out-maps|out-nomaps> <shard.jsonl>
 */
import { configure, processCLIArgs, run } from '@japa/runner'
import { globSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FileSink, Recorder, classifyStatus, inProcessSource } from '../dist/src/adapter.js'

const coreRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fixtureRoot = resolve(coreRoot, '../../fixture')
const build = process.argv[2]
const shardPath = process.argv[3]

let recorder = null

function plugin() {
  return async ({ emitter }) => {
    const source = await inProcessSource()
    recorder = new Recorder({
      source,
      sink: new FileSink(shardPath),
      commit: process.env.CBD_COMMIT ?? 'fixture-head',
      scan: {
        projection: [{ from: join(fixtureRoot, build), to: fixtureRoot }],
        include: (file) => file.startsWith(fixtureRoot),
      },
    })

    // At plugin-install time, before the test files are imported, so that a crash
    // still leaves a header behind. This does not take a window: the @load window
    // is captured at the first test's start, by which point the imports have run.
    recorder.runStart()

    emitter.on('test:start', (node) => {
      recorder.testStart(node.title.expanded, null)
    })

    emitter.on('test:end', (node) => {
      // isSkipped matters: a skipped test still emits an end, with hasError
      // false, and would otherwise be filed as a passing test with no window.
      recorder.testEnd(node.title.expanded, classifyStatus(node), node.duration)
    })
  }
}

// processCLIArgs MUST precede configure — see A0 F11. As in collect-fixture,
// the full suite is the point here.
processCLIArgs(process.argv.slice(4))
configure({
  files: () =>
    globSync(join(fixtureRoot, build, 'tests/**/*.spec.js')).map((p) => pathToFileURL(p)),
  plugins: [plugin()],
})

await run()

// After the runner settles, rather than on `runner:end`: japa does not await
// emit, so a listener there is not guaranteed to finish before the process exits.
recorder?.runEnd()
