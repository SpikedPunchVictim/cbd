/**
 * `@spikedpunch/cbd-jest` — the Jest integration is two config lines:
 *
 * ```js
 * module.exports = {
 *   testEnvironment: '@spikedpunch/cbd-jest/environment',
 *   setupFilesAfterEnv: ['@spikedpunch/cbd-jest/setup'], // only needed for selection
 * }
 * ```
 *
 * With `CBD_SHARD` unset the environment is inert; `CBD_SELECTION` narrows the run
 * through the setup file. This module re-exports the pure pieces; it has no side
 * effects.
 */
export { shardPathFor, statusOf, titleOf, type JestTestLike } from './identity.js'
