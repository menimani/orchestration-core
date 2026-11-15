import { expect, it } from 'vitest'
import { execShellSync } from '../src/shell.ts'

// A timed command's shell can end by a signal only where signals exist. The termination
// of a real process tree, which once lived here too, runs on every platform in
// process-tree-termination.test.ts. vitest.config.ts collects this on POSIX alone; see
// tests/platformCoverage.ts.

it('reports the signal that ended a timed command, as an untimed one does', () => {
  // The supervisor of a timed command re-raises the shell's signal on itself, and that
  // is reported as a signal only if its own stop handlers no longer turn it into an
  // exit status. Windows has no such signal to pass on.
  let failure: { status?: unknown; signal?: unknown } | undefined
  try {
    execShellSync('kill -TERM $$', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    })
  } catch (error) {
    failure = error as typeof failure
  }
  expect(failure?.status).toBeNull()
  expect(failure?.signal).toBe('SIGTERM')
})
