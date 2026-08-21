import { defineConfig } from 'vitest/config'
import { uncollectedSuites } from './tests/platformCoverage.ts'

export default defineConfig({
  test: {
    // A running loop keeps whole checkouts of this repository under
    // orchestration/worktrees, tests included. Without excluding them the suite collects
    // its own copies out of every task in flight and fails on their unfinished state —
    // which is what happened the first time the core improved itself.
    // A suite another platform cannot attempt is left uncollected rather than collected
    // and reported as a skip, which reads as a test somebody disabled. What it is and why
    // it did not run is stated by globalSetup instead, so leaving it out stays visible.
    // Both sides read tests/platformCoverage.ts, so neither can drift from the other.
    exclude: [
      '**/node_modules/**', '**/dist/**', 'orchestration/worktrees/**',
      ...uncollectedSuites(),
    ],
    globalSetup: ['tests/globalSetup.ts'],
    // Fork IPC times out while the git-heavy suites run on Windows under Node 24;
    // worker threads use the same isolation without that process-channel failure.
    pool: process.platform === 'win32' ? 'threads' : 'forks',
    // The merge and loop suites drive real git repositories, and each git process on
    // Windows costs a large fraction of a second — a single scenario strings ten of
    // them together, which is what the default 5s budget was measured against. Hooks
    // drive the same git-heavy setup as the tests they precede.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
