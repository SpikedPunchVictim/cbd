const { TestEnvironment } = require('jest-environment-node')

class ProbeEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context)
    console.error('ENV_CTOR', context.testPath)
  }
  async setup() {
    await super.setup()
    console.error('ENV_SETUP', this.context && this.context.testPath,
      'hasTest', typeof this.global.test, 'hasIt', typeof this.global.it, 'hasDescribe', typeof this.global.describe)
  }
  async teardown() {
    console.error('ENV_TEARDOWN', this.context && this.context.testPath)
    await super.teardown()
  }
  async handleTestEvent(event, state) {
    const t = event.test
    console.error('EVENT', event.name, 'testPath', state && state.testPath,
      'keys', t ? Object.keys(t).join(',') : '-', 'name', t && t.name, 'mode', t && t.mode,
      'testErrors', event.testErrors && event.testErrors.length)
    if (event.name === 'test_start' && t) {
      const path = []
      for (let p = t.parent; p; p = p.parent) path.unshift(p.name)
      console.error('PATH', path.join(' > '), 'file', t.file, 'testPath', t.testPath)
    }
  }
}
module.exports = ProbeEnvironment
