import type { TestProjectInlineConfiguration } from 'vitest/config'

// Which test files run apart from the parallel group, after it has finished.
//
// Most files drive real git repositories in their own temporary directories and share
// nothing, so `vitest.config.ts` runs them on several workers at once. The files listed
// here launch long-lived processes, wait on deadlines, or time a child process's exit;
// the parallel group creating git processes beside them is enough to push one past its
// deadline. Once that group is done the host is nearly idle, so on a host with at least
// SEQUENTIAL_MIN_PROCESSORS processors up to SEQUENTIAL_WORKERS of these files run side
// by side; below that they run strictly one at a time. Files that share a machine-wide
// resource (a named lock, a port, the repository test lock, a global temporary name)
// are named in SHARED_RESOURCES and run one at a time in a group of their own, after
// the others. A file that proves timing-sensitive under parallel load belongs on this
// list, whole, rather than having its tests loosened; one that fails beside the other
// files of the list goes into SHARED_RESOURCES with what it collides on.
// `tests/vitest-projects.test.ts` checks that every entry exists, that each test file
// lands in exactly one group, and that files sharing a resource never run together.
//
// Beside each entry: what it is sensitive to. Every fixture below lives in its own
// mkdtemp directory, and the run-tests fixtures take their test lock inside their own
// fixture repository, never this checkout's.
export const SEQUENTIAL_SUITES: string[] = [
  // Deadline: spawns the CLI and real loop daemons and waits on PID-lock and startup
  // deadlines.
  'tests/cli-daemon.test.ts',
  // Deadline and timed exit: stale-lock reclaim races between real CLI processes, a
  // startup timeout, and terminating daemon and task process trees.
  'tests/cli-daemon-lifecycle.test.ts',
  // Deadline: three real test wrappers contend for a fixture repository's test lock and
  // queue within child-start and lock-wait deadlines; one test runs a nested Vitest.
  'tests/run-tests.test.ts',
  // Timed exit (Windows): the wrapper must notice its invoking PowerShell exit within a
  // fixed wait and stop Vitest or its locked waiter.
  'tests/windows-run-tests-cancellation.test.ts',
  // Timed exit (Windows): a hidden-console process tree is observed until each
  // descendant reports its console, within a process deadline.
  'tests/windows-console.test.ts',
  // Deadline: a 100 ms launch timeout against a 20 ms publication timer.
  'tests/windows-process.test.ts',
  // Deadline and timed exit: launches the real CLI daemon through the hidden-console
  // wrapper with a 60 s launcher deadline and polls for its processes to exit.
  'tests/runner-survival.test.ts',
  // Deadline: backlog-lock grace periods and cross-process contention measured on the
  // real clock.
  'tests/backlog.test.ts',
  // Deadline: four processes contend for the backlog lock over six rounds, each within a
  // 60 s round deadline.
  'tests/backlog-stress.test.ts',
  // Deadline: four child processes contend for the description-index lock within a 30 s
  // lock deadline, and status rewrites wait on real-clock intervals.
  'tests/lib.test.ts',
  // Timed exit: a 3 s command timeout must stop the command's grandchild, polled for
  // 5 s.
  'tests/shell.test.ts',
  // Deadline: a file watcher must wake within 2 s, and a 50 ms poll must time out.
  'tests/wake.test.ts',
  // Deadline: status-lock waits that time out or retry while Windows reports a lock name
  // pending deletion.
  'tests/status-lock.test.ts',
  // Deadline: replacement startup timeouts of 1 s against 0 to 50 ms readiness timers.
  'tests/restart.test.ts',
  // Deadline: git worktree creation and process-tree checks for a starting task; it
  // failed under load in merge logs.
  'tests/start.test.ts',
  // Deadline: an installed copy of the core resolves a restart and runs a loop to its
  // first poll.
  'tests/consumer-smoke.test.ts',
  // Timed exit (Linux): a detached process group must be gone within a process deadline.
  'tests/posix-process-group.test.ts',
  // Timed exit: an eval fixture must stop once its parent exits, within a process
  // deadline.
  'tests/test-process.test.ts',
  // Deadline and timed exit: a fake docker exits before reading the archive, with a
  // long-lived helper and 10 s and 30 s deadlines.
  'tests/test-linux.test.ts',
  // Deadline: two full TypeScript compiler runs inside one test's budget.
  'tests/typecheck-config.test.ts',
  // Deadline: task runners started by the loop and waited on to completion; it timed out
  // at 60 s under parallel load.
  'tests/loop-gate-fix.test.ts',
  // Deadline: the same handback runners as loop-gate-fix, across a daemon restart.
  'tests/loop-gate-fix-reserved.test.ts',
  // Deadline and timed exit: handed-back runners past the task deadline and runner
  // process trees that must be stopped.
  'tests/loop-gate-fix-runner.test.ts',
]

// Machine-wide resources that two or more files of SEQUENTIAL_SUITES share, each with
// the files that use it. No two listed files share one today.
export const SHARED_RESOURCES: Readonly<Record<string, readonly string[]>> = {}

// Below this many processors the files run strictly one at a time, as they always have
// on the four-processor CI runner.
export const SEQUENTIAL_MIN_PROCESSORS = 12
export const SEQUENTIAL_WORKERS = 3

// The projects that run SEQUENTIAL_SUITES after the parallel group (groupOrder 0).
// "sequential" takes the files that share nothing; "sequential-shared", only when some
// file shares a resource, runs those one at a time in a later group of its own.
export function sequentialProjects(
  suites: readonly string[],
  sharedResources: Readonly<Record<string, readonly string[]>>,
  processors: number,
): TestProjectInlineConfiguration[] {
  const shared = new Set(Object.values(sharedResources).flat())
  const workers = processors >= SEQUENTIAL_MIN_PROCESSORS
    ? { fileParallelism: true, maxWorkers: SEQUENTIAL_WORKERS }
    : { fileParallelism: false }
  const projects: TestProjectInlineConfiguration[] = [{
    extends: true,
    test: {
      name: 'sequential',
      include: suites.filter((suite) => !shared.has(suite)),
      ...workers,
      sequence: { groupOrder: 1 },
    },
  }]
  if (shared.size > 0) {
    projects.push({
      extends: true,
      test: {
        name: 'sequential-shared',
        include: suites.filter((suite) => shared.has(suite)),
        fileParallelism: false,
        sequence: { groupOrder: 2 },
      },
    })
  }
  return projects
}
