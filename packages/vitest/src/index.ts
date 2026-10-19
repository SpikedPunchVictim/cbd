/**
 * `@spikedpunch/cbd-vitest` — the Vitest integration point is the setup file.
 *
 * ```ts
 * // vitest.config.ts
 * export default defineConfig({
 *   test: { setupFiles: ['@spikedpunch/cbd-vitest/setup'] },
 * })
 * ```
 *
 * With `CBD_SHARD` unset the setup is inert, so the line can live in a committed
 * config; `CBD_SELECTION` narrows the run, exactly as the other adapters do.
 *
 * This module re-exports the pure pieces so they can be tested and reasoned about
 * without a runner; it performs no side effects.
 */
export { fileOf, shardPathFor, statusOf, titleOf, type VitestTaskLike } from './identity.js'
export { VITEST_SELF_ROOTS, withSelfRoot } from './self.js'
export { installVitest, type VitestHookContext, type VitestHooks } from './install.js'
