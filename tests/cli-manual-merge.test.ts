import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ForgeIssueNotFoundError } from '../src/adapters/forge.ts'
import { operatingSystem } from '../src/adapters/os.ts'
import { readConflictedAttempts, writeConflictedAttempts } from '../src/conflictRetry.ts'
import { readGateFixState, writeGateFixState } from '../src/gateFix.ts'
import { issueCompletionForIssue, recordIssuesForTask } from '../src/issueQueue.ts'
import { branchName, finalMessageFile, orchPaths, worktreeDir } from '../src/paths.ts'
import { readTaskState, writeStatus } from '../src/status.ts'
import type { TaskProcessTermination } from '../src/taskProcesses.ts'
import { CLI, CLI_TIMEOUT_MS, CORE_ENV, git, repoRoot } from './cliHarness.ts'
import { TestProcessRegistry } from './testProcess.ts'

const testProcesses = new TestProcessRegistry()

afterEach(async () => {
  await testProcesses.cleanup()
})

describe('manual merge', () => {
  it('keeps the cycle gate flags when a scan task completes without change', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20261112_190000_004_scan'
    git(['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    await writeStatus(paths, taskId, 'completed')
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '5\n')
    writeFileSync(join(paths.queueDir, 'cycle-complete-5'), '')
    writeFileSync(join(paths.queueDir, 'cycle-resume-5'), '')

    const result = spawnSync(process.execPath, [CLI, 'merge', taskId, '--yes'], {
      cwd: repoRoot,
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(readTaskState(paths, taskId)).toBe('no-change')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-5'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'cycle-resume-5'))).toBe(true)
  })

  it('preserves the merge failure streak for a no-change outcome', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20260814_180935_082_user-no-change'
    git(['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    writeFileSync(finalMessageFile(paths, taskId),
      'The requested behavior is already present.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    await writeStatus(paths, taskId, 'completed')
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '3\n')

    const result = spawnSync(process.execPath, [CLI, 'merge', taskId, '--yes'], {
      cwd: repoRoot,
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(0)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('3\n')
  })

  it('records durable completion for a linked no-change outcome', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20260815_074127_029_user-linked-no-change'
    const issueNumber = 218
    git(['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    writeFileSync(finalMessageFile(paths, taskId),
      'The requested behavior is already present.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    await writeStatus(paths, taskId, 'completed')
    recordIssuesForTask(paths, taskId, [issueNumber])

    let issueState: 'open' | 'closed' = 'open'
    const forge = {
      issueClosingCommitMessage: (message: string) => message,
      getIssue: async () => ({
        number: issueNumber,
        state: issueState,
        title: 'Linked task',
        body: '',
        author: { login: 'maintainer', hasWriteAccess: true },
        labels: [],
        assignees: [],
        updatedAt: '2026-08-15T00:00:00Z',
      }),
      closeIssue: async () => { issueState = 'closed' },
      removeLabel: async () => {},
    }
    vi.doMock('../src/adapters/forge.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/adapters/forge.ts')>(),
      loadForge: async () => forge,
    }))
    vi.doMock('node:child_process', async (importOriginal) => {
      const childProcess = await importOriginal<typeof import('node:child_process')>()
      return {
        ...childProcess,
        execFileSync: (...args: Parameters<typeof execFileSync>) => {
          const [file, fileArgs] = args
          if (file === 'git' && fileArgs?.join(' ') === 'rev-parse --show-toplevel') {
            return repoRoot
          }
          return childProcess.execFileSync(...args)
        },
      }
    })
    vi.resetModules()

    const previousArgv = process.argv
    const previousExitCode = process.exitCode
    const previousEnv = { ...process.env }
    try {
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, CORE_ENV)
      process.argv = [process.execPath, CLI, 'merge', taskId, '--yes']

      await import('../src/cli.ts')

      expect(process.exitCode).toBe(0)
      expect(issueState).toBe('closed')
      expect(issueCompletionForIssue(paths, issueNumber)).toEqual({
        taskId, issueNumber, outcome: 'no-change',
      })
    } finally {
      process.argv = previousArgv
      process.exitCode = previousExitCode
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, previousEnv)
      vi.doUnmock('../src/adapters/forge.ts')
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })

  it('treats a deleted linked issue as closed for a no-change outcome', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20261112_175409_043_user-deleted-issue-no-change'
    const issueNumber = 219
    git(['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    writeFileSync(finalMessageFile(paths, taskId),
      'The requested behavior is already present.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    await writeStatus(paths, taskId, 'completed')
    recordIssuesForTask(paths, taskId, [issueNumber])

    // The CLI loads a fresh forge module, so the fake throws that module's error class.
    let IssueNotFound = ForgeIssueNotFoundError
    const closeIssue = vi.fn(async () => {})
    const forge = {
      issueClosingCommitMessage: (message: string) => message,
      getIssue: async (number: number): Promise<never> => { throw new IssueNotFound(number) },
      closeIssue,
      removeLabel: async () => {},
    }
    vi.doMock('../src/adapters/forge.ts', async (importOriginal) => {
      const original = await importOriginal<typeof import('../src/adapters/forge.ts')>()
      IssueNotFound = original.ForgeIssueNotFoundError
      return { ...original, loadForge: async () => forge }
    })
    vi.doMock('node:child_process', async (importOriginal) => {
      const childProcess = await importOriginal<typeof import('node:child_process')>()
      return {
        ...childProcess,
        execFileSync: (...args: Parameters<typeof execFileSync>) => {
          const [file, fileArgs] = args
          if (file === 'git' && fileArgs?.join(' ') === 'rev-parse --show-toplevel') {
            return repoRoot
          }
          return childProcess.execFileSync(...args)
        },
      }
    })
    vi.resetModules()

    const previousArgv = process.argv
    const previousExitCode = process.exitCode
    const previousEnv = { ...process.env }
    try {
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, CORE_ENV)
      process.argv = [process.execPath, CLI, 'merge', taskId, '--yes']

      await import('../src/cli.ts')

      expect(process.exitCode).toBe(0)
      expect(closeIssue).not.toHaveBeenCalled()
      expect(readTaskState(paths, taskId)).toBe('no-change')
      expect(issueCompletionForIssue(paths, issueNumber)).toEqual({
        taskId, issueNumber, outcome: 'no-change',
      })
    } finally {
      process.argv = previousArgv
      process.exitCode = previousExitCode
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, previousEnv)
      vi.doUnmock('../src/adapters/forge.ts')
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })

  it('stops a live task process tree before installing dependencies a merge changed', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'package.json'), '{"private":true}\n')
    writeFileSync(join(repoRoot, 'package-lock.json'), '{"lockfileVersion":3}\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: add dependency manifests'])

    const paths = orchPaths(repoRoot)
    const taskId = '20261112_175409_042_user-manual-dependency-merge'
    const worktree = worktreeDir(paths, taskId)
    git(['worktree', 'add', worktree, '-b', branchName(taskId)])
    writeFileSync(
      join(worktree, 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"node_modules/new-dependency":{}}}\n',
    )
    git(['add', '-A'], worktree)
    git(['commit', '-qm', 'fix: update dependencies'], worktree)
    await writeStatus(paths, taskId, 'completed')

    // A runner `start` launched is still loading from the node_modules npm ci replaces.
    const runner = testProcesses.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore', windowsHide: true,
    })
    const runnerPid = runner.pid
    if (runnerPid === undefined) throw new Error('Runner did not publish a PID.')
    runner.unref()
    const runnerTaskId = '20261112_175400_041_user-parallel-runner'
    await writeStatus(paths, runnerTaskId, 'running', runnerPid)
    expect(operatingSystem.processTreeIsAlive(runnerPid)).toBe(true)

    const runnerAliveAtInstall: boolean[] = []
    const install = vi.fn(() => {
      runnerAliveAtInstall.push(operatingSystem.processTreeIsAlive(runnerPid))
    })
    vi.doMock('../src/merge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/merge.ts')>()
      return {
        ...actual,
        mergeTask: (...args: Parameters<typeof actual.mergeTask>) => actual.mergeTask(
          args[0], args[1], { ...args[2], orchestrationDepsRuntime: { install, packageRoot: repoRoot } },
        ),
      }
    })
    vi.doMock('node:child_process', async (importOriginal) => {
      const childProcess = await importOriginal<typeof import('node:child_process')>()
      return {
        ...childProcess,
        execFileSync: (...args: Parameters<typeof execFileSync>) => {
          const [file, fileArgs] = args
          if (file === 'git' && fileArgs?.join(' ') === 'rev-parse --show-toplevel') {
            return repoRoot
          }
          return childProcess.execFileSync(...args)
        },
      }
    })
    vi.resetModules()

    const previousArgv = process.argv
    const previousExitCode = process.exitCode
    const previousEnv = { ...process.env }
    try {
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, CORE_ENV)
      process.argv = [process.execPath, CLI, 'merge', taskId, '--yes']

      await import('../src/cli.ts')

      expect(process.exitCode).toBe(0)
      expect(install).toHaveBeenCalledOnce()
      expect(runnerAliveAtInstall).toEqual([false])
      expect(readFileSync(join(paths.statusDir, `${taskId}.json`), 'utf8')).toContain('"merged"')
    } finally {
      process.argv = previousArgv
      process.exitCode = previousExitCode
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, previousEnv)
      vi.doUnmock('../src/merge.ts')
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  })

  /**
   * Commits a lockfile change on a completed task and leaves behind the state a manual
   * merge's bookkeeping must clear: a failure streak, gate fix state, and a kept branch.
   */
  async function prepareDependencyChangeWithBookkeeping(taskId: string, keptBranch: string): Promise<void> {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'package.json'), '{"private":true}\n')
    writeFileSync(join(repoRoot, 'package-lock.json'), '{"lockfileVersion":3}\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: add dependency manifests'])

    const paths = orchPaths(repoRoot)
    const worktree = worktreeDir(paths, taskId)
    git(['worktree', 'add', worktree, '-b', branchName(taskId)])
    writeFileSync(
      join(worktree, 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"node_modules/new-dependency":{}}}\n',
    )
    git(['add', '-A'], worktree)
    git(['commit', '-qm', 'fix: update dependencies'], worktree)
    await writeStatus(paths, taskId, 'completed')
    git(['branch', keptBranch])
    writeConflictedAttempts(paths, taskId, [{
      taskId: '20261112_200000_001_user-earlier-attempt',
      branch: keptBranch,
      runBranch: 'main', runTip: 'a', base: 'b', taskTip: 'c',
      conflictedFiles: ['package-lock.json'], conflictingCommits: [],
    }])
    writeGateFixState(paths, taskId, { attempts: 1, verificationFailed: true, pending: false })
    mkdirSync(paths.queueDir, { recursive: true })
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '3\n')
  }

  /**
   * Runs `merge <task> --yes` in this process with the dependency install and the task
   * process termination replaced, and returns the exit code and the errors it printed.
   */
  async function manualMergeInProcess(
    taskId: string,
    install: () => void,
    termination: TaskProcessTermination,
  ): Promise<{ exitCode: typeof process.exitCode; errors: string }> {
    vi.doMock('../src/merge.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/merge.ts')>()
      return {
        ...actual,
        mergeTask: (...args: Parameters<typeof actual.mergeTask>) => actual.mergeTask(
          args[0], args[1], { ...args[2], orchestrationDepsRuntime: { install, packageRoot: repoRoot } },
        ),
      }
    })
    vi.doMock('../src/taskProcesses.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/taskProcesses.ts')>(),
      terminateLiveTaskProcesses: () => termination,
    }))
    vi.doMock('node:child_process', async (importOriginal) => {
      const childProcess = await importOriginal<typeof import('node:child_process')>()
      return {
        ...childProcess,
        execFileSync: (...args: Parameters<typeof execFileSync>) => {
          const [file, fileArgs] = args
          if (file === 'git' && fileArgs?.join(' ') === 'rev-parse --show-toplevel') {
            return repoRoot
          }
          return childProcess.execFileSync(...args)
        },
      }
    })
    vi.resetModules()

    const errors: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '))
    })
    const previousArgv = process.argv
    const previousExitCode = process.exitCode
    const previousEnv = { ...process.env }
    try {
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, CORE_ENV)
      process.argv = [process.execPath, CLI, 'merge', taskId, '--yes']

      await import('../src/cli.ts')

      return { exitCode: process.exitCode, errors: errors.join('\n') }
    } finally {
      consoleError.mockRestore()
      process.argv = previousArgv
      process.exitCode = previousExitCode
      for (const name of Object.keys(process.env)) delete process.env[name]
      Object.assign(process.env, previousEnv)
      vi.doUnmock('../src/merge.ts')
      vi.doUnmock('../src/taskProcesses.ts')
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
  }

  function expectMergeBookkeepingSettledAndRerunSkipped(taskId: string, keptBranch: string): void {
    const paths = orchPaths(repoRoot)
    expect(readFileSync(join(paths.statusDir, `${taskId}.json`), 'utf8')).toContain('"merged"')
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('0\n')
    expect(readGateFixState(paths, taskId)).toBeUndefined()
    expect(readConflictedAttempts(paths, taskId)).toEqual([])
    expect(git(['branch', '--list', keptBranch]).trim()).toBe('')

    const rerun = spawnSync(process.execPath, [CLI, 'merge', taskId, '--yes'], {
      cwd: repoRoot,
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(rerun.status).toBe(0)
    expect(rerun.stdout).toContain(`Skipped ${taskId}: merge already succeeded`)
    expect(rerun.stderr).toBe('')
  }

  it('settles the merge bookkeeping when the dependency install after the merge fails', async () => {
    const taskId = '20261112_203829_051_user-manual-install-failure'
    const keptBranch = 'orchestration/conflict/install-failure-attempt'
    await prepareDependencyChangeWithBookkeeping(taskId, keptBranch)
    const install = vi.fn(() => {
      throw new Error('npm ci exited 1')
    })

    const result = await manualMergeInProcess(taskId, install, { terminated: [], failures: [] })

    expect(result.exitCode).toBe(1)
    expect(install).toHaveBeenCalledOnce()
    expect(result.errors).toContain('Orchestration dependency installation after 051_user failed in')
    expectMergeBookkeepingSettledAndRerunSkipped(taskId, keptBranch)
  })

  it('settles the merge bookkeeping when a surviving task process skips the install', async () => {
    const taskId = '20261112_203829_052_user-manual-install-skipped'
    const keptBranch = 'orchestration/conflict/install-skipped-attempt'
    await prepareDependencyChangeWithBookkeeping(taskId, keptBranch)
    const install = vi.fn()

    const result = await manualMergeInProcess(taskId, install, {
      terminated: [],
      failures: [{
        taskId: '20261112_203800_049_user-parallel-runner', pid: 43122,
        error: 'Could not stop process tree 43122.',
      }],
    })

    expect(result.exitCode).toBe(1)
    expect(install).not.toHaveBeenCalled()
    expect(result.errors).toContain(
      'Orchestration dependency installation after 052_user remains pending in',
    )
    expectMergeBookkeepingSettledAndRerunSkipped(taskId, keptBranch)
  })

  it('forwards failed check output before reporting the merge failure', async () => {
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'chore: initial commit'])

    const paths = orchPaths(repoRoot)
    const taskId = '20260808_000000_002_user-failed-check'
    const worktree = worktreeDir(paths, taskId)
    git(['worktree', 'add', worktree, '-b', branchName(taskId)])
    writeFileSync(join(worktree, 'work.txt'), 'done\n')
    git(['add', '-A'], worktree)
    git(['commit', '-qm', 'fix: complete task with failed check'], worktree)
    await writeStatus(paths, taskId, 'completed')

    const command = 'node -e "console.log(\'check stdout\'); console.error(\'check stderr\'); process.exit(1)"'
    const result = spawnSync(process.execPath, [CLI, 'merge', taskId, '--yes', '--test-cmd', command], {
      cwd: repoRoot,
      env: CORE_ENV,
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('check stdout')
    expect(result.stderr).toContain('check stderr')
    expect(result.stderr).toContain('Tests failed. Aborting merge.')
  })

  it('rejects --test-cmd without a command instead of falling back to TEST_CMD', () => {
    const result = spawnSync(process.execPath, [CLI, 'merge', 'missing-test-cmd', '--yes', '--test-cmd'], {
      cwd: repoRoot,
      env: { ...CORE_ENV, TEST_CMD: 'node -e "process.exit(0)"' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: CLI_TIMEOUT_MS,
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('Usage: merge <task-id> [--yes] [--test-cmd "cmd"]\n')
  })
})
