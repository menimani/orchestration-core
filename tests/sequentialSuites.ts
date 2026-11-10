// Which test files run one at a time, after the rest of the suite has finished.
//
// Most files drive real git repositories in their own temporary directories and share
// nothing, so `vitest.config.ts` runs them on several workers at once. The files listed
// here launch long-lived processes, wait on deadlines, or time a child process's exit;
// another file creating processes beside them is enough to push one past its deadline.
// A file that proves timing-sensitive under parallel load belongs on this list, whole,
// rather than having its tests loosened. `tests/vitest-projects.test.ts` checks that
// every entry exists and that each test file lands in exactly one of the two groups.

export const SEQUENTIAL_SUITES: string[] = [
  'tests/cli-daemon.test.ts',
  'tests/run-tests.test.ts',
  'tests/windows-run-tests-cancellation.test.ts',
  'tests/windows-console.test.ts',
  'tests/runner-survival.test.ts',
  'tests/backlog.test.ts',
  'tests/lib.test.ts',
  'tests/shell.test.ts',
  'tests/wake.test.ts',
  'tests/status-lock.test.ts',
  'tests/start.test.ts',
  'tests/consumer-smoke.test.ts',
  'tests/posix-process-group.test.ts',
  'tests/test-process.test.ts',
  'tests/typecheck-config.test.ts',
]
