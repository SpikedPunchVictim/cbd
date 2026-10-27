/**
 * A `node:test` reporter that fails a run whose selection ran nothing.
 *
 * The register module applies a selection with the runner's name pattern, and
 * `node --test` exits 0 for a run in which no test matched. A selection naming
 * tests the suite no longer has would therefore pass having run nothing, which
 * reads as "these tests passed". The parent runner never loads the register
 * module, so the check lives in a reporter, which does run there. It does nothing
 * unless `CBD_SELECTION` is set. A custom reporter replaces the default one, so
 * keep the normal output with `spec`:
 *
 * ```sh
 * node --import @spikedpunch/cbd-node-test/register --test \
 *   --test-reporter=spec --test-reporter-destination=stdout \
 *   --test-reporter=@spikedpunch/cbd-node-test/reporter --test-reporter-destination=stderr
 * ```
 */
interface TestEventData {
  name: string
  file?: string
  skip?: unknown
  todo?: unknown
  details?: { type?: string }
}

interface TestEvent {
  type: string
  data: TestEventData
}

export const SELECTION_RAN_NOTHING =
  'cbd: the selection named tests, but no test ran, so the run proves nothing. ' +
  'Failing the run rather than reporting a pass with nothing run.'

/**
 * Whether the event is a test that ran to a verdict. Suites, skipped and todo
 * tests do not count, nor does the runner's own entry for a test file (named by
 * the file's path), which passes even when the file ran no test.
 */
function ranATest(event: TestEvent): boolean {
  if (event.type !== 'test:pass' && event.type !== 'test:fail') return false
  const { name, file, skip, todo, details } = event.data
  if (details?.type === 'suite' || skip || todo) return false
  return file === undefined || !(file === name || file.endsWith(`/${name}`) || file.endsWith(`\\${name}`))
}

export default async function* selectionRanSomething(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  let ran = false
  for await (const event of source) {
    if (ranATest(event)) ran = true
  }
  if (process.env.CBD_SELECTION !== undefined && !ran) {
    yield `${SELECTION_RAN_NOTHING}\n`
    process.exitCode = 1
  }
}
