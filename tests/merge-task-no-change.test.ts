import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { ForgeRateLimitError } from '../src/adapters/forge.ts'
import {
  completeTaskWithoutChanges, MergeError, mergeTask, NoChangeReconciliationError,
  VerificationFailedError,
} from '../src/merge.ts'
import { branchName, finalMessageFile, worktreeDir } from '../src/paths.ts'
import { rebaseEmptiedMarkerPresent, recordRebaseEmptiedMarker } from '../src/refresh.ts'
import { readStatus, writeStatus } from '../src/status.ts'
import {
  failedWorktreeRemovalRuntime, git, installProject, makeCompletedTask, noCheckProject, paths,
  repoRoot, staleMetadataRemovalRuntime,
} from './mergeHarness.ts'
import { stubProject } from './stubProject.ts'

describe('mergeTask', () => {
  it('names no queue issue in the merge commit when the queue is in another repository', async () => {
    const taskId = '20260808_000000_016_user-fleet-issue'
    await makeCompletedTask(taskId, { commit: true })
    const fleetQueuePaths = {
      ...paths,
      fleet: {
        dir: repoRoot, project: 'example', repository: 'owner/example', issueRepository: 'owner/fleet',
      },
    }

    await mergeTask(fleetQueuePaths, taskId, {
      taskGate: 'light',
      project: stubProject,
      closesIssues: [317, 318],
      forge: {
        issueClosingCommitMessage: (message, issueNumber) => `${message} (closes #${issueNumber})`,
      },
    })

    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via orchestration`,
    )
  })

  it('closes the project issues imported work came from when the queue is elsewhere', async () => {
    const taskId = '20260808_000000_017_user-imported-issue'
    await makeCompletedTask(taskId, { commit: true })
    const fleetQueuePaths = {
      ...paths,
      fleet: {
        dir: repoRoot, project: 'example', repository: 'owner/example', issueRepository: 'owner/fleet',
      },
    }

    await mergeTask(fleetQueuePaths, taskId, {
      taskGate: 'light',
      project: stubProject,
      closesIssues: [317],
      closesSourceIssues: [42],
      forge: {
        issueClosingCommitMessage: (message, issueNumber) => `${message} (closes #${issueNumber})`,
      },
    })

    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via orchestration (closes #42)`,
    )
  })

  it('stops on uncommitted changes and keeps the worktree', async () => {
    const taskId = '20260808_000000_002_user-forgot-commit'
    const worktree = await makeCompletedTask(taskId, { commit: true, dirty: true })
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .rejects.toThrow(/uncommitted changes/)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('stops a non-inspection task that produced no commits', async () => {
    const taskId = '20260808_000000_003_user-empty-handed'
    const worktree = await makeCompletedTask(taskId)
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .rejects.toThrow(/no new commits/)
    expect(existsSync(worktree)).toBe(true)
  })

  it('accepts an explicit no-change verdict without creating a merge commit', async () => {
    const taskId = '20260808_000000_023_user-already-resolved'
    const worktree = await makeCompletedTask(taskId)
    const initialHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const onNoChange = vi.fn(async () => {})
    writeFileSync(finalMessageFile(paths, taskId),
      'The reported problem is already fixed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, onNoChange,
    })).resolves.toEqual({ outcome: 'no-change' })

    expect(onNoChange).toHaveBeenCalledOnce()
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(initialHead)
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
  })

  it('reports manual cleanup when a no-change worktree could not be removed', async () => {
    const taskId = '20260808_000000_028_user-retained-no-change-worktree'
    const worktree = await makeCompletedTask(taskId)
    const outputFile = join(repoRoot, 'no-change-output.log')
    writeFileSync(finalMessageFile(paths, taskId),
      'The reported problem is already fixed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, outputFile,
      worktreeRemovalRuntime: failedWorktreeRemovalRuntime(),
    })

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain(
      `WARN: task completed without changes, but the worktree is still there and has to go by hand: ${worktree}`,
    )
    expect(output).toContain(
      `Completed ${taskId} without changes; manual worktree cleanup remains: ${worktree}`,
    )
    expect(output).not.toContain(`Completed ${taskId} without changes and removed the worktree.`)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
  })

  it('does not report no-change cleanup while metadata and the task branch remain', async () => {
    const taskId = '20260820_205524_045_auto-retained-no-change-metadata'
    const worktree = await makeCompletedTask(taskId)
    const branch = branchName(taskId)
    const outputFile = join(repoRoot, 'stale-no-change-output.log')
    writeFileSync(finalMessageFile(paths, taskId),
      'The reported problem is already fixed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
      worktreeRemovalRuntime: staleMetadataRemovalRuntime(),
    })

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain(`WARN: worktree metadata pruning failed for ${worktree}`)
    expect(output).toContain(`task branch remains: ${branch}`)
    expect(output).not.toContain(`Completed ${taskId} without changes and removed the worktree.`)
    expect(git(repoRoot, ['worktree', 'list', '--porcelain']))
      .toContain(`branch refs/heads/${branch}`)
    expect(git(repoRoot, ['branch', '--list', branch]).trim()).not.toBe('')
  })

  it('keeps a no-change task retryable when its linked work cannot be reconciled', async () => {
    const taskId = '20260808_000000_024_user-no-change-retry'
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(finalMessageFile(paths, taskId),
      'No implementation is needed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')

    const onNoChange = vi.fn(async () => {
      expect(readStatus(paths, taskId)?.status).toBe('completed')
      expect(existsSync(worktree)).toBe(true)
      throw new Error('completion persistence unavailable')
    })
    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject,
      onNoChange,
    })).rejects.toThrow(
      'Could not reconcile the no-change verdict: completion persistence unavailable',
    )

    expect(onNoChange).toHaveBeenCalledOnce()
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('requires reconciliation before accepting a linked no-change task', async () => {
    const taskId = '20260808_000000_025_user-linked-no-change'
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(finalMessageFile(paths, taskId),
      'No implementation is needed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 318,
      forge: { issueClosingCommitMessage: (message) => message },
    })).rejects.toThrow('A linked no-change task requires issue reconciliation.')

    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('stops a task whose commits were empty before any rebase and that gave no verdict', async () => {
    const taskId = '20260808_000000_046_user-empty-commit'
    const worktree = await makeCompletedTask(taskId)
    git(worktree, ['commit', '-q', '--allow-empty', '-m', 'chore: record nothing'])
    const initialHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const onNoChange = vi.fn(async () => {})

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 318, onNoChange,
      forge: { issueClosingCommitMessage: (message) => message },
    })).rejects.toThrow(/has only empty commits/)

    expect(onNoChange).not.toHaveBeenCalled()
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(initialHead)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('accepts a no-change verdict from a task whose commits were empty before any rebase', async () => {
    const taskId = '20260808_000000_047_user-empty-commit-verdict'
    const worktree = await makeCompletedTask(taskId)
    git(worktree, ['commit', '-q', '--allow-empty', '-m', 'chore: record nothing'])
    const initialHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    writeFileSync(finalMessageFile(paths, taskId),
      'No implementation is needed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    const forge = { issueClosingCommitMessage: (message: string) => message }

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 318, forge,
    })).rejects.toThrow('A linked no-change task requires issue reconciliation.')
    expect(existsSync(worktree)).toBe(true)

    const onNoChange = vi.fn(async () => {})
    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 318, forge, onNoChange,
    })).resolves.toEqual({ outcome: 'no-change' })

    expect(onNoChange).toHaveBeenCalledOnce()
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(initialHead)
    expect(existsSync(worktree)).toBe(false)
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
  })

  it('completes a task whose commits a rebase emptied without requiring a verdict', async () => {
    const taskId = '20260808_000000_048_user-already-landed'
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(join(worktree, 'landed.txt'), 'fixed\n')
    git(worktree, ['add', 'landed.txt'])
    git(worktree, ['commit', '-qm', 'fix: duplicate the run fix'])
    writeFileSync(join(repoRoot, 'landed.txt'), 'fixed\n')
    git(repoRoot, ['add', 'landed.txt'])
    git(repoRoot, ['commit', '-qm', 'fix: land the fix from another task'])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .resolves.toEqual({ outcome: 'no-change' })

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(worktree)).toBe(false)
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
  })

  // A task duplicating work already on the run branch: its one commit is emptied by the
  // rebase, not by the worker.
  async function makeAlreadyLandedTask(taskId: string): Promise<string> {
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(join(worktree, 'landed.txt'), 'fixed\n')
    git(worktree, ['add', 'landed.txt'])
    git(worktree, ['commit', '-qm', 'fix: duplicate the run fix'])
    writeFileSync(join(repoRoot, 'landed.txt'), 'fixed\n')
    git(repoRoot, ['add', 'landed.txt'])
    git(repoRoot, ['commit', '-qm', 'fix: land the fix from another task'])
    return worktree
  }

  it('retries a linked task a rebase emptied as no-change after its reconciliation failed', async () => {
    const taskId = '20260808_000000_049_user-already-landed-retry'
    const worktree = await makeAlreadyLandedTask(taskId)
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const forge = { issueClosingCommitMessage: (message: string) => message }
    let attempts = 0
    const onNoChange = vi.fn(async () => {
      if (++attempts === 1) throw new Error('forge unavailable')
    })

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 318, forge, onNoChange,
    })).rejects.toThrow('Could not reconcile the no-change verdict: forge unavailable')

    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(existsSync(worktree)).toBe(true)
    expect(rebaseEmptiedMarkerPresent(paths, taskId)).toBe(true)

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 318, forge, onNoChange,
    })).resolves.toEqual({ outcome: 'no-change' })

    expect(onNoChange).toHaveBeenCalledTimes(2)
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(worktree)).toBe(false)
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
    expect(rebaseEmptiedMarkerPresent(paths, taskId)).toBe(false)
  })

  it('retries a linked task a rebase emptied as no-change after a forge rate limit', async () => {
    const taskId = '20260808_000000_050_user-already-landed-limited'
    const worktree = await makeAlreadyLandedTask(taskId)
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const forge = { issueClosingCommitMessage: (message: string) => message }
    const rateLimit = new ForgeRateLimitError(new Date('2026-08-08T13:00:00Z'))
    let attempts = 0
    const onNoChange = vi.fn(async () => {
      if (++attempts === 1) throw rateLimit
    })

    const first = await mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 318, forge, onNoChange,
    }).catch((error: unknown) => error)
    expect(first).toBeInstanceOf(NoChangeReconciliationError)
    expect((first as NoChangeReconciliationError).cause).toBe(rateLimit)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(existsSync(worktree)).toBe(true)

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 318, forge, onNoChange,
    })).resolves.toEqual({ outcome: 'no-change' })

    expect(onNoChange).toHaveBeenCalledTimes(2)
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(worktree)).toBe(false)
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
    expect(rebaseEmptiedMarkerPresent(paths, taskId)).toBe(false)
  })

  it('stops a task with empty commits and no verdict although another task has a rebase record', async () => {
    const otherId = '20260808_000000_051_user-other-already-landed'
    recordRebaseEmptiedMarker(paths, otherId)
    const taskId = '20260808_000000_052_user-empty-commit-beside-record'
    const worktree = await makeCompletedTask(taskId)
    git(worktree, ['commit', '-q', '--allow-empty', '-m', 'chore: record nothing'])
    const initialHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const onNoChange = vi.fn(async () => {})

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 318, onNoChange,
      forge: { issueClosingCommitMessage: (message) => message },
    })).rejects.toThrow(/has only empty commits/)

    expect(onNoChange).not.toHaveBeenCalled()
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(initialHead)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(rebaseEmptiedMarkerPresent(paths, taskId)).toBe(false)
    expect(rebaseEmptiedMarkerPresent(paths, otherId)).toBe(true)
  })

  it('completes a scan without commits and without recording a merge', async () => {
    const taskId = '20260808_000000_004_scan'
    const worktree = await makeCompletedTask(taskId)
    const initialHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .resolves.toEqual({ outcome: 'no-change' })

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(initialHead)
    expect(existsSync(worktree)).toBe(false)
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
    expect(readStatus(paths, taskId)?.merge_commit).toBeUndefined()
  })

  it('closes the linked issues of a commit-less inspection directly', async () => {
    const taskId = '20260808_000000_033_user-inspect-linked'
    mkdirSync(join(paths.queueDir, 'inspect'), { recursive: true })
    writeFileSync(join(paths.queueDir, 'inspect', taskId), '')
    // Work that landed after the inspection started: a no-op merge would leave HEAD here.
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(join(repoRoot, 'unrelated.txt'), 'earlier work\n')
    git(repoRoot, ['add', 'unrelated.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: unrelated earlier work'])
    const unrelatedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const forge = {
      issueClosingCommitMessage: (message: string, issue: number) => `${message} (closes #${issue})`,
    }

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 412, forge,
    })).rejects.toThrow('A linked no-change task requires issue reconciliation.')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(existsSync(worktree)).toBe(true)

    const onNoChange = vi.fn(async () => {
      expect(readStatus(paths, taskId)?.status).toBe('completed')
    })
    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 412, forge, onNoChange,
    })).resolves.toEqual({ outcome: 'no-change' })

    expect(onNoChange).toHaveBeenCalledOnce()
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(unrelatedHead)
    expect(git(repoRoot, ['log', '--format=%s']).trim()).not.toContain('closes #412')
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
    expect(readStatus(paths, taskId)?.merge_commit).toBeUndefined()
  })

  it('refuses to record a merge that left the run branch where it was', async () => {
    const taskId = '20260808_000000_034_user-merge-without-commit'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string =>
        cwd === paths.repoRoot && args[0] === 'merge' && args[1] === '--quiet' ? '' : git(cwd, args),
    }

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, mergeRuntime,
    })).rejects.toThrow(`Merging ${branchName(taskId)} created no commit on main.`)

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('refuses a task that is not completed', async () => {
    const taskId = '20260808_000000_005_user-still-going'
    await makeCompletedTask(taskId, { commit: true })
    await writeStatus(paths, taskId, 'running', process.pid)
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .rejects.toThrow(/not 'completed'/)
  })

  it('aborts the merge when the explicit test command fails', async () => {
    const taskId = '20260808_000000_006_user-tests-fail'
    await makeCompletedTask(taskId, { commit: true })
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject, testCmd: 'node -e "process.exit(1)"' }))
      .rejects.toThrow(/Tests failed/)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('rejects a successful explicit test that borrowed dependencies', async () => {
    const taskId = '20260808_000000_019_user-test-borrows-dependencies'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'fixture-dependency': '^1.0.0' },
    }, null, 2)}\n`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare an uninstalled test dependency'])
    const outputFile = join(repoRoot, 'merge-check.log')

    const failure = await mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
      testCmd: 'node -e "process.exit(0)"',
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(MergeError)
    expect(failure).not.toBeInstanceOf(VerificationFailedError)
    expect((failure as Error).message)
      .toBe('Tests passed against borrowed dependencies. Aborting merge.')

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain('the worktree: passed on dependencies it does not have')
    expect(output).toContain('fixture-dependency')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('names the failing check and its exit status before aborting the merge', async () => {
    const taskId = '20260808_000000_032_user-reports-check-status'
    await makeCompletedTask(taskId, { commit: true })
    const outputFile = join(repoRoot, 'failing-check.log')
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'failing-check',
      mergeChecks: () => [
        { label: 'Passing check', cwd: '', command: 'node -e "process.exit(0)"' },
        { label: 'Crashing check', cwd: '', command: 'node -e "process.exit(3)"' },
      ],
    }

    await expect(mergeTask(paths, taskId, { taskGate: 'light', project, outputFile }))
      .rejects.toThrow('Tests failed. Aborting merge.')

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain('=== Crashing check failed: exit status 3 ===')
    expect(output).not.toContain('Passing check failed')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('reports an explicit test command exit status before aborting the merge', async () => {
    const taskId = '20260808_000000_033_user-reports-test-command-status'
    await makeCompletedTask(taskId, { commit: true })
    const outputFile = join(repoRoot, 'failing-test-command.log')

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, outputFile, testCmd: 'node -e "process.exit(2)"',
    })).rejects.toThrow('Tests failed. Aborting merge.')

    expect(readFileSync(outputFile, 'utf8')).toContain('=== Tests failed: exit status 2 ===')
  })
})

describe('completeTaskWithoutChanges refusals', () => {
  const noChangeMessage = 'No implementation is needed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n'

  async function expectRefusal(taskId: string, baseRef: string, message: string): Promise<void> {
    const before = readStatus(paths, taskId)
    const onNoChange = vi.fn(async () => {})

    const failure = await completeTaskWithoutChanges(paths, taskId, baseRef, { onNoChange })
      .then(() => undefined, (error: unknown) => error)

    expect(failure).toBeInstanceOf(MergeError)
    expect((failure as MergeError).message).toBe(message)
    expect(onNoChange).not.toHaveBeenCalled()
    expect(existsSync(worktreeDir(paths, taskId))).toBe(true)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).not.toBe('')
    expect(readStatus(paths, taskId)).toEqual(before)
  }

  it('refuses a task that has no status', async () => {
    const taskId = '20261111_181522_101_user-no-change-unknown'
    git(repoRoot, ['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    const baseRef = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expectRefusal(taskId, baseRef, `Task not found: ${taskId}`)
    expect(readStatus(paths, taskId)).toBeUndefined()
  })

  it('refuses a task whose status is not completed', async () => {
    const taskId = '20261111_181522_102_user-no-change-failed'
    await makeCompletedTask(taskId)
    await writeStatus(paths, taskId, 'failed')
    writeFileSync(finalMessageFile(paths, taskId), noChangeMessage)
    const baseRef = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expectRefusal(taskId, baseRef, "Task status is not 'completed' (current: failed).")
    expect(readStatus(paths, taskId)?.status).toBe('failed')
  })

  it('refuses a task that did not report the no-change marker', async () => {
    const taskId = '20261111_181522_103_user-no-change-unmarked'
    await makeCompletedTask(taskId)
    writeFileSync(finalMessageFile(paths, taskId), 'No implementation is needed.\nTASK_COMPLETE\n')
    const baseRef = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expectRefusal(taskId, baseRef, `${taskId} did not report NO_CHANGE_WARRANTED.`)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('refuses a worktree with uncommitted changes', async () => {
    const taskId = '20261111_181522_104_user-no-change-dirty'
    const worktree = await makeCompletedTask(taskId, { dirty: true })
    writeFileSync(finalMessageFile(paths, taskId), noChangeMessage)
    const baseRef = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expectRefusal(taskId, baseRef, `The worktree has uncommitted changes: ${worktree}`)
    expect(existsSync(join(worktree, 'uncommitted.txt'))).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('refuses a task branch with commits ahead of the base', async () => {
    const taskId = '20261111_181522_105_user-no-change-committed'
    const baseRef = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const taskHead = git(worktree, ['rev-parse', 'HEAD']).trim()
    writeFileSync(finalMessageFile(paths, taskId), noChangeMessage)

    await expectRefusal(
      taskId, baseRef, `${taskId} has commits and cannot complete without changes.`,
    )
    expect(git(repoRoot, ['rev-parse', branchName(taskId)]).trim()).toBe(taskHead)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('refuses an empty base instead of reading it as HEAD..HEAD', async () => {
    const taskId = '20261111_181522_106_user-no-change-empty-base'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const taskHead = git(worktree, ['rev-parse', 'HEAD']).trim()
    writeFileSync(finalMessageFile(paths, taskId), noChangeMessage)

    await expectRefusal(taskId, '', `${taskId} has no base to compare against.`)
    expect(git(repoRoot, ['rev-parse', branchName(taskId)]).trim()).toBe(taskHead)
  })

  it('refuses a base that does not name a commit', async () => {
    const taskId = '20261111_181522_107_user-no-change-unknown-base'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const taskHead = git(worktree, ['rev-parse', 'HEAD']).trim()
    writeFileSync(finalMessageFile(paths, taskId), noChangeMessage)

    await expectRefusal(
      taskId, 'refs/heads/missing', `${taskId} base refs/heads/missing does not name a commit.`,
    )
    expect(git(repoRoot, ['rev-parse', branchName(taskId)]).trim()).toBe(taskHead)
  })
})
