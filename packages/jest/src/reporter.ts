/**
 * A Jest reporter that fails a run whose selection ran nothing.
 *
 * Jest reports the tests `testNamePattern` filtered out as pending and exits 0, so a
 * selection that matches no test — titles the suite no longer has — would pass having
 * run nothing, which reads as "these tests passed". `withCbd` adds this reporter only
 * when a selection is set.
 *
 * Standalone, with no imports: it is bundled to CommonJS for Jest to `require`.
 */
interface RunResults {
  numPassedTests: number
  numFailedTests: number
}

class SelectionRanSomething {
  #ran = true

  static readonly MESSAGE =
    'cbd: the selection named tests, but no test ran, so the run proves nothing. ' +
    'Failing the run rather than reporting a pass with nothing run.'

  onRunComplete(_contexts: unknown, results: RunResults): void {
    this.#ran = results.numPassedTests + results.numFailedTests > 0
    // Jest fails on `getLastError` without printing what it returned.
    if (!this.#ran) process.stderr.write(`${SelectionRanSomething.MESSAGE}\n`)
  }

  getLastError(): Error | undefined {
    if (this.#ran) return undefined
    return new Error(SelectionRanSomething.MESSAGE)
  }
}

export default SelectionRanSomething
