import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['fixture/tests/e2e/*.spec.mjs'],
    // The built setup file, inert unless CBD_SHARD is set.
    setupFiles: [fileURLToPath(new URL('../dist/src/setup.js', import.meta.url))],
    pool: 'threads',
  },
})
