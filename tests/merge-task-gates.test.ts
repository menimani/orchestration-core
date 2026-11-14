// The second half of the mergeTask tests, kept apart from tests/merge.test.ts so the two
// halves run on separate workers. The describe name is the same, so reported test names
// do not change.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { MergeCheck, ProjectAdapter } from '../src/adapters/project.ts'
import {
  describeCommandFailure, MergeError, MergeRecoveryError, mergeTask, RebaseConflictError,
  TEST_LOCK_BUSY_EXIT_CODE, TestLockBusyError, VerificationFailedError,
} from '../src/merge.ts'
import { readStatus } from '../src/status.ts'
import {
  expectNoTemporaryWorktree, git, installProject, makeCompletedTask, noCheckProject, paths,
  repoRoot,
} from './mergeHarness.ts'
import { stubProject } from './stubProject.ts'
import { nonCanonicalSpelling } from './pathComparison.ts'

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

  it('installs before a merge check when its dependency path is absent', async () => {
    const taskId = '20260808_000000_008_user-needs-install'
    await makeCompletedTask(taskId, { commit: true })
    const outputFile = join(repoRoot, 'merge-check.log')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
    })

    const output = readFileSync(outputFile, 'utf8')
    const outputLines = output.split(/\r?\n/)
    expect(outputLines.filter((line) => line === 'install ran')).toHaveLength(1)
    expect(outputLines.indexOf('install ran')).toBeLessThan(outputLines.indexOf('check ran'))
    expect(outputLines).toContain('check warning')
  })

  it('rejects a check that passed on dependencies it does not have', async () => {
    const taskId = '20260808_000000_013_user-declares-uninstalled-dependency'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'fixture-dependency': '^1.0.0' },
    }, null, 2)}\n`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare a dependency nobody installed'])
    const outputFile = join(repoRoot, 'merge-check.log')

    const failure = await mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
    }).catch((error: unknown) => error)

    // The same refusal as the explicit test command's, and never a hand-back candidate.
    expect(failure).toBeInstanceOf(MergeError)
    expect(failure).not.toBeInstanceOf(VerificationFailedError)
    expect((failure as Error).message)
      .toBe('Tests passed against borrowed dependencies. Aborting merge.')
    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain('passed on dependencies it does not have')
    expect(output).toContain('fixture-dependency')
  })

  it('reports a genuine check failure ahead of another check that borrowed dependencies', async () => {
    const taskId = '20260808_000000_098_user-fails-and-borrows'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'fixture-dependency': '^1.0.0' },
    }, null, 2)}
`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare a dependency nobody installed'])
    const project: ProjectAdapter = {
      ...installProject,
      name: 'fails-and-borrows',
      mergeChecks: () => [
        { label: 'Borrowing check', cwd: '', command: 'node -e ""' },
        { label: 'Failing check', cwd: '', command: 'node -e "process.exit(1)"' },
      ],
    }

    const failure = await mergeTask(paths, taskId, { taskGate: 'light', project })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(VerificationFailedError)
    expect((failure as Error).message).toBe('Tests failed. Aborting merge.')
  })

  it('does not apply Node dependency isolation to adapters that did not opt in', async () => {
    const taskId = '20260808_000000_018_user-uses-another-package-manager'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'virtual-dependency': '^1.0.0' },
    }, null, 2)}\n`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare a virtual dependency'])
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'virtual-dependencies',
      mergeChecks: () => [{ label: 'Non-Node gate', cwd: '', command: 'node -e ""' }],
    }

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project,
    })).resolves.toEqual({
      outcome: 'merged', mergeCommit: git(repoRoot, ['rev-parse', 'HEAD']).trim(),
    })
  })

  it('accepts a check that installs its own dependencies as its first step', async () => {
    const taskId = '20260808_000000_014_user-installs-inside-the-check'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'fixture-dependency': '^1.0.0' },
    }, null, 2)}\n`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare a dependency the check installs'])
    // The core's own gate is `npm ci && tsc && npm test` in one command: nothing is
    // installed when the check starts, and everything is by the time it ends.
    const installingProject: ProjectAdapter = {
      ...stubProject,
      name: 'installs-inside-check',
      mergeChecks: () => [{
        label: 'Fixture gate',
        cwd: '',
        command: 'node -e "const {mkdirSync,writeFileSync}=require(\'fs\');'
          + "mkdirSync('node_modules/fixture-dependency',{recursive:true});"
          + "writeFileSync('node_modules/.package-lock.json','{}')\"",
      }],
    }

    await mergeTask(paths, taskId, { taskGate: 'light', project: installingProject })

    expect(git(repoRoot, ['log', '-1', '--pretty=%s'])).toContain(taskId)
  })

  it('skips installation when the merge check dependency path is present', async () => {
    const taskId = '20260808_000000_009_user-has-dependency'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'dependency-ready'), 'ready\n')
    git(worktree, ['add', 'dependency-ready'])
    git(worktree, ['commit', '-qm', 'test: add dependency fixture'])
    const outputFile = join(repoRoot, 'merge-check.log')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
    })

    const output = readFileSync(outputFile, 'utf8')
    expect(output).not.toContain('install ran')
    expect(output.split(/\r?\n/).filter((line) => line === 'check ran')).toHaveLength(1)
  })

  it('installs orchestration dependencies once when the merge changes package.json', async () => {
    const taskId = '20260808_000000_010_user-adds-orchestration-dependency'
    const worktree = await makeCompletedTask(taskId)
    mkdirSync(join(worktree, 'orchestration', 'ts'), { recursive: true })
    writeFileSync(join(worktree, 'orchestration', 'ts', 'package.json'), '{"dependencies":{}}\n')
    git(worktree, ['add', 'orchestration/ts/package.json'])
    git(worktree, ['commit', '-qm', 'feat: add orchestration dependency'])
    const statusDuringInstall: Array<string | undefined> = []
    const install = vi.fn(() => {
      statusDuringInstall.push(readStatus(paths, taskId)?.status)
    })
    const event = vi.fn()

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: { install, packageRoot: join(repoRoot, 'orchestration', 'ts') },
      onOrchestrationDepsEvent: event,
    })

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(join(repoRoot, 'orchestration', 'ts'))
    expect(statusDuringInstall).toEqual(['merged'])
    expect(event).toHaveBeenCalledWith(
      'Installed', 'after 010_user',
    )
  })

  it('installs orchestration dependencies when the package is at the repository root', async () => {
    const taskId = '20260808_000000_013_user-updates-root-dependency'
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(join(worktree, 'package.json'), '{"dependencies":{}}\n')
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'fix: update root dependency'])
    const install = vi.fn()

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: { install, packageRoot: repoRoot },
    })

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(repoRoot)
  })

  it('installs orchestration dependencies when the package root is spelled differently from the repository', async () => {
    const taskId = '20260808_000000_014_user-updates-mis-cased-dependency'
    const worktree = await makeCompletedTask(taskId)
    mkdirSync(join(worktree, 'orchestration', 'ts'), { recursive: true })
    writeFileSync(join(worktree, 'orchestration', 'ts', 'package-lock.json'), '{}\n')
    git(worktree, ['add', 'orchestration/ts/package-lock.json'])
    git(worktree, ['commit', '-qm', 'feat: update orchestration lockfile'])
    const linkDir = mkdtempSync(join(tmpdir(), 'orch-merge-alias-'))
    const install = vi.fn()

    try {
      const packageRoot = join(nonCanonicalSpelling(repoRoot, linkDir), 'orchestration', 'ts')
      await mergeTask(paths, taskId, {
        taskGate: 'light',
        project: noCheckProject,
        orchestrationDepsRuntime: { install, packageRoot },
      })

      expect(install).toHaveBeenCalledOnce()
      expect(install).toHaveBeenCalledWith(packageRoot)
    } finally {
      rmSync(linkDir, { recursive: true, force: true })
    }
  })

  it('does not install orchestration dependencies when the merge leaves manifests unchanged', async () => {
    const taskId = '20260808_000000_011_user-changes-source'
    await makeCompletedTask(taskId, { commit: true })
    const install = vi.fn()

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: { install, packageRoot: join(repoRoot, 'orchestration', 'ts') },
    })

    expect(install).not.toHaveBeenCalled()
  })

  it('persists the merge and stops when orchestration dependency installation fails', async () => {
    const taskId = '20260808_000000_012_user-adds-broken-dependency'
    const worktree = await makeCompletedTask(taskId)
    mkdirSync(join(worktree, 'orchestration', 'ts'), { recursive: true })
    writeFileSync(join(worktree, 'orchestration', 'ts', 'package-lock.json'), '{}\n')
    git(worktree, ['add', 'orchestration/ts/package-lock.json'])
    git(worktree, ['commit', '-qm', 'feat: update orchestration lockfile'])
    const event = vi.fn()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: {
        install: () => { throw new Error('registry unavailable') },
        packageRoot: join(repoRoot, 'orchestration', 'ts'),
      },
      onOrchestrationDepsEvent: event,
    })).rejects.toThrow(
      `Orchestration dependency installation after 012_user failed in ${join(repoRoot, 'orchestration', 'ts')}: registry unavailable. The checkout may now be missing dependencies. Run "npm ci --no-audit --no-fund" in ${join(repoRoot, 'orchestration', 'ts')}, then restart the loop.`,
    )

    expect(event).not.toHaveBeenCalled()
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('keeps a recorded merge and cleans up when the dependency check cannot read it', async () => {
    const taskId = '20260808_000000_015_user-unreadable-merge'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const install = vi.fn()
    const events: Array<[string, string]> = []
    const previousGitDir = process.env.GIT_DIR
    const restoreGitDir = (): void => {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
    }

    try {
      const result = await mergeTask(paths, taskId, {
        taskGate: 'light',
        project: noCheckProject,
        orchestrationDepsRuntime: { install, packageRoot: join(repoRoot, 'orchestration', 'ts') },
        // Every git call the dependency check makes now fails; the warning restores git
        // so the cleanup that follows runs against the real repository.
        onMerged: () => { process.env.GIT_DIR = join(repoRoot, 'missing-git-dir') },
        onOrchestrationDepsEvent: (name, subject) => {
          restoreGitDir()
          events.push([name, subject])
        },
      })

      expect(result).toMatchObject({ outcome: 'merged' })
    } finally {
      restoreGitDir()
    }

    expect(install).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0]?.[0]).toBe('WARN')
    expect(events[0]?.[1]).toContain('could not check 015_user for orchestration dependency changes')
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', `task/${taskId}`]).trim()).toBe('')
  })

  it('stops when a failed local merge cannot prove that the worktree was restored', async () => {
    const taskId = '20260824_084607_019_auto-merge-recovery'
    await makeCompletedTask(taskId, { commit: true })
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    let mergeCalls = 0
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string => {
        if (args[0] === 'merge' && args[1] === '--quiet') {
          mergeCalls += 1
          if (mergeCalls === 2) {
            git(cwd, ['merge', '--no-commit', '--no-ff', args[3]!])
            throw new Error('merge result was not reported')
          }
        }
        if (args[0] === 'merge' && args[1] === '--abort') {
          throw new Error('abort failed')
        }
        return git(cwd, args)
      },
    }

    const failure = mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, mergeRuntime,
    })
    await expect(failure).rejects.toThrow(MergeRecoveryError)
    await expect(failure).rejects.toThrow('merge is still in progress; merge abort failed')

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expectNoTemporaryWorktree('.merge-')
  })

  it('refuses to merge into a checkout that already has a merge in progress', async () => {
    const taskId = '20260824_084607_020_auto-merge-in-progress'
    await makeCompletedTask(taskId, { commit: true })
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const mergeHead = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'])
      .trim()
    writeFileSync(mergeHead, `${runHead}\n`)
    const mergeCommands: string[] = []
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string => {
        if (args[0] === 'merge' && cwd === repoRoot) mergeCommands.push(args[1]!)
        return git(cwd, args)
      },
    }

    const failure = mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, mergeRuntime,
    })
    await expect(failure).rejects.toThrow(MergeRecoveryError)
    await expect(failure).rejects.toThrow(
      'The integration worktree already has a merge in progress. '
      + 'Inspect and restore it before restarting orchestration.',
    )

    // Neither a merge nor an abort may touch the merge someone else left there.
    expect(mergeCommands).toEqual([])
    expect(readFileSync(mergeHead, 'utf8')).toBe(`${runHead}\n`)
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expectNoTemporaryWorktree('.merge-')
  })

  it('stops when the state after a failed local merge cannot be read', async () => {
    const taskId = '20260824_084607_021_auto-unreadable-merge'
    await makeCompletedTask(taskId, { commit: true })
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    let mergeFailed = false
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string => {
        if (args[0] === 'merge' && args[1] === '--quiet' && cwd === repoRoot) {
          mergeFailed = true
          throw new Error('merge was interrupted')
        }
        if (args[0] === 'merge' && args[1] === '--abort') return ''
        if (mergeFailed && args[0] === 'status') throw new Error('index is unreadable')
        return git(cwd, args)
      },
    }

    const failure = mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, mergeRuntime,
    })
    await expect(failure).rejects.toThrow(MergeRecoveryError)
    await expect(failure).rejects.toThrow(
      'A merge conflict occurred. Rebase the worktree, then retry the merge. '
      + 'Recovery could not be verified: index is unreadable; merge abort reported success. '
      + 'Merge failure: merge was interrupted. '
      + 'Inspect and restore the integration worktree before restarting orchestration.',
    )

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expectNoTemporaryWorktree('.merge-')
  })
})
