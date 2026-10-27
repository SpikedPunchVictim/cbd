import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['fixture/tests/e2e/*.spec.mjs'],
    setupFiles: [fileURLToPath(new URL('../dist/src/setup.js', import.meta.url))],
    // The built reporter, as a project adds it.
    reporters: ['default', fileURLToPath(new URL('../dist/src/reporter.js', import.meta.url))],
    pool: 'threads',
  },
})
