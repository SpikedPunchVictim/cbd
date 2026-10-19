/**
 * `@spikedpunch/cbd-node-test` — the `node:test` integration point is the preload.
 *
 * ```sh
 * node --import @spikedpunch/cbd-node-test/register --test
 * ```
 *
 * With `CBD_SHARD` unset the preload is inert for recording, so the flag can live
 * in a committed command; `CBD_SELECTION` narrows the run, exactly as the other
 * adapters do.
 *
 * This module re-exports the pure pieces so they can be tested and reasoned about
 * without a runner; it performs no side effects. The preload itself is
 * `@spikedpunch/cbd-node-test/register`.
 */
export {
  existingPattern,
  fileOf,
  selectionPattern,
  shardPathFor,
  statusOf,
  titleOf,
  type NodeTestContextLike,
} from './identity.js'
export { NODE_TEST_SELF_ROOTS, withSelfRoot } from './self.js'
export { installNodeTest, type NodeTestHooks } from './install.js'
