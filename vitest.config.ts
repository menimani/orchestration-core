import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The merge and loop suites drive real git repositories, and each git process on
    // Windows costs a large fraction of a second — a single scenario strings ten of
    // them together, which is what the default 5s budget was measured against. Hooks
    // drive the same git-heavy setup as the tests they precede.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
