import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import {
  completeTaskWithoutChanges, MergeError, mergeTask, UnverifiedRunnerError,
} from '../src/merge.ts'
import { branchName, finalMessageFile } from '../src/paths.ts'
import { taskProcessPid } from '../src/processRegistry.ts'
import { readStatus, writeStatus } from '../src/status.ts'
import {
  failedWorktreeRemovalRuntime, git, makeCompletedTask, noCheckProject, paths, repoRoot,
  staleMetadataRemovalRuntime, testProcesses, waitForFile,
} from './mergeHarness.ts'
import { stubProject } from './stubProject.ts'

describe('mergeTask', () => {
  it('recognizes an applied merge whose reasons have changed since', async () => {
    const taskId = '20260808_000000_029_user-edited-reason'
    await makeCompletedTask(taskId, { commit: true })
    git(repoRoot, [
      'merge', '--quiet', '--no-ff', branchName(taskId),
      '-m', `Merge ${taskId} via orchestration\n\nWhy: the requirement as it first read.`,
    ])
    const appliedCommit = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, reasons: ['The requirement as edited later.'],
    })).resolves.toEqual({ outcome: 'merged', mergeCommit: appliedCommit })
  })

  it('reports manual cleanup when a merged worktree could not be removed', async () => {
    const taskId = '20260808_000000_026_user-retained-merged-worktree'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const outputFile = join(repoRoot, 'merge-output.log')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
      worktreeRemovalRuntime: failedWorktreeRemovalRuntime(),
    })

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain(
      `WARN: merged, but the worktree is still there and has to go by hand: ${worktree}`,
    )
    expect(output).toContain(`Merged ${taskId}; manual worktree cleanup remains: ${worktree}`)
    expect(output).not.toContain(`Merged ${taskId} and removed the worktree.`)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('removes the worktree and reports the merge when post-merge bookkeeping throws', async () => {
    const taskId = '20261115_034847_013_auto-throwing-on-merged'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const branch = branchName(taskId)
    const outputFile = join(repoRoot, 'throwing-on-merged-output.log')

    const result = await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
      onMerged: () => { throw new Error('EBUSY: resource busy or locked') },
    })

    expect(result).toMatchObject({ outcome: 'merged' })
    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain(`WARN: post-merge bookkeeping failed for ${taskId}: EBUSY`)
    expect(output).toContain(`Merged ${taskId} and removed the worktree.`)
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', branch]).trim()).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('ends processes left in the task worktree before removing it', async () => {
    const taskId = '20261029_040729_001_user-orphaned-worktree-shell'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const presentAtTermination = new Map<string, boolean>()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
      worktreeRemovalRuntime: {
        os: {
          ...operatingSystem,
          terminateWorktreeProcesses: (path) => {
            presentAtTermination.set(path, existsSync(path))
          },
        },
        git,
      },
    })).resolves.toMatchObject({ outcome: 'merged' })

    expect(presentAtTermination.get(worktree)).toBe(true)
    expect(existsSync(worktree)).toBe(false)
  })

  it('does not report merged cleanup while metadata and the task branch remain', async () => {
    const taskId = '20260820_205524_044_auto-retained-merged-metadata'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const branch = branchName(taskId)
    const outputFile = join(repoRoot, 'stale-merge-output.log')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
      worktreeRemovalRuntime: staleMetadataRemovalRuntime(),
    })

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain(`WARN: worktree metadata pruning failed for ${worktree}`)
    expect(output).toContain(`task branch remains: ${branch}`)
    expect(output).not.toContain(`Merged ${taskId} and removed the worktree.`)
    expect(git(repoRoot, ['worktree', 'list', '--porcelain']))
      .toContain(`branch refs/heads/${branch}`)
    expect(git(repoRoot, ['branch', '--list', branch]).trim()).not.toBe('')
  })

  it('stops and verifies a completed runner with a live PID before merging', async () => {
    const taskId = '20260808_000000_017_user-runner-finishes-output-first'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runnerReady = join(repoRoot, 'runner-ready')
    const runner = testProcesses.spawn(process.execPath, [
      '--input-type=module', '--eval',
      "const { writeFileSync } = await import('node:fs'); writeFileSync(process.argv[1], ''); setInterval(() => {}, 1000)",
      runnerReady,
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    const runnerPid = runner.pid
    if (runnerPid === undefined) throw new Error('Runner did not publish a PID.')
    runner.unref()
    await writeStatus(paths, taskId, 'completed', runnerPid)
    await waitForFile(runnerReady, 'Runner fixture did not become ready.')

    await mergeTask(paths, taskId, { taskGate: 'light', project: stubProject })

    expect(operatingSystem.processTreeIsAlive(runnerPid)).toBe(false)
    expect(existsSync(worktree)).toBe(false)
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(readStatus(paths, taskId)?.pid).toBeNull()
  })

  it('keeps completed task state when the runner cannot be verified stopped', async () => {
    const taskId = '20260808_000000_018_user-runner-resists-stop'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runnerPid = 12345
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue('started:runner')
    await writeStatus(paths, taskId, 'completed', runnerPid)
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree').mockReturnValue(true)
    vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(true)

    // A tree that resisted termination is a counted failure: unlike an unverifiable
    // runner, nothing here clears on its own.
    const failure = await mergeTask(paths, taskId, { taskGate: 'light', project: stubProject })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(MergeError)
    expect(failure).not.toBeInstanceOf(UnverifiedRunnerError)
    expect((failure as MergeError).message).toBe(
      `Could not stop completed runner ${runnerPid}; task state was retained.`,
    )

    expect(terminate).toHaveBeenCalledWith(runnerPid)
    expect(existsSync(worktree)).toBe(true)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).not.toBe('')
    expect(existsSync(join(repoRoot, `${taskId}.txt`))).toBe(false)
    expect(readStatus(paths, taskId)).toMatchObject({ status: 'completed', pid: runnerPid })
  })

  it('does not terminate an unverified runner before merging', async () => {
    const taskId = '20260815_120000_001_user-unverified-merge-runner'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runnerPid = 12345
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue(undefined)
    vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(true)
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree')
    await writeStatus(paths, taskId, 'completed', runnerPid)

    // A deferral, not a failure: the caller must be able to tell this from a gate that
    // judged the work, so it carries its own type and the PID it could not verify.
    const failure = await mergeTask(paths, taskId, { taskGate: 'light', project: stubProject })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(UnverifiedRunnerError)
    expect((failure as UnverifiedRunnerError).pid).toBe(runnerPid)
    expect((failure as UnverifiedRunnerError).message).toBe(
      `Could not verify completed runner ${runnerPid}; task state was retained.`,
    )

    expect(terminate).not.toHaveBeenCalled()
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)).toMatchObject({ status: 'completed', pid: runnerPid })
  })

  it('does not terminate an unverified runner before no-change completion', async () => {
    const taskId = '20260815_120000_002_user-unverified-no-change-runner'
    const worktree = await makeCompletedTask(taskId)
    const runnerPid = 12345
    writeFileSync(finalMessageFile(paths, taskId),
      'No implementation is needed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue(undefined)
    vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(true)
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree')
    await writeStatus(paths, taskId, 'completed', runnerPid)

    const failure = await completeTaskWithoutChanges(
      paths, taskId, git(repoRoot, ['rev-parse', 'HEAD']).trim(),
    ).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(UnverifiedRunnerError)
    expect((failure as UnverifiedRunnerError).pid).toBe(runnerPid)
    expect((failure as UnverifiedRunnerError).message).toBe(
      `Could not verify completed runner ${runnerPid}; task state was retained.`,
    )

    expect(terminate).not.toHaveBeenCalled()
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)).toMatchObject({ status: 'completed', pid: runnerPid })
  })

  it('forgets a stopped runner before a failed-check merge is retried', async () => {
    const taskId = '20260808_000000_027_user-failed-check-retry'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runnerPid = 12345
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue('started:runner')
    await writeStatus(paths, taskId, 'completed', runnerPid)
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree').mockReturnValue(true)
    vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(false)
    const options = {
      taskGate: 'light' as const,
      project: stubProject,
      testCmd: 'node -e "process.exit(1)"',
    }

    await expect(mergeTask(paths, taskId, options)).rejects.toThrow('Tests failed')

    expect(taskProcessPid(paths, taskId)).toBeUndefined()
    expect(readStatus(paths, taskId)).toMatchObject({ status: 'completed', pid: null })
    expect(existsSync(worktree)).toBe(true)

    await expect(mergeTask(paths, taskId, options)).rejects.toThrow('Tests failed')
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  it('leaves linked-issue closing syntax to the forge adapter', async () => {
    const taskId = '20260808_000000_015_user-linked-issue'
    await makeCompletedTask(taskId, { commit: true })

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: stubProject,
      closesIssue: 317,
      forge: {
        issueClosingCommitMessage: (message, issueNumber) =>
          `${message} (resolves ticket ${issueNumber})`,
      },
    })

    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via orchestration (resolves ticket 317)`,
    )
  })

})
