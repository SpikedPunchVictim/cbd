/**
 * `@spikedpunch/cbd-jest` — the Jest integration is a config helper and an
 * environment:
 *
 * ```js
 * const { withCbd } = require('@spikedpunch/cbd-jest/config')
 * module.exports = withCbd({
 *   testEnvironment: '@spikedpunch/cbd-jest/environment',
 * })
 * ```
 *
 * With `CBD_SHARD` unset the environment is inert; `CBD_SELECTION` narrows the run
 * through `withCbd`, which sets Jest's `testNamePattern`. This module re-exports
 * the pure pieces; it has no side effects.
 */
export { shardPathFor, statusOf, titleOf, type JestTestLike } from './identity.js'
