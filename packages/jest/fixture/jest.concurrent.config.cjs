const { withCbd } = require('../dist/cjs/config.cjs')

// The concurrency-refusal proof: only concurrent tests, with the production
// environment. Kept apart from the main e2e config so its shard count is stable.
module.exports = withCbd({
  rootDir: __dirname,
  testEnvironment: '../dist/cjs/environment.cjs',
  testMatch: ['**/tests/concurrent/*.test.js'],
})
