/**
 * A Vitest reporter that fails a run whose selection ran nothing.
 *
 * The setup file applies a selection by skipping every unselected test, and Vitest
 * exits 0 for a run in which everything was skipped. A selection that matches no
 * test — titles the suite no longer has — would therefore pass having run nothing,
 * which reads as "these tests passed". Add this reporter to the config; it does
 * nothing unless `CBD_SELECTION` is set.
 *
 * ```ts
 * test: { reporters: ['default', '@spikedpunch/cbd-vitest/reporter'] }
 * ```
 */
interface TestCaseLike {
  result(): { state: string }
}

interface TestModuleLike {
  children: { allTests(): Iterable<TestCaseLike> }
}

export const SELECTION_RAN_NOTHING =
  'cbd: the selection named tests, but no test ran, so the run proves nothing. ' +
  'Failing the run rather than reporting a pass with nothing run.'

export default class SelectionRanSomething {
  onTestRunEnd(testModules: readonly TestModuleLike[]): void {
    if (process.env.CBD_SELECTION === undefined) return
    for (const module of testModules) {
      for (const test of module.children.allTests()) {
        const state = test.result().state
        if (state === 'passed' || state === 'failed') return
      }
    }
    process.stderr.write(`${SELECTION_RAN_NOTHING}\n`)
    process.exitCode = 1
  }
}
