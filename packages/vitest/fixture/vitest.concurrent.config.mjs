import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// The concurrency-refusal proof: only the concurrent spec, with the production
// setup file. Kept apart from the main e2e config so the serial tests' shard count
// and titles stay the baseline.
export default defineConfig({
  test: {
    include: ['fixture/tests/concurrent/*.spec.mjs'],
    setupFiles: [fileURLToPath(new URL('../dist/src/setup.js', import.meta.url))],
    pool: 'threads',
  },
})
