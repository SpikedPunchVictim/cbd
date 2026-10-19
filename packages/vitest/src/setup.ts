/**
 * The published setup entry: `setupFiles: ['@spikedpunch/cbd-vitest/setup']`.
 *
 * It imports the hooks from Vitest (the consumer's, through the peer dependency)
 * and hands them to `installVitest`. All the work and its reasoning live there.
 *
 * With `CBD_SHARD` unset this returns without touching the runner, so the line in a
 * committed config is inert for an ordinary run.
 */
import { afterAll, afterEach, beforeEach } from 'vitest'
import { installVitest, type VitestHooks } from './install.js'

await installVitest({ beforeEach, afterEach, afterAll } as unknown as VitestHooks)
