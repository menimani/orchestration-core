// Part of the mergeTask tests, kept apart from the other parts (tests/merge.test.ts,
// tests/merge-task-cleanup.test.ts, tests/merge-task-no-change.test.ts,
// tests/merge-task-dependencies.test.ts and tests/merge-task-checkout.test.ts) so the parts
// run on separate workers. The describe name is the same, so reported test names do not
// change.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { MergeCheck, ProjectAdapter } from '../src/adapters/project.ts'
import {
  describeCommandFailure, MergeError, MergeRecoveryError, mergeTask, RebaseConflictError,
  TEST_LOCK_BUSY_EXIT_CODE, TestLockBusyError,
} from '../src/merge.ts'
import { readStatus } from '../src/status.ts'
import {
  expectNoTemporaryWorktree, git, makeCompletedTask, noCheckProject, paths, repoRoot,
} from './mergeHarness.ts'
import { stubProject } from './stubProject.ts'

describe('mergeTask', () => {
  it('defers rather than fails a merge whose tests waited out the repository test lock', async () => {
    const taskId = '20260808_000000_091_user-test-lock-busy'
    await makeCompletedTask(taskId, { commit: true })
    const head = git(repoRoot, ['rev-parse', 'HEAD'])
    const outputFile = join(repoRoot, 'test-lock-busy.log')

    const result = mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, outputFile,
      testCmd: `node -e "process.exit(${TEST_LOCK_BUSY_EXIT_CODE})"`,
    })

    await expect(result).rejects.toBeInstanceOf(TestLockBusyError)
    await expect(result).rejects.toThrow('the repository test lock stayed busy')
    expect(readFileSync(outputFile, 'utf8')).toContain('=== Tests failed: exit status 75 ===')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(head)
  })

  it('defers a check that waited out the test lock only when no other check failed', async () => {
    const taskId = '20260808_000000_092_user-test-lock-busy-check'
    await makeCompletedTask(taskId, { commit: true })
    const lockBusy = {
      label: 'Locked suite', cwd: '', command: `node -e "process.exit(${TEST_LOCK_BUSY_EXIT_CODE})"`,
    }
    const deferred: ProjectAdapter = {
      ...stubProject,
      name: 'lock-busy-check',
      mergeChecks: () => [lockBusy, { label: 'Passing check', cwd: '', command: 'node -e "process.exit(0)"' }],
    }
    const failing: ProjectAdapter = {
      ...stubProject,
      name: 'lock-busy-and-failing-check',
      mergeChecks: () => [lockBusy, { label: 'Failing check', cwd: '', command: 'node -e "process.exit(1)"' }],
    }

    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: deferred }))
      .rejects.toBeInstanceOf(TestLockBusyError)
    const failure = mergeTask(paths, taskId, { taskGate: 'light', project: failing })
    await expect(failure).rejects.toThrow('Tests failed. Aborting merge.')
    await expect(failure).rejects.not.toBeInstanceOf(TestLockBusyError)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('defers a check whose install waited out the test lock without running the check', async () => {
    const taskId = '20260808_000000_093_user-test-lock-busy-install'
    await makeCompletedTask(taskId, { commit: true })
    const head = git(repoRoot, ['rev-parse', 'HEAD'])
    const outputFile = join(repoRoot, 'test-lock-busy-install.log')
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'lock-busy-install',
      mergeChecks: () => [{
        label: 'Installed check',
        cwd: '',
        command: 'node -e "console.log(\'installed check ran\')"',
        installWhenMissing: {
          path: 'dependency-ready',
          command: `node -e "process.exit(${TEST_LOCK_BUSY_EXIT_CODE})"`,
        },
      }],
    }

    const result = mergeTask(paths, taskId, { taskGate: 'light', project, outputFile })

    await expect(result).rejects.toBeInstanceOf(TestLockBusyError)
    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain('=== Installed check install failed: exit status 75 ===')
    expect(output).not.toContain('=== Installed check: ')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(head)
  })

  it('hands a check the real name of a changed non-ASCII file', async () => {
    const taskId = '20260808_000000_094_user-non-ascii-check'
    const fileName = 'old→new.ts'
    git(repoRoot, ['config', 'core.quotePath', 'true'])
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(join(worktree, fileName), 'export {}\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'feat: add a non-ASCII file'])
    const appliesTo = vi.fn((changed: string[]) => changed.some((file) => file.endsWith('.ts')))
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'non-ascii-check',
      mergeChecks: () => [{
        label: 'TypeScript check', cwd: '', command: 'node -e "process.exit(1)"', appliesTo,
      }],
    }

    await expect(mergeTask(paths, taskId, { taskGate: 'light', project }))
      .rejects.toThrow(/Tests failed/)

    expect(appliesTo).toHaveBeenCalledWith([fileName])
  })

  // Each condition is decided by whether the task committed a marker file: appliesTo sees
  // it among the changed paths, requires needs it, and unless is satisfied by it.
  const gateConditions: [string, Partial<MergeCheck>, boolean][] = [
    ['appliesTo', { appliesTo: (changed) => changed.includes('gate-marker.txt') }, true],
    ['requires', { requires: 'gate-marker.txt' }, true],
    ['unless', { unless: 'gate-marker.txt' }, false],
  ]

  async function makeGatedTask(taskId: string, marker: boolean): Promise<void> {
    const worktree = await makeCompletedTask(taskId, { commit: true })
    if (!marker) return
    writeFileSync(join(worktree, 'gate-marker.txt'), 'marker\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'feat: add the gate marker'])
  }

  function gatedProject(condition: Partial<MergeCheck>): ProjectAdapter {
    return {
      ...stubProject,
      name: 'gated-check',
      mergeChecks: () => [{
        label: 'Gated check', cwd: '', command: 'node -e "process.exit(1)"', ...condition,
      }],
    }
  }

  it.each(gateConditions)('skips a failing check whose %s condition excludes it', async (name, condition, runsWithMarker) => {
    const taskId = `20260808_000000_096_user-skips-${name}-check`
    await makeGatedTask(taskId, !runsWithMarker)
    const outputFile = join(repoRoot, `skipped-${name}-check.log`)

    await mergeTask(paths, taskId, { taskGate: 'light', project: gatedProject(condition), outputFile })

    expect(readFileSync(outputFile, 'utf8')).not.toContain('Gated check')
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it.each(gateConditions)('fails the merge on a failing check whose %s condition holds', async (name, condition, runsWithMarker) => {
    const taskId = `20260808_000000_097_user-runs-${name}-check`
    await makeGatedTask(taskId, runsWithMarker)
    const outputFile = join(repoRoot, `applied-${name}-check.log`)

    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: gatedProject(condition), outputFile }))
      .rejects.toThrow('Tests failed. Aborting merge.')

    expect(readFileSync(outputFile, 'utf8')).toContain('=== Gated check failed: exit status 1 ===')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it.each([
    [{ status: 1, signal: null }, 'exit status 1'],
    [{ status: 3221226505, signal: null }, 'exit status 3221226505 (0xC0000409)'],
    [{ status: -1073740791, signal: null }, 'exit status -1073740791 (0xC0000409)'],
    [{ status: null, signal: 'SIGABRT' }, 'terminated by signal SIGABRT'],
    [new Error('spawn ENOENT'), 'did not run: spawn ENOENT'],
  ])('describes a gate command that ended as %j', (error, description) => {
    expect(describeCommandFailure(error)).toBe(description)
  })

  it('bypasses automatic checks when they are disabled', async () => {
    const taskId = '20260808_000000_020_user-skips-automatic-checks'
    await makeCompletedTask(taskId, { commit: true })
    const mergeChecks = vi.fn(() => [{
      label: 'Failing automatic check', cwd: '', command: 'node -e "process.exit(1)"',
    }])
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'skipped-checks',
      mergeChecks,
    }

    await mergeTask(paths, taskId, {
      taskGate: 'light', project, skipAutoTest: true,
    })

    expect(mergeChecks).not.toHaveBeenCalled()
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('runs an explicit test command even when automatic checks are disabled', async () => {
    const taskId = '20260808_000000_021_user-explicit-test-takes-precedence'
    await makeCompletedTask(taskId, { commit: true })

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, skipAutoTest: true,
      testCmd: 'node -e "process.exit(1)"',
    })).rejects.toThrow(/Tests failed/)

    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('runs checks against the task merged with intervening run-branch commits', async () => {
    const taskId = '20260808_000000_014_user-combined-check'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(repoRoot, 'run.txt'), 'newer run work\n')
    git(repoRoot, ['add', 'run.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add newer run work'])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'full',
      project: stubProject,
      testCmd: 'node -e "const fs=require(\'node:fs\'); process.exit(fs.existsSync(\'run.txt\') && fs.existsSync(\'20260808_000000_014_user-combined-check.txt\') ? 1 : 0)"',
    })).rejects.toThrow(/Tests failed/)

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(join(repoRoot, `${taskId}.txt`))).toBe(false)
    expect(existsSync(worktree)).toBe(true)
    expect(git(worktree, ['merge-base', '--is-ancestor', runHead, 'HEAD'])).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('aborts a conflicting rebase without changing the run branch or task state', async () => {
    const taskId = '20260808_000000_016_user-conflicting-change'
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(join(worktree, 'README.md'), '# task version\n')
    git(worktree, ['add', 'README.md'])
    git(worktree, ['commit', '-qm', 'feat: change README in task'])
    const taskHead = git(worktree, ['rev-parse', 'HEAD']).trim()

    writeFileSync(join(repoRoot, 'README.md'), '# run version\n')
    git(repoRoot, ['add', 'README.md'])
    git(repoRoot, ['commit', '-qm', 'feat: change README on run branch'])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const runStatus = git(repoRoot, ['status', '--porcelain'])
    const forkPoint = git(repoRoot, ['merge-base', 'HEAD', taskHead]).trim()

    const failure = await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(RebaseConflictError)
    expect((failure as RebaseConflictError).message).toBe(
      'A conflict occurred while rebasing the task onto main; the rebase was aborted.',
    )
    expect((failure as RebaseConflictError).conflict).toEqual({
      runBranch: 'main',
      runTip: runHead,
      base: forkPoint,
      taskTip: taskHead,
      conflictedFiles: ['README.md'],
      conflictingCommits: [runHead],
    })

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(git(repoRoot, ['status', '--porcelain'])).toBe(runStatus)
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('# run version\n')
    expect(existsSync(worktree)).toBe(true)
    expect(git(worktree, ['rev-parse', 'HEAD']).trim()).toBe(taskHead)
    expect(git(worktree, ['status', '--porcelain'])).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expectNoTemporaryWorktree('.merge-')
  })

  it('reports a conflicted non-ASCII file by its real name', async () => {
    const taskId = '20260808_000000_095_user-non-ascii-conflict'
    const fileName = 'old→new.md'
    git(repoRoot, ['config', 'core.quotePath', 'true'])
    writeFileSync(join(repoRoot, fileName), '# base\n')
    git(repoRoot, ['add', fileName])
    git(repoRoot, ['commit', '-qm', 'feat: add a non-ASCII file'])
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(join(worktree, fileName), '# task version\n')
    git(worktree, ['add', fileName])
    git(worktree, ['commit', '-qm', 'feat: change the file in task'])

    writeFileSync(join(repoRoot, fileName), '# run version\n')
    git(repoRoot, ['add', fileName])
    git(repoRoot, ['commit', '-qm', 'feat: change the file on run branch'])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    const failure = await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(RebaseConflictError)
    expect((failure as RebaseConflictError).conflict).toMatchObject({
      conflictedFiles: [fileName],
      conflictingCommits: [runHead],
    })
  })

  it('keeps a rebase that fails without a conflict retryable', async () => {
    const taskId = '20260808_000000_017_user-locked-rebase'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const taskHead = git(worktree, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repoRoot, 'run.txt'), 'newer run work\n')
    git(repoRoot, ['add', 'run.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add newer run work'])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const indexLock = git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock'])
      .trim()
    writeFileSync(indexLock, '')

    const failure = await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(MergeError)
    expect(failure).not.toBeInstanceOf(RebaseConflictError)
    expect((failure as MergeError).message).toMatch(
      /^Rebasing the task onto main failed without a conflict; the rebase was aborted\. Rebase failure: .*index\.lock/,
    )
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(worktree)).toBe(true)
    expect(git(worktree, ['rev-parse', 'HEAD']).trim()).toBe(taskHead)
    expect(readStatus(paths, taskId)?.status).toBe('completed')

    rmSync(indexLock)
    await mergeTask(paths, taskId, { taskGate: 'light', project: noCheckProject })
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('stops the loop when a failed rebase cannot be aborted', async () => {
    const taskId = '20260808_000000_018_user-stuck-rebase'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const taskHead = git(worktree, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repoRoot, 'run.txt'), 'newer run work\n')
    git(repoRoot, ['add', 'run.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add newer run work'])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    // Rebase state without a head-name: the rebase refuses to start and the abort fails.
    const rebaseState = git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge'])
      .trim()
    mkdirSync(rebaseState, { recursive: true })
    writeFileSync(join(rebaseState, 'interactive'), '')

    const failure = await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(MergeRecoveryError)
    expect((failure as MergeRecoveryError).message).toMatch(
      /^Rebasing the task onto main failed and the abort did not restore the task worktree: .*rebase is still in progress; rebase abort failed: /,
    )
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(worktree)).toBe(true)
    expect(git(worktree, ['rev-parse', `task/${taskId}`]).trim()).toBe(taskHead)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('stops the loop when the state after a failed rebase cannot be read', async () => {
    const taskId = '20260808_000000_019_user-unreadable-rebase'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const taskHead = git(worktree, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repoRoot, 'run.txt'), 'newer run work\n')
    git(repoRoot, ['add', 'run.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add newer run work'])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    // The hook refuses the rebase and points the task worktree at a missing git directory,
    // so the abort and every check after it fail.
    const hooksDir = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks']).trim()
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(
      join(hooksDir, 'pre-rebase'),
      '#!/bin/sh\necho "gitdir: missing-gitdir" > .git\nexit 1\n',
      { mode: 0o755 },
    )

    const failure = await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(MergeRecoveryError)
    // Git names the dangling gitfile "not a git repository" or, in newer releases, a gitfile
    // that "does not point to a valid repository"; both wordings are the same failure.
    expect((failure as MergeRecoveryError).message).toMatch(
      /^Rebasing the task onto main failed and recovery could not be verified: .*(not a git repository|does not point to a valid repository).*; rebase abort failed: .*Inspect and restore the task worktree before restarting orchestration\.$/s,
    )
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(git(repoRoot, ['rev-parse', `task/${taskId}`]).trim()).toBe(taskHead)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('throws MergeError instances so callers can count merge failures', async () => {
    const taskId = '20260808_000000_007_user-error-type'
    await makeCompletedTask(taskId)
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .rejects.toBeInstanceOf(MergeError)
  })
})
