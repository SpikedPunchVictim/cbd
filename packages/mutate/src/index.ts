/**
 * `@spikedpunch/cbd-mutate` — generic mutation-testing selection.
 *
 * This package has no mutation engine and no framework dependency. It answers one
 * question for a driver that owns the rest: which tests can observe a mutant at a
 * source location? The answer comes from a CBD coverage map.
 *
 * ```ts
 * import { mutantTests } from '@spikedpunch/cbd'
 * ```
 *
 * `mutantTests` lives in core so every driver can use it; this package adds the
 * `cbd-mutate select` command for drivers that speak process boundaries (for
 * example Grizzly's `mutate.mjs`).
 */
export {
  mutantTests,
  type MutantPolicy,
  type MutantSelection,
  type MutantTarget,
  type MutantWhy,
} from '@spikedpunch/cbd'

export {
  formatSelection,
  main,
  parseSelectArgs,
  selectMutant,
  type CliIo,
  type SelectOptions,
} from './cli.js'
