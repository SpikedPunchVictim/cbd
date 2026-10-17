/**
 * Stage A0 follow-up — where does a test's *file* come from?
 *
 * `cbd-cpy` was blocked on the belief that japa exposes no source file for a
 * test, which would make `map.tests[].file` null, `testsDefinedIn()` empty, and
 * select rule 3 escalate every test-file change to `mode: all`.
 *
 * Reading the shipped build disagrees:
 *
 *   runner/build/index.js:196        executionPlanState.file = fileURLToPath(fileURL)
 *   runner/build/create_test:366     testInstance.options.meta.fileName = options.file
 *   core/build/index.js:472          emit("test:start", { ...test.options, title, isPinned })
 *
 * So `payload.meta.fileName` should be on every test:start / test:end payload,
 * set by japa itself and needing nothing from the test author. That contradicts
 * the blocker, so it gets verified at runtime instead of believed.
 *
 * Two questions, and the second is the one that decides the adapter:
 *
 *   Q1  Does payload.meta.fileName exist, and is it the *defining* file?
 *   Q2  Is it available on `test:start` — i.e. before the window opens — or only
 *       discovered later? An adapter that learns a test's file at test:end has
 *       to buffer and retrofit; one that learns it at test:start can write the
 *       map entry as the window opens.
 *
 * Deliberately does NOT assume the file arrives by one mechanism. It reads
 * meta.fileName, falls back to a stack walk, and reports which one worked, so
 * an upstream change to either shows up as a changed verdict rather than a
 * silent null.
 */
import { fileURLToPath } from 'node:url'

const state = { seen: [], verdicts: {} }

/**
 * CallSite-level file list for the current stack, skipping japa and node
 * internals. `Error.prepareStackTrace` yields CallSite objects; `.stack` then
 * *is* the array, which is the only way to get file names cheaply.
 */
function stackFiles() {
  const prev = Error.prepareStackTrace
  try {
    Error.prepareStackTrace = (_, sites) => sites
    const sites = new Error().stack
    return sites
      .map((s) => s.getFileName())
      .filter(Boolean)
      .filter((f) => !f.startsWith('node:') && !f.includes('node_modules/'))
      .map((f) => (f.startsWith('file:') ? fileURLToPath(f) : f))
  } catch {
    return []
  } finally {
    Error.prepareStackTrace = prev
  }
}

export function cbdFileProbe() {
  return async function probe({ emitter, runner }) {
    const note = (source, event, node) => {
      state.seen.push({
        source,
        event,
        title: node?.title?.expanded ?? node?.title ?? null,
        metaFileName: node?.meta?.fileName ?? null,
        metaKeys: node?.meta ? Object.keys(node.meta).sort() : null,
        stackHead: stackFiles()[0] ?? null,
      })
    }

    emitter.on('test:start', (node) => note('emitter', 'test:start', node))
    emitter.on('test:end', (node) => note('emitter', 'test:end', node))

    // japa's own reporters read exactly this field, so if it is populated there
    // is no need to reach into runner internals at all.
    emitter.on('group:start', (node) => note('emitter', 'group:start', node))

    // The other mechanism the blocker proposed: catch the test at its defining
    // call site, during file import.
    runner.onSuite((suite) => {
      suite.onTest((t) => note('import', 'suite.onTest', { title: t.title, meta: t.options?.meta }))
      suite.onGroup((g) => {
        g.tap((t) => note('import', 'group.tap', { title: t.title, meta: t.options?.meta }))
      })
    })

    state.runner = runner
  }
}

export function fileProbeReport() {
  const { seen } = state
  const line = (s) =>
    `  ${s.event.padEnd(14)} ${String(s.source).padEnd(8)} ${String(s.title ?? '-').padEnd(18)} ` +
    `fileName=${s.metaFileName ?? 'NULL'}  stack[0]=${s.stackHead ?? '-'}`

  console.log('\n========== every observation ==========')
  for (const s of seen) console.log(line(s))

  const first = (ev) => seen.find((s) => s.event === ev)
  const metaKeys = first('test:start')?.metaKeys ?? []

  console.log('\n========== verdicts ==========')
  console.log(`  Q1a meta.fileName present ........ ${seen.some((s) => s.metaFileName) ? 'YES' : 'NO'}`)
  console.log(`      meta keys on test:start ...... [${metaKeys.join(', ')}]`)
  console.log(`  Q1b present on test:start ........ ${first('test:start')?.metaFileName ? 'YES — before the window opens' : 'NO'}`)
  console.log(`  Q1c present at import time ....... ${seen.some((s) => s.source === 'import' && s.metaFileName) ? 'YES' : 'NO'}`)
  const names = new Set(seen.map((s) => s.metaFileName).filter(Boolean))
  console.log(`  Q1d distinct files seen .......... ${names.size} — ${[...names].map((n) => n.split('/').pop()).join(', ') || '(none)'}`)
  console.log(`  Q2  stack walk needed ............ ${seen.some((s) => s.metaFileName) ? 'NO — meta is sufficient' : 'YES'}`)
}
