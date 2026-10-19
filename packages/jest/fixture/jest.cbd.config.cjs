const { withCbd } = require('../dist/cjs/config.cjs')

// rootDir is this fixture; the built entries are one level up.
module.exports = withCbd({
  rootDir: __dirname,
  testEnvironment: '../dist/cjs/environment.cjs',
  testMatch: ['**/tests/*.test.js'],
})
