const { TestEnvironment } = require('jest-environment-node')
class E extends TestEnvironment {
  async handleTestEvent(event) {
    if (event.name === 'test_done') {
      const t = event.test
      console.error('DONE_DETAIL', t.name, 'status', t.status, 'errors', t.errors && t.errors.length,
        'failing', t.failing, 'mode', t.mode, 'testErrors', event.testErrors && event.testErrors.length)
    }
  }
}
module.exports = E
