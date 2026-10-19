const { TestEnvironment } = require('jest-environment-node')
const { appendFileSync } = require('node:fs')
const log = (x) => appendFileSync('/tmp/jest-cov.ndjson', JSON.stringify(x) + '\n')
const dyn = new Function('s', 'return import(s)')
class E extends TestEnvironment {
  async setup() {
    await super.setup()
    this.core = await dyn('/Users/spikedpunchvictim/projects/cbd/packages/core/dist/src/adapter.js')
    this.source = await this.core.inProcessSource()
    this.source.takeSync()
  }
  async handleTestEvent(event) {
    if (event.name !== 'test_done') return
    const payload = this.source.takeSync()
    for (const s of payload) {
      if (!s.url.includes('/fixture/src/math.js')) continue
      log({ test: event.test.name, functions: s.functions.map(f => ({ name: f.functionName, start: f.ranges[0].startOffset, end: f.ranges[0].endOffset, count: f.ranges[0].count, ranges: f.ranges.length })) })
    }
  }
}
module.exports = E
