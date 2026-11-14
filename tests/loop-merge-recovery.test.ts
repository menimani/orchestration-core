import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ForgeIssueNotFoundError } from '../src/adapters/forge.ts'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { operatingSystem } from '../src/adapters/os.ts'
import {
  buildIssueBody, issueCompletionForIssue, issueNumbersForTask, issuePromotionForIssue,
  issueReleaseIntentForTask, recordIssuesForTask, LABEL_FINDING, LABEL_GROUP_SINGLETON,
  LABEL_IN_PROGRESS, LABEL_MERGE_READY, LABEL_READY, LABEL_RETRY_EXHAUSTED,
} from '../src/issueQueue.ts'
import { recordTaskIdForDesc, shortTaskId } from '../src/ids.ts'
import {
  issueConflictKey, readConflictedAttempts, writeConflictedAttempts,
} from '../src/conflictRetry.ts'
import {
  pendingOrchestrationDepsFile, syncOrchestrationDepsAtStartup, TEST_LOCK_BUSY_EXIT_CODE,
} from '../src/merge.ts'
import { branchName, conflictBranchName, worktreeDir } from '../src/paths.ts'
import { forgetTaskProcess } from '../src/processRegistry.ts'
import { currentProcessStartIdentity } from '../src/processOwner.ts'
import { readStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'
import { releasePreparationForTask } from './releasePreparation.ts'
import {
  backlogEntries, fakeForge, git, initializeGitRepo, initializeGitRepoWithRemote, logText,
  logged, makeCompletedTask, makeLoop, paths, registerLoopHooks, repoRoot, runnerStarts,
  setLogged, stubProject, writeFinal, writeRawStatus,
} from './loopHarness.ts'

const cleanupFailure = vi.hoisted(() => ({ taskId: undefined as string | undefined }))

// Cleanup runs unchanged unless a test names a task whose cleanup must fail once.
vi.mock('../src/cleanup.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cleanup.ts')>()
  return {
    ...actual,
    cleanupTask: (...args: Parameters<typeof actual.cleanupTask>) => {
      if (args[1] === cleanupFailure.taskId) {
        cleanupFailure.taskId = undefined
        throw new Error('worktree is locked')
      }
      actual.cleanupTask(...args)
    },
  }
})

const mergedStatusFailure = vi.hoisted(() => ({
  taskId: undefined as string | undefined,
  onWrite: undefined as (() => void) | undefined,
}))

// Recording a merge runs unchanged unless a test names a task whose process must die
// right after the merged status reaches disk.
vi.mock('../src/status.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/status.ts')>()
  return {
    ...actual,
    writeMergedStatus: async (...args: Parameters<typeof actual.writeMergedStatus>) => {
      if (args[1] !== mergedStatusFailure.taskId) return actual.writeMergedStatus(...args)
      mergedStatusFailure.taskId = undefined
      mergedStatusFailure.onWrite?.()
      await actual.writeMergedStatus(...args)
      throw new Error('process stopped after recording the merge')
    },
  }
})

const branchLookupFailure = vi.hoisted(() => ({ ref: undefined as string | undefined }))
const currentBranchLookup = vi.hoisted(() => ({ unreadable: false }))

// Git runs unchanged unless a test names a ref whose existence check must fail with an
// error other than "absent", or makes the checkout's current branch read as nothing.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = ((...args: Parameters<typeof actual.execFileSync>) => {
    const [file, gitArgs] = args
    if (file === 'git' && Array.isArray(gitArgs) && gitArgs.join(' ') === 'branch --show-current'
      && currentBranchLookup.unreadable) {
      return ''
    }
    if (file === 'git' && Array.isArray(gitArgs) && gitArgs[0] === 'show-ref'
      && branchLookupFailure.ref !== undefined && gitArgs.includes(branchLookupFailure.ref)) {
      throw Object.assign(new Error('fatal: unable to read refs'), { status: 128 })
    }
    return actual.execFileSync(...args)
  }) as typeof actual.execFileSync
  return { ...actual, execFileSync }
})

registerLoopHooks()

describe('completed task merge recovery', () => {
  function makeDependencyChangingTask(taskId: string): string {
    initializeGitRepo()
    writeFileSync(join(repoRoot, 'package.json'), '{"private":true}\n')
    writeFileSync(join(repoRoot, 'package-lock.json'), '{"lockfileVersion":3}\n')
    git(['add', 'package.json', 'package-lock.json'])
    git(['commit', '-m', 'chore: add dependency manifests'])
    makeCompletedTask(taskId)
    const worktree = worktreeDir(paths, taskId)
    writeFileSync(
      join(worktree, 'package-lock.json'),
      '{"lockfileVersion":3,"packages":{"node_modules/new-dependency":{}}}\n',
    )
    execFileSync('git', ['add', 'package-lock.json'], { cwd: worktree })
    execFileSync('git', ['commit', '-qm', 'fix: update dependencies'], { cwd: worktree })
    return worktree
  }

  it('persists pending dependency installation and stops when a task process tree survives', async () => {
    const taskId = '20260820_181834_032_auto-dependency-installation'
    makeDependencyChangingTask(taskId)
    const oldDependency = join(repoRoot, 'node_modules', 'old-dependency', 'package.json')
    mkdirSync(dirname(oldDependency), { recursive: true })
    writeFileSync(oldDependency, '{}\n')
    const install = vi.fn(() => rmSync(join(repoRoot, 'node_modules'), {
      recursive: true, force: true,
    }))
    const survivor = {
      taskId: '20260820_181800_031_auto-parallel-worker', pid: 43120,
      error: 'Could not stop process tree 43120.',
    }
    const loop = makeLoop(
      { autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0 },
      stubProject,
      { install, packageRoot: repoRoot },
      undefined,
      undefined,
      undefined,
      () => ({ terminated: [], failures: [survivor] }),
    )
    loop.initializeSessionStateForBranch()

    await expect(loop.poll()).rejects.toThrow(
      /dependency installation after 032_auto remains pending.*live task process tree survived/,
    )

    expect(install).not.toHaveBeenCalled()
    expect(readFileSync(oldDependency, 'utf8')).toBe('{}\n')
    expect(logText()).toContain(
      'dependency installation skipped; process tree 031_auto PID 43120 survived',
    )
    expect(logged).toContain(
      'Skipped orchestration deps  after 032_auto; a live task process tree survived',
    )
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    const pendingFile = pendingOrchestrationDepsFile(paths, repoRoot)
    expect(existsSync(pendingFile)).toBe(true)

    const retryInstall = vi.fn()
    syncOrchestrationDepsAtStartup(paths, vi.fn(), {
      install: retryInstall, packageRoot: repoRoot,
    })

    expect(retryInstall).toHaveBeenCalledOnce()
    expect(existsSync(pendingFile)).toBe(false)
  })

  it('installs dependencies after every task process tree stops cleanly', async () => {
    const taskId = '20260820_181835_033_auto-clean-dependency-installation'
    makeDependencyChangingTask(taskId)
    const install = vi.fn()
    const stopped = {
      taskId: '20260820_181801_034_auto-parallel-worker', pid: 43121,
    }
    const loop = makeLoop(
      { autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0 },
      stubProject,
      { install, packageRoot: repoRoot },
      undefined,
      undefined,
      undefined,
      () => ({ terminated: [stopped], failures: [] }),
    )
    loop.initializeSessionStateForBranch()

    expect(await loop.poll()).toBe('continue')

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(repoRoot)
    expect(logText()).toContain(
      'Stopped 034_auto    process tree PID 43121 before dependency installation',
    )
    expect(logged).toContain('Installed orchestration deps  after 033_auto')
  })

  it('records a merged issue under the run branch its merged status holds', async () => {
    const taskId = '20260820_181836_035_auto-unreadable-branch-after-merge'
    makeDependencyChangingTask(taskId)
    // The checkout stops answering only once the merge is recorded and its install runs.
    const install = vi.fn(() => {
      currentBranchLookup.unreadable = true
    })
    const loop = makeLoop(
      { autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0 },
      stubProject,
      { install, packageRoot: repoRoot },
      undefined,
      undefined,
      undefined,
      () => ({ terminated: [], failures: [] }),
    )
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'merged fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])

    try {
      expect(await loop.poll()).toBe('continue')
    } finally {
      currentBranchLookup.unreadable = false
    }

    expect(install).toHaveBeenCalledOnce()
    expect(readStatus(paths, taskId)).toMatchObject({ status: 'merged', run_branch: 'main' })
    expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({
      taskId, runBranch: 'main', commentConfirmed: true,
    })
    expect(fakeForge.issueComments.get(issueNumber)?.join('\n'))
      .toContain('into run branch main.')
    expect(logText()).not.toContain(`could not reconcile issue #${issueNumber}`)
  })

  it('does not count task trees stopped for a dependency install as a failure burst', async () => {
    const taskId = '20260820_181837_036_auto-burst-dependency-installation'
    makeDependencyChangingTask(taskId)
    const stoppedIds = [
      '20260820_181802_037_auto-parallel-worker',
      '20260820_181803_038_auto-parallel-worker',
      '20260820_181804_039_auto-parallel-worker',
    ]
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const install = vi.fn()
    const loop = makeLoop(
      {
        autoMerge: true, issueQueueEnabled: true, scanEnabled: false,
        maxParallel: 0, maxBurstFailures: 3,
      },
      stubProject,
      { install, packageRoot: repoRoot },
      undefined,
      undefined,
      undefined,
      () => {
        // Termination drops each registry entry, as the real stop does.
        stoppedIds.forEach((stoppedId) => writeRawStatus(stoppedId, 'running', null))
        return {
          terminated: stoppedIds.map((stoppedId, index) => ({
            taskId: stoppedId, pid: 43122 + index,
          })),
          failures: [],
        }
      },
    )
    loop.initializeSessionStateForBranch()
    stoppedIds.forEach((stoppedId) => writeRawStatus(stoppedId, 'running', process.pid))

    expect(await loop.poll()).toBe('continue')

    expect(install).toHaveBeenCalledOnce()
    // The merge runs after this poll refreshed its tasks; the next poll finds them dead.
    expect(await loop.poll()).toBe('continue')

    for (const stoppedId of stoppedIds) {
      expect(readStatus(paths, stoppedId)?.status).toBe('failed')
    }
    expect(readFileSync(join(paths.queueDir, 'failed-1'), 'utf8').trim().split('\n'))
      .toEqual(stoppedIds)
    expect(logText()).not.toContain('tasks failed in one poll')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    // The exemption is spent once reported: the same tasks failing again count.
    for (const stoppedId of stoppedIds) {
      rmSync(join(paths.queueDir, 'scanned', `${stoppedId}.failed`))
      writeRawStatus(stoppedId, 'running', null)
    }
    setLogged([])

    expect(await loop.poll()).toBe('continue')
    expect(logText()).toContain('ERROR 3 tasks failed in one poll; stopping for environment repair')
  })

  it('reopens the waiting gate before a failed dependency install stops the loop', async () => {
    const taskId = '20260820_181836_035_auto-gate-dependency-installation'
    makeDependencyChangingTask(taskId)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    writeFileSync(join(paths.queueDir, 'cycle-complete-1'), '')
    writeFileSync(join(paths.queueDir, 'cycle-resume-1'), '')
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '2\n')
    const install = vi.fn(() => {
      throw new Error('npm ci failed')
    })
    const loop = makeLoop(
      { autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0 },
      stubProject,
      { install, packageRoot: repoRoot },
      undefined,
      undefined,
      undefined,
      () => ({ terminated: [], failures: [] }),
    )
    loop.initializeSessionStateForBranch()

    await expect(loop.poll()).rejects.toThrow(
      /Orchestration dependency installation after 035_auto failed/,
    )

    // A restart finds the task merged and never returns to the merge, so the gate
    // must already have been told about the new commits.
    expect(install).toHaveBeenCalledOnce()
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'cycle-resume-1'))).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('0\n')
  })

  it('reopens the waiting gate before the merged status is recorded', async () => {
    const taskId = '20260820_181837_036_auto-gate-before-merged-status'
    initializeGitRepo()
    makeCompletedTask(taskId)
    const completeFlag = join(paths.queueDir, 'cycle-complete-1')
    const resumeFlag = join(paths.queueDir, 'cycle-resume-1')
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    writeFileSync(completeFlag, '')
    writeFileSync(resumeFlag, '')
    let flagsAtRecord: boolean[] = []
    mergedStatusFailure.taskId = taskId
    mergedStatusFailure.onWrite = () => {
      flagsAtRecord = [existsSync(completeFlag), existsSync(resumeFlag)]
    }
    const loopConfig = {
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    }
    const loop = makeLoop(loopConfig)
    loop.initializeSessionStateForBranch()

    await loop.poll().catch(() => undefined)

    expect(flagsAtRecord).toEqual([false, false])
    expect(readStatus(paths, taskId)?.status).toBe('merged')

    // A restart finds the task merged and skips it, so the gate must run again on the
    // flags alone.
    setLogged([])
    const restarted = makeLoop(loopConfig)
    expect(await restarted.poll()).toBe('continue')

    expect(logText()).not.toContain(`Merging ${shortTaskId(taskId)}`)
    expect(existsSync(completeFlag)).toBe(false)
    expect(existsSync(resumeFlag)).toBe(false)
  })

  it('stops without recording a failure when a failed rebase leaves the task worktree mid-rebase', async () => {
    const taskId = '20260815_181909_195_auto-stuck-rebase'
    initializeGitRepo()
    makeCompletedTask(taskId)
    const worktree = worktreeDir(paths, taskId)
    const taskTip = git(['rev-parse', 'HEAD'], worktree)
    writeFileSync(join(repoRoot, 'run.txt'), 'newer run work\n')
    git(['add', 'run.txt'])
    git(['commit', '-m', 'fix: advance run branch'])
    const runHead = git(['rev-parse', 'HEAD'])
    // Rebase state without a head-name: the rebase refuses to start and the abort fails.
    const rebaseState = git(['rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge'], worktree)
    mkdirSync(rebaseState, { recursive: true })
    writeFileSync(join(rebaseState, 'interactive'), '')
    const loop = makeLoop({ autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0 })
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '1\n')

    await expect(loop.poll()).rejects.toThrow(
      /^Rebasing the task onto main failed and the abort did not restore the task worktree: .*rebase is still in progress; rebase abort failed: /,
    )

    // A failed record would let the next poll merge into a worktree still mid-rebase.
    expect(logged).toContain('Merging 195_auto')
    expect(logged.some((line) => line.startsWith('Failed 195_auto'))).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('1\n')
    expect(readFileSync(join(paths.logsDir, `${taskId}.merge.log`), 'utf8')).toMatch(
      /Rebasing the task onto main failed and the abort did not restore the task worktree/,
    )
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(['rev-parse', 'HEAD'])).toBe(runHead)
    expect(git(['rev-parse', branchName(taskId)])).toBe(taskTip)
  })

  it('stops without recording a failure when the run checkout already has a merge in progress', async () => {
    const taskId = '20260815_181910_196_auto-merge-in-progress'
    initializeGitRepo()
    makeCompletedTask(taskId)
    const runHead = git(['rev-parse', 'HEAD'])
    const mergeHead = git(['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'])
    writeFileSync(mergeHead, `${runHead}\n`)
    const loop = makeLoop({ autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0 })
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '1\n')

    await expect(loop.poll()).rejects.toThrow(
      'The integration worktree already has a merge in progress. '
      + 'Inspect and restore it before restarting orchestration.',
    )

    expect(logged).toContain('Merging 196_auto')
    expect(logged.some((line) => line.startsWith('Failed 196_auto'))).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('1\n')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(['rev-parse', 'HEAD'])).toBe(runHead)
    expect(existsSync(mergeHead)).toBe(true)
  })

  it('stops a remote adoption without relabelling when the run checkout has a merge in progress', async () => {
    const taskId = '20260815_181911_197_auto-remote-merge-in-progress'
    initializeGitRepoWithRemote()
    git(['switch', '-c', branchName(taskId)])
    writeFileSync(join(repoRoot, 'remote.txt'), 'remote work\n')
    git(['add', 'remote.txt'])
    git(['commit', '-m', 'fix: add remote work'])
    const taskHead = git(['rev-parse', 'HEAD'])
    git(['push', 'origin', branchName(taskId)])
    git(['switch', 'main'])
    const runHead = git(['rev-parse', 'HEAD'])
    const loop = makeLoop({ autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0 })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'remote work', body: '', labels: [LABEL_FINDING, LABEL_MERGE_READY],
    })
    await fakeForge.commentIssue(
      issueNumber, `Branch: ${branchName(taskId)}\nHead commit: ${taskHead}`,
    )
    const commentsBefore = fakeForge.issueComments.get(issueNumber)?.length
    const mergeHead = git(['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'])
    writeFileSync(mergeHead, `${runHead}\n`)
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '1\n')

    await expect(loop.poll()).rejects.toThrow(
      'The integration worktree already has a merge in progress. '
      + 'Inspect and restore it before restarting orchestration.',
    )

    // A failed adoption would relabel the issue and let the next one merge into this state.
    expect(logged).toContain('Merging 197_auto')
    expect(logged.some((line) => line.startsWith('Failed 197_auto'))).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('1\n')
    expect(fakeForge.issueComments.get(issueNumber)?.length).toBe(commentsBefore)
    expect(fakeForge.issues.get(issueNumber)?.labels).toEqual([LABEL_FINDING, LABEL_MERGE_READY])
    expect(git(['rev-parse', 'HEAD'])).toBe(runHead)
  })

  it('releases an issue task after its first conflicting rebase and keeps its commits', async () => {
    const taskId = '20260815_181908_194_auto-rebase-conflict'
    const initialHead = initializeGitRepo()
    makeCompletedTask(taskId)
    const worktree = worktreeDir(paths, taskId)
    writeFileSync(join(worktree, 'tracked.txt'), 'task change\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: worktree })
    execFileSync('git', ['commit', '-qm', 'fix: change tracked line'], { cwd: worktree })
    const taskTip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim()
    writeFileSync(join(repoRoot, 'tracked.txt'), 'run change\n')
    git(['add', 'tracked.txt'])
    git(['commit', '-m', 'fix: advance run branch'])
    const runHead = git(['rev-parse', 'HEAD'])
    expect(runHead).not.toBe(initialHead)

    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'conflicting fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)).toBeUndefined()
    expect(existsSync(worktree)).toBe(false)
    expect(git(['branch', '--list', branchName(taskId)])).toBe('')
    expect(git(['rev-parse', 'HEAD'])).toBe(runHead)
    expect(issueNumbersForTask(paths, taskId)).toEqual([])
    await expect(fakeForge.getIssue(issueNumber)).resolves.toMatchObject({
      assignees: [],
      labels: expect.arrayContaining([LABEL_FINDING, LABEL_READY]),
    })
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('1\n')
    expect(logged.filter((line) => line.startsWith('Merging 194_auto'))).toHaveLength(1)
    expect(logged).toContain(
      `Released 194_auto    rebase conflict abandoned; commits kept on ${conflictBranchName(taskId)}`,
    )
    expect(git(['rev-parse', conflictBranchName(taskId)])).toBe(taskTip)
    expect(readConflictedAttempts(paths, issueConflictKey(issueNumber))).toEqual([{
      taskId,
      branch: conflictBranchName(taskId),
      runBranch: 'main',
      runTip: runHead,
      base: initialHead,
      taskTip,
      conflictedFiles: ['tracked.txt'],
      conflictingCommits: [runHead],
    }])
    expect(backlogEntries()).toEqual([])

    expect(await loop.poll()).toBe('continue')

    expect(git(['rev-parse', 'HEAD'])).toBe(runHead)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('1\n')
    expect(logged.filter((line) => line.startsWith('Merging 194_auto'))).toHaveLength(1)
  })

  it('parks an issue whose conflict chain uses its retries and keeps every branch', async () => {
    const taskId = '20260815_181908_193_auto-rebase-conflict'
    const initialHead = initializeGitRepo()
    makeCompletedTask(taskId)
    const worktree = worktreeDir(paths, taskId)
    writeFileSync(join(worktree, 'tracked.txt'), 'task change\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: worktree })
    execFileSync('git', ['commit', '-qm', 'fix: change tracked line'], { cwd: worktree })
    writeFileSync(join(repoRoot, 'tracked.txt'), 'run change\n')
    git(['add', 'tracked.txt'])
    git(['commit', '-m', 'fix: advance run branch'])
    const earlier = ['20260815_150000_101_auto-rebase-conflict', '20260815_160000_102_auto-rebase-conflict']
      .map((earlierId) => {
        git(['branch', conflictBranchName(earlierId), initialHead])
        return {
          taskId: earlierId,
          branch: conflictBranchName(earlierId),
          runBranch: 'main',
          runTip: initialHead,
          base: initialHead,
          taskTip: initialHead,
          conflictedFiles: ['tracked.txt'],
          conflictingCommits: [],
        }
      })
    // The claim handed this task the chain its issue had already used up to the limit.
    writeConflictedAttempts(paths, taskId, earlier)

    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'conflicting fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])

    expect(await loop.poll()).toBe('continue')

    const issue = await fakeForge.getIssue(issueNumber)
    expect(issue.labels).toContain(LABEL_RETRY_EXHAUSTED)
    expect(issue.labels).not.toContain(LABEL_READY)
    expect(issue.labels).not.toContain(LABEL_IN_PROGRESS)
    expect(issue.assignees).toEqual([])
    expect(issueReleaseIntentForTask(paths, taskId)).toEqual([])
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    for (const { branch } of earlier) expect(git(['branch', '--list', branch])).not.toBe('')
    expect(git(['branch', '--list', conflictBranchName(taskId)])).not.toBe('')
    expect(readConflictedAttempts(paths, issueConflictKey(issueNumber)).map(({ taskId: id }) => id))
      .toEqual([...earlier.map(({ taskId: id }) => id), taskId])
    expect(logged).toContain(
      `Abandoned 193_auto    rebase conflict retries exhausted; commits kept on ${conflictBranchName(taskId)}`,
    )
    expect(logText()).toContain(`Parked #${issueNumber}`)
    expect(backlogEntries()).toEqual([])
  })

  it('cancels the issue release preparation when rebase-conflict cleanup fails', async () => {
    const taskId = '20260815_181908_198_auto-rebase-conflict'
    initializeGitRepo()
    makeCompletedTask(taskId)
    const worktree = worktreeDir(paths, taskId)
    writeFileSync(join(worktree, 'tracked.txt'), 'task change\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: worktree })
    execFileSync('git', ['commit', '-qm', 'fix: change tracked line'], { cwd: worktree })
    writeFileSync(join(repoRoot, 'tracked.txt'), 'run change\n')
    git(['add', 'tracked.txt'])
    git(['commit', '-m', 'fix: advance run branch'])

    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'conflicting fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    cleanupFailure.taskId = taskId

    expect(await loop.poll()).toBe('continue')

    expect(cleanupFailure.taskId).toBeUndefined()
    expect(logText()).toContain(
      '198_auto rebase conflict was abandoned but cleanup or issue release failed: worktree is locked',
    )
    expect(readStatus(paths, taskId)?.status).toBe('failed')
    expect(issueNumbersForTask(paths, taskId)).toEqual([issueNumber])
    expect(releasePreparationForTask(paths, taskId)).toEqual([])
    expect(issueReleaseIntentForTask(paths, taskId)).toEqual([])
  })

  /** A completed local task whose only commit conflicts with a later run-branch commit. */
  function makeConflictingLocalTask(taskId: string): {
    initialHead: string
    runHead: string
    taskTip: string
  } {
    const initialHead = initializeGitRepo()
    makeCompletedTask(taskId)
    writeFileSync(specFile(paths, taskId), [
      `# ${taskId}: delegated task`,
      '',
      '## Requirement',
      '',
      'Change the tracked line.',
      '',
      'TASK_COMPLETE',
      '',
    ].join('\n'))
    const worktree = worktreeDir(paths, taskId)
    writeFileSync(join(worktree, 'tracked.txt'), 'task change\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: worktree })
    execFileSync('git', ['commit', '-qm', 'fix: change tracked line'], { cwd: worktree })
    const taskTip = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim()
    writeFileSync(join(repoRoot, 'tracked.txt'), 'run change\n')
    git(['add', 'tracked.txt'])
    git(['commit', '-m', 'fix: advance run branch'])
    return { initialHead, runHead: git(['rev-parse', 'HEAD']), taskTip }
  }

  it('requeues a conflicted local task as a retry that starts from its kept commits', async () => {
    const taskId = '20260815_181908_195_user-rebase-conflict'
    const { initialHead, runHead, taskTip } = makeConflictingLocalTask(taskId)
    mkdirSync(join(paths.queueDir, 'effort'), { recursive: true })
    writeFileSync(join(paths.queueDir, 'effort', taskId), 'high\n')
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: false, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()

    expect(await loop.poll()).toBe('continue')

    const kept = conflictBranchName(taskId)
    expect(git(['rev-parse', kept])).toBe(taskTip)
    expect(git(['branch', '--list', branchName(taskId)])).toBe('')
    expect(git(['rev-parse', 'HEAD'])).toBe(runHead)
    expect(readStatus(paths, taskId)).toBeUndefined()
    const entries = backlogEntries()
    expect(entries).toHaveLength(1)
    const retryId = entries[0]!.split(':')[0]!
    expect(retryId).not.toBe(taskId)
    expect(retryId).toMatch(/^\d{8}_\d{6}_\d{3}_user-rebase-conflict$/)
    const spec = readFileSync(specFile(paths, retryId), 'utf8')
    expect(spec).toContain(`# ${retryId}: retry of ${taskId} after a rebase conflict`)
    expect(spec).toContain(`git cherry-pick ${initialHead}..${kept}`)
    expect(spec).toContain('- `tracked.txt`')
    expect(spec).toContain(`- \`${runHead}\``)
    expect(spec).not.toContain('fix: advance run branch')
    expect(spec).toContain('Change the tracked line.')
    expect(spec.trimEnd().endsWith('TASK_COMPLETE')).toBe(true)
    expect(readFileSync(join(paths.queueDir, 'effort', retryId), 'utf8')).toBe('high\n')
    expect(readConflictedAttempts(paths, retryId)).toMatchObject([{ taskId, branch: kept, taskTip }])
    expect(readConflictedAttempts(paths, taskId)).toEqual([])
    expect(logged).toContain(
      `Requeued 195_user    rebase conflict; ${shortTaskId(retryId)} starts from ${kept}`,
    )
  })

  it('keeps the commits but stops retrying once a conflict chain uses its retries', async () => {
    const taskId = '20260815_181908_197_user-rebase-conflict'
    const { initialHead, runHead, taskTip } = makeConflictingLocalTask(taskId)
    const earlier = ['20260815_150000_101_user-rebase-conflict', '20260815_160000_102_user-rebase-conflict']
      .map((earlierId) => {
        git(['branch', conflictBranchName(earlierId), initialHead])
        return {
          taskId: earlierId,
          branch: conflictBranchName(earlierId),
          runBranch: 'main',
          runTip: initialHead,
          base: initialHead,
          taskTip: initialHead,
          conflictedFiles: ['tracked.txt'],
          conflictingCommits: [],
        }
      })
    writeConflictedAttempts(paths, taskId, earlier)
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: false, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '2\n')
    writeFileSync(join(paths.queueDir, 'cycle-complete-2'), '')

    expect(await loop.poll()).toBe('continue')

    expect(git(['rev-parse', conflictBranchName(taskId)])).toBe(taskTip)
    expect(git(['rev-parse', 'HEAD'])).toBe(runHead)
    expect(backlogEntries()).toEqual([])
    expect(logged).toContain(
      `Abandoned 197_user    rebase conflict; commits kept on ${conflictBranchName(taskId)}`,
    )
    for (const { branch } of earlier) expect(git(['branch', '--list', branch])).not.toBe('')
    // Cleanup removed the status, so the poll sweep never saw this loss.
    expect(readStatus(paths, taskId)).toBeUndefined()
    expect(readFileSync(join(paths.queueDir, 'failed-2'), 'utf8')).toBe(`${taskId}\n`)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-2'))).toBe(false)
    expect(readConflictedAttempts(paths, taskId)).toEqual([])

    expect(await loop.poll()).toBe('continue')

    expect(readFileSync(join(paths.queueDir, 'failed-2'), 'utf8')).toBe(`${taskId}\n`)
  })

  it('records a conflicted local task as lost when its retry cannot be queued', async () => {
    const taskId = '20260815_181908_199_user-rebase-conflict'
    const { runHead, taskTip } = makeConflictingLocalTask(taskId)
    const loop = makeLoop(
      { autoMerge: true, issueQueueEnabled: false, scanEnabled: false, maxParallel: 0 },
      stubProject,
      undefined,
      undefined,
      undefined,
      () => { throw new Error('backlog is not writable') },
    )
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '3\n')
    writeFileSync(join(paths.queueDir, 'cycle-complete-3'), '')

    expect(await loop.poll()).toBe('continue')

    expect(git(['rev-parse', conflictBranchName(taskId)])).toBe(taskTip)
    expect(git(['rev-parse', 'HEAD'])).toBe(runHead)
    expect(readStatus(paths, taskId)).toBeUndefined()
    expect(logText()).toContain(
      '199_user rebase conflict was abandoned but cleanup or issue release failed: backlog is not writable',
    )
    expect(readFileSync(join(paths.queueDir, 'failed-3'), 'utf8')).toBe(`${taskId}\n`)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-3'))).toBe(false)
    expect(readConflictedAttempts(paths, taskId)).toEqual([])
  })

  it('removes every branch kept for a retry once the retry merges', async () => {
    const head = initializeGitRepo()
    const retryId = '20260815_191000_196_user-rebase-conflict'
    makeCompletedTask(retryId)
    const kept = ['20260815_150000_101_user-rebase-conflict', '20260815_181908_195_user-rebase-conflict']
      .map((earlierId) => conflictBranchName(earlierId))
    for (const branch of kept) git(['branch', branch, head])
    writeConflictedAttempts(paths, retryId, kept.map((branch) => ({
      taskId: branch.replace(/^conflict\//, ''),
      branch,
      runBranch: 'main',
      runTip: head,
      base: head,
      taskTip: head,
      conflictedFiles: ['tracked.txt'],
      conflictingCommits: [],
    })))
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: false, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, retryId)?.status).toBe('merged')
    for (const branch of kept) expect(git(['branch', '--list', branch])).toBe('')
    expect(readConflictedAttempts(paths, retryId)).toEqual([])
  })

  it('keeps the record of a kept branch whose existence cannot be checked', async () => {
    const head = initializeGitRepo()
    const retryId = '20260815_191000_199_user-rebase-conflict'
    makeCompletedTask(retryId)
    const kept = conflictBranchName('20260815_181908_198_user-rebase-conflict')
    git(['branch', kept, head])
    const attempts = [{
      taskId: kept.replace(/^conflict\//, ''),
      branch: kept,
      runBranch: 'main',
      runTip: head,
      base: head,
      taskTip: head,
      conflictedFiles: ['tracked.txt'],
      conflictingCommits: [],
    }]
    writeConflictedAttempts(paths, retryId, attempts)
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: false, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    branchLookupFailure.ref = `refs/heads/${kept}`

    try {
      expect(await loop.poll()).toBe('continue')
    } finally {
      branchLookupFailure.ref = undefined
    }

    expect(readStatus(paths, retryId)?.status).toBe('merged')
    expect(git(['branch', '--list', kept])).not.toBe('')
    expect(readConflictedAttempts(paths, retryId)).toEqual(attempts)
    expect(logText()).toContain(
      `could not remove commits kept for ${shortTaskId(retryId)}: ${kept}: fatal: unable to read refs`,
    )
  })

  it('hands a reclaimed issue the attempt that conflicted before it was released', async () => {
    const head = initializeGitRepo()
    const loop = makeLoop({
      issueQueueEnabled: true, scanEnabled: false, autoMerge: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    const requirement = '[BUG] `src/shared.ts` keeps the stale value'
    const issueNumber = await fakeForge.createIssue({
      title: requirement,
      body: buildIssueBody(requirement, 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const earlierId = '20260815_181908_194_auto-rebase-conflict'
    git(['branch', conflictBranchName(earlierId), head])
    const attempt = {
      taskId: earlierId,
      branch: conflictBranchName(earlierId),
      runBranch: 'main',
      runTip: head,
      base: head,
      taskTip: head,
      conflictedFiles: ['src/shared.ts'],
      conflictingCommits: [head],
    }
    writeConflictedAttempts(paths, issueConflictKey(issueNumber), [attempt])

    expect(await loop.poll()).toBe('continue')

    expect(runnerStarts).toHaveLength(1)
    const taskId = runnerStarts[0]!.replace(/^.*[\\/]/, '').replace(/\.md$/, '')
    const spec = readFileSync(specFile(paths, taskId), 'utf8')
    expect(spec).toContain(requirement)
    expect(spec).toContain(`git cherry-pick ${head}..${conflictBranchName(earlierId)}`)
    expect(spec).toContain('- `src/shared.ts`')
    expect(readConflictedAttempts(paths, taskId)).toEqual([attempt])
    expect(readConflictedAttempts(paths, issueConflictKey(issueNumber))).toEqual([attempt])
  })

  it('defers a merge gate that waited out the test lock without counting a failure', async () => {
    const taskId = '20260815_125258_038_auto-test-lock-busy'
    const initialHead = initializeGitRepo()
    makeCompletedTask(taskId)
    const project: ProjectAdapter = {
      ...stubProject,
      mergeChecks: () => [{
        label: 'Locked suite', cwd: '', command: `node -e "process.exit(${TEST_LOCK_BUSY_EXIT_CODE})"`,
      }],
    }
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    }, project)
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'busy test lock', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '2\n')

    expect(await loop.poll()).toBe('continue')
    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(['rev-parse', 'HEAD'])).toBe(initialHead)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('2\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    // Each poll runs the gate again rather than giving the task up.
    expect(logged.filter((line) => line.startsWith('Merging 038_auto'))).toHaveLength(2)
    expect(logText()).toContain('WARN 038_auto merge gate deferred: the repository test lock stayed busy')
    expect(logged.some((line) => line.startsWith('Failed 038_auto'))).toBe(false)
  })

  it('heartbeats a completed task while its merge stays deferred', async () => {
    const taskId = '20260815_125258_039_auto-deferred-heartbeat'
    initializeGitRepo()
    makeCompletedTask(taskId)
    const project: ProjectAdapter = {
      ...stubProject,
      mergeChecks: () => [{
        label: 'Locked suite', cwd: '', command: `node -e "process.exit(${TEST_LOCK_BUSY_EXIT_CODE})"`,
      }],
    }
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    }, project)
    loop.initializeSessionStateForBranch()
    // The claim is older than the lease, so only a heartbeat keeps the reaper from
    // returning the issue to ready while the merge keeps being deferred.
    fakeForge.clock = () => new Date(2026, 7, 6, 12, 0, 0)
    const issueNumber = await fakeForge.createIssue({
      title: 'deferred merge', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: [fakeForge.user],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])

    expect(await loop.poll()).toBe('continue')
    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(fakeForge.issueComments.get(issueNumber)?.join('\n')).toContain('Heartbeat: ')
    const issue = await fakeForge.getIssue(issueNumber)
    expect(issue.state).toBe('open')
    expect(issue.labels).toContain(LABEL_IN_PROGRESS)
    expect(issue.labels).not.toContain(LABEL_READY)
  })

  it('does not merge a completed task whose issue claim was reaped', async () => {
    const taskId = '20260815_125258_040_auto-reaped-merge'
    const initialHead = initializeGitRepo()
    makeCompletedTask(taskId)
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'reaped claim', body: '', labels: [LABEL_FINDING, LABEL_READY],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).not.toBe('merged')
    expect(git(['rev-parse', 'HEAD'])).toBe(initialHead)
    expect(issueNumbersForTask(paths, taskId)).toEqual([])
    expect(logText()).toContain(`WARN 040_auto cannot be merged: #${issueNumber} no longer claimed by this task`)
    const issue = await fakeForge.getIssue(issueNumber)
    expect(issue.state).toBe('open')
    expect(issue.labels).toContain(LABEL_READY)
    expect(fakeForge.issueComments.get(issueNumber)?.join('\n') ?? '').not.toContain('MERGED:')
  })

  it('defers the merge of a completed task whose issue claim cannot be read', async () => {
    const taskId = '20260815_125258_041_auto-unreadable-claim'
    const initialHead = initializeGitRepo()
    makeCompletedTask(taskId)
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'unreadable claim', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: [fakeForge.user],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    const getIssue = fakeForge.getIssue.bind(fakeForge)
    fakeForge.getIssue = async (number) => {
      if (number === issueNumber) throw new Error('forge unavailable')
      return getIssue(number)
    }

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(['rev-parse', 'HEAD'])).toBe(initialHead)
    expect(issueNumbersForTask(paths, taskId)).toEqual([issueNumber])
    expect(logText()).toContain(
      '041_auto merge deferred: its issue claims could not be read: forge unavailable')
    expect(logText()).not.toContain('041_auto cannot be merged')
    const issue = await getIssue(issueNumber)
    expect(issue.state).toBe('open')
    expect(issue.labels).toContain(LABEL_IN_PROGRESS)
    expect(fakeForge.issueComments.get(issueNumber)?.join('\n') ?? '').not.toContain('MERGED:')
  })

  it('merges a completed task whose linked issue no longer exists', async () => {
    const taskId = '20260815_125258_042_auto-deleted-claim'
    const initialHead = initializeGitRepo()
    makeCompletedTask(taskId)
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'deleted claim', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: [fakeForge.user],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    const getIssue = fakeForge.getIssue.bind(fakeForge)
    let claimReads = 0
    fakeForge.getIssue = async (number) => {
      // Only the claim check sees the issue as deleted; later reads reconcile it normally.
      if (number === issueNumber && ++claimReads === 1) throw new ForgeIssueNotFoundError(number)
      return getIssue(number)
    }

    expect(await loop.poll()).toBe('continue')

    expect(claimReads).toBeGreaterThan(0)
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(git(['rev-parse', 'HEAD'])).not.toBe(initialHead)
    expect(existsSync(join(repoRoot, `${taskId}.txt`))).toBe(true)
    expect(logText()).not.toContain('merge deferred')
    expect(logText()).not.toContain('042_auto cannot be merged')
  })

  it('skips a task whose merge is already active without counting a failure', async () => {
    const taskId = '20260815_125258_037_auto-merge-race'
    const initialHead = initializeGitRepo()
    makeCompletedTask(taskId)
    const guardDir = join(paths.queueDir, 'merge-guards', taskId)
    mkdirSync(guardDir, { recursive: true })
    writeFileSync(join(guardDir, 'owner.json'), `${JSON.stringify({
      state: 'active',
      pid: process.pid,
      startIdentity: currentProcessStartIdentity(),
    })}\n`)
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '2\n')

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(['rev-parse', 'HEAD'])).toBe(initialHead)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('2\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(logged).toContain('Skipped 037_auto    merge already in progress')
    expect(logged.some((line) => line.startsWith('Merging 037_auto'))).toBe(false)
    expect(logged.some((line) => line.startsWith('Failed 037_auto'))).toBe(false)
  })

  /** Run `body` while a recorded runner looks alive but has no verifiable identity. */
  function withUnverifiableRunner(
    body: (runnerPid: number) => Promise<void>,
  ): Promise<void> {
    const startIdentity = vi.spyOn(operatingSystem, 'processStartIdentity')
      .mockReturnValue(undefined)
    const processAlive = vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    const treeAlive = vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(true)
    return body(36216).finally(() => {
      treeAlive.mockRestore()
      processAlive.mockRestore()
      startIdentity.mockRestore()
    })
  }

  // Counting these attempts once stopped a run on its third poll and terminated the four
  // tasks still in flight with it, while the task itself had completed its work.
  it('defers every merge whose completed runner cannot be verified yet', async () => {
    await withUnverifiableRunner(async (runnerPid) => {
      const taskId = '20260815_125259_038_auto-unverifiable-runner'
      const initialHead = initializeGitRepo()
      makeCompletedTask(taskId, false)
      writeRawStatus(taskId, 'completed', runnerPid)
      const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree')
      const loop = makeLoop({
        autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
        maxConsecutiveMergeFailures: 3,
      })
      loop.initializeSessionStateForBranch()
      const issueNumber = await fakeForge.createIssue({
        title: 'lingering runner tree', body: '',
        labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      })
      recordIssuesForTask(paths, taskId, [issueNumber])

      expect(await loop.poll()).toBe('continue')
      expect(await loop.poll()).toBe('continue')
      expect(await loop.poll()).toBe('continue')

      expect(readStatus(paths, taskId)).toMatchObject({ status: 'completed', pid: runnerPid })
      expect(git(['rev-parse', 'HEAD'])).toBe(initialHead)
      expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('0\n')
      expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
      expect(terminate).not.toHaveBeenCalled()
      expect(logged.filter((line) => line.includes('merge deferred'))).toEqual([
        `WARN 038_auto merge deferred: completed runner ${runnerPid} cannot be verified yet`,
      ])
      expect(logged.some((line) => line.startsWith('Failed 038_auto'))).toBe(false)
      terminate.mockRestore()
    })
  })

  it('merges a deferred task once its runner registry entry is gone', async () => {
    await withUnverifiableRunner(async (runnerPid) => {
      const taskId = '20260815_125300_039_auto-runner-registry-clears'
      const initialHead = initializeGitRepo()
      makeCompletedTask(taskId, false)
      writeRawStatus(taskId, 'completed', runnerPid)
      const loop = makeLoop({
        autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
      })
      loop.initializeSessionStateForBranch()
      const issueNumber = await fakeForge.createIssue({
        title: 'lingering runner tree', body: '',
        labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      })
      recordIssuesForTask(paths, taskId, [issueNumber])

      expect(await loop.poll()).toBe('continue')

      expect(readStatus(paths, taskId)?.status).toBe('completed')
      expect(git(['rev-parse', 'HEAD'])).toBe(initialHead)

      // What a restart observed: the runner tree had gone and its registry entry with it.
      forgetTaskProcess(paths, taskId)

      expect(await loop.poll()).toBe('continue')

      expect(readStatus(paths, taskId)?.status).toBe('merged')
      expect(git(['rev-parse', 'HEAD'])).not.toBe(initialHead)
      expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('0\n')
      expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
      expect(logged.some((line) => line.startsWith('Merged 039_auto'))).toBe(true)
      expect(logged.some((line) => line.startsWith('Failed 039_auto'))).toBe(false)
      expect(logged.some((line) => line.startsWith('Recovered merging 039_auto'))).toBe(true)
    })
  })

  // A finished runner's PID once went to another task's runner, and every poll deferred
  // the merge as unverifiable until a person removed the registry entry.
  it('merges a completed task on the next poll once its runner PID was reused', async () => {
    const runnerPid = 29316
    const startIdentity = vi.spyOn(operatingSystem, 'processStartIdentity')
      .mockReturnValue('started:runner')
    const processAlive = vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    // The holder's own tree is alive; the finished runner left no orphan behind.
    const treeAlive = vi.spyOn(operatingSystem, 'processTreeIsAlive')
      .mockImplementation((_pid, recordedStartIdentity) => recordedStartIdentity === undefined)
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree')
    try {
      const taskId = '20260815_125300_040_auto-runner-pid-reused'
      const initialHead = initializeGitRepo()
      makeCompletedTask(taskId, false)
      writeRawStatus(taskId, 'completed', runnerPid)
      startIdentity.mockReturnValue('started:another-runner')
      const loop = makeLoop({
        autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
      })
      loop.initializeSessionStateForBranch()
      const issueNumber = await fakeForge.createIssue({
        title: 'reused runner pid', body: '',
        labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      })
      recordIssuesForTask(paths, taskId, [issueNumber])

      expect(await loop.poll()).toBe('continue')

      expect(readStatus(paths, taskId)?.status).toBe('merged')
      expect(git(['rev-parse', 'HEAD'])).not.toBe(initialHead)
      expect(terminate).not.toHaveBeenCalled()
      expect(logText()).not.toContain('cannot be verified yet')
      expect(logged.some((line) => line.startsWith('Merged 040_auto'))).toBe(true)
    } finally {
      terminate.mockRestore()
      treeAlive.mockRestore()
      processAlive.mockRestore()
      startIdentity.mockRestore()
    }
  })

  it('terminalizes a no-change task while preserving failures and invalidating the cycle', async () => {
    const taskId = '20260814_144959_066_auto-already-resolved'
    const initialHead = initializeGitRepo()
    writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# spec\n')
    git(['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    writeFinal(taskId,
      'The reported failure is already fixed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    writeRawStatus(taskId, 'completed')
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'already resolved finding', body: '',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '2\n')
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    writeFileSync(join(paths.queueDir, 'cycle-complete-1'), '')

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('no-change')
    expect(issueCompletionForIssue(paths, issueNumber)).toMatchObject({
      taskId, outcome: 'no-change',
    })
    expect((await fakeForge.getIssue(issueNumber)).state).toBe('closed')
    expect(fakeForge.issueComments.get(issueNumber)?.join('\n'))
      .toContain('no change was warranted')
    expect(git(['rev-parse', 'HEAD'])).toBe(initialHead)
    expect(existsSync(worktreeDir(paths, taskId))).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('2\n')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(logged).toContain('No-change 066_auto    no change warranted')
    expect(logged.some((line) => line.startsWith('Failed 066_auto'))).toBe(false)
  })

  it('terminalizes a task whose change is already on the run branch as no-change', async () => {
    const taskId = '20260814_144306_064_auto-duplicate-fix'
    initializeGitRepo()
    writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# spec\n')
    const worktree = worktreeDir(paths, taskId)
    git(['worktree', 'add', worktree, '-b', branchName(taskId)])
    writeFileSync(join(worktree, 'tracked.txt'), 'fixed\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: worktree })
    execFileSync('git', ['commit', '-qm', 'fix: duplicate the run fix'], { cwd: worktree })
    writeFinal(taskId, 'TASK_COMPLETE\n')
    writeRawStatus(taskId, 'completed')

    writeFileSync(join(repoRoot, 'tracked.txt'), 'fixed\n')
    git(['add', 'tracked.txt'])
    git(['commit', '-m', 'fix: land the fix from another task'])
    const runHead = git(['rev-parse', 'HEAD'])

    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'duplicate fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    const getIssue = fakeForge.getIssue.bind(fakeForge)
    let unavailable = true
    fakeForge.getIssue = async (number) => {
      if (number === issueNumber && unavailable) {
        unavailable = false
        throw new Error('forge unavailable')
      }
      return getIssue(number)
    }

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(['rev-parse', 'HEAD'])).toBe(runHead)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('0\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('no-change')
    expect(issueCompletionForIssue(paths, issueNumber)).toMatchObject({
      taskId, outcome: 'no-change',
    })
    expect((await fakeForge.getIssue(issueNumber)).state).toBe('closed')
    expect(fakeForge.issueComments.get(issueNumber)?.join('\n'))
      .toContain('no change was warranted')
    expect(git(['rev-parse', 'HEAD'])).toBe(runHead)
    expect(existsSync(worktree)).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('0\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(logged).toContain('No-change 064_auto    no change warranted')
    expect(logged.some((line) => line.startsWith('Failed 064_auto'))).toBe(false)
  })

  it('retries no-change issue reconciliation without counting a merge failure', async () => {
    const taskId = '20260814_145209_067_auto-no-change-retry'
    initializeGitRepo()
    writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# spec\n')
    git(['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    writeFinal(taskId, 'No change is needed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    writeRawStatus(taskId, 'completed')
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'transient reconciliation', body: '',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '2\n')
    const getIssue = fakeForge.getIssue.bind(fakeForge)
    let reads = 0
    fakeForge.getIssue = async (number) => {
      // The first read is the claim check before the merge; the second is the close.
      if (number === issueNumber && ++reads === 2) throw new Error('forge unavailable')
      return getIssue(number)
    }

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('2\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(logText()).toContain('could not reconcile no-change task 067_auto')
    expect(logged.some((line) => line.startsWith('Failed 067_auto'))).toBe(false)

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('no-change')
    expect((await fakeForge.getIssue(issueNumber)).state).toBe('closed')
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('2\n')
  })

  it('stops the loop when a no-change issue can never be closed', async () => {
    const taskId = '20260814_145209_071_auto-no-change-stuck'
    initializeGitRepo()
    writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# spec\n')
    git(['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    writeFinal(taskId, 'No change is needed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    writeRawStatus(taskId, 'completed')
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'unclosable issue', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    fakeForge.closeIssue = async () => {
      throw new Error('close rejected')
    }

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(logText()).toContain('WARN could not reconcile no-change task 071_auto')

    await loop.poll()

    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logText()).toMatch(
      /ERROR could not reconcile no-change task 071_auto: .*close rejected.*\(repeated 2 times\)/,
    )
  })

  it('completes a no-change task whose linked issue was deleted', async () => {
    const taskId = '20260814_145209_072_auto-no-change-deleted'
    initializeGitRepo()
    writeFileSync(join(paths.tasksDir, `${taskId}.md`), '# spec\n')
    git(['worktree', 'add', worktreeDir(paths, taskId), '-b', branchName(taskId)])
    writeFinal(taskId, 'No change is needed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    writeRawStatus(taskId, 'completed')
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    recordIssuesForTask(paths, taskId, [999])

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('no-change')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(logged).toContain('No-change 072_auto    no change warranted')
  })

  it('does not merge an abandoned grouped task after the loop restarts', async () => {
    const taskId = '20260811_120000_064_auto-abandoned-group'
    const initialHead = initializeGitRepo()
    makeCompletedTask(taskId)
    const loop = makeLoop({
      autoMerge: true,
      issueQueueEnabled: true,
      scanEnabled: false,
      maxParallel: 0,
      maxConsecutiveMergeFailures: 1,
    })
    loop.initializeSessionStateForBranch()
    const issueNumbers = await Promise.all([1, 2].map((number) => fakeForge.createIssue({
      title: `grouped finding ${number}`,
      body: '',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })))
    recordIssuesForTask(paths, taskId, issueNumbers)

    await loop.poll()

    expect(readStatus(paths, taskId)?.status).toBe('failed')
    const failedLogPath = `logs/${taskId}.merge.log`
    expect(logged).toContain(`Failed 064_auto    log ${failedLogPath}`)
    expect(existsSync(join(paths.root, failedLogPath))).toBe(true)
    expect(issueNumbersForTask(paths, taskId)).toEqual([])
    expect(existsSync(join(paths.tasksDir, `${taskId}.md`))).toBe(false)
    expect(git(['rev-parse', 'HEAD'])).toBe(initialHead)

    const restartedLoop = makeLoop({
      autoMerge: true,
      issueQueueEnabled: true,
      scanEnabled: false,
      maxParallel: 0,
      maxConsecutiveMergeFailures: 1,
    })
    expect(await restartedLoop.poll()).toBe('stopped')
    await restartedLoop.poll()

    expect(readStatus(paths, taskId)?.status).toBe('failed')
    expect(git(['rev-parse', 'HEAD'])).toBe(initialHead)
  })

  it('leaves a grouped issue claimed by another account when its merge is abandoned', async () => {
    const taskId = '20260811_120000_068_auto-abandoned-group-reclaimed'
    initializeGitRepo()
    makeCompletedTask(taskId)
    const loop = makeLoop({
      autoMerge: true,
      issueQueueEnabled: true,
      scanEnabled: false,
      maxParallel: 0,
      maxConsecutiveMergeFailures: 1,
    })
    loop.initializeSessionStateForBranch()
    const [ownIssue, reclaimedIssue] = await Promise.all([1, 2].map((number) =>
      fakeForge.createIssue({
        title: `grouped finding ${number}`,
        body: '',
        labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
        assignees: [fakeForge.user],
      })))
    recordIssuesForTask(paths, taskId, [ownIssue!, reclaimedIssue!])
    // The lease lapsed while the merge gate ran, and another account claimed the issue.
    const getIssue = fakeForge.getIssue.bind(fakeForge)
    let claimChecked = false
    fakeForge.getIssue = async (number) => {
      const issue = await getIssue(number)
      if (number === reclaimedIssue && !claimChecked) {
        claimChecked = true
        await fakeForge.unassignIssue(number, fakeForge.user)
        await fakeForge.assignIssue(number, 'other-account')
      }
      return issue
    }

    await loop.poll()

    expect(readStatus(paths, taskId)?.status).toBe('failed')
    const own = await fakeForge.getIssue(ownIssue!)
    expect(own.assignees).toEqual([])
    expect(own.labels).toEqual(expect.arrayContaining([LABEL_READY, LABEL_GROUP_SINGLETON]))
    expect(own.labels).not.toContain(LABEL_IN_PROGRESS)
    const reclaimed = await fakeForge.getIssue(reclaimedIssue!)
    expect(reclaimed.assignees).toEqual(['other-account'])
    expect(reclaimed.labels).toContain(LABEL_IN_PROGRESS)
    expect(reclaimed.labels).not.toContain(LABEL_READY)
    expect(logText()).toMatch(
      new RegExp(`Released #${reclaimedIssue} +claimed by another account since; left as it is`))
  })

  it('records a git failure in the merge log when the task worktree is missing', async () => {
    const taskId = '20260811_120000_066_auto-missing-worktree'
    initializeGitRepo()
    makeCompletedTask(taskId)
    rmSync(worktreeDir(paths, taskId), { recursive: true, force: true })
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()

    await loop.poll()

    // The failure is not a MergeError, yet the log the Failed line points at must still
    // name its cause, or the failure count stops the loop with the reason recorded nowhere.
    expect(logged).toContain(`Failed 066_auto    log logs/${taskId}.merge.log`)
    expect(readFileSync(join(paths.logsDir, `${taskId}.merge.log`), 'utf8')).toMatch(/git.*ENOENT/)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('rebuilds a lost promotion record from merged status before stale-lease reaping', async () => {
    const taskId = '20260811_120000_065_auto-reconcile-merge'
    initializeGitRepo()
    makeCompletedTask(taskId)
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'stale merged fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])

    expect(await loop.poll()).toBe('continue')
    const mergedStatus = readStatus(paths, taskId)
    expect(mergedStatus).toMatchObject({
      status: 'merged',
      run_branch: 'main',
    })
    expect(mergedStatus?.merge_commit).toBe(git(['rev-parse', 'HEAD']))

    rmSync(join(paths.queueDir, 'issue-promotion', `${issueNumber}.json`))
    fakeForge.issueComments.delete(issueNumber)
    const issue = fakeForge.issues.get(issueNumber)
    if (issue !== undefined) issue.updatedAt = '2026-08-01T00:00:00.000Z'

    expect(await loop.poll()).toBe('continue')

    expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({
      taskId,
      issueNumber,
      mergeCommit: mergedStatus?.merge_commit,
      runBranch: 'main',
      commentConfirmed: true,
    })
    expect(fakeForge.issueComments.get(issueNumber)).toHaveLength(1)
    expect((await fakeForge.getIssue(issueNumber)).labels).not.toContain(LABEL_READY)
  })

  it('retries post-merge reconciliation on a later poll without stopping or advancing the gate', async () => {
    const taskId = '20260811_120000_066_auto-unconfirmed-merge'
    initializeGitRepoWithRemote()
    makeCompletedTask(taskId)
    mkdirSync(join(paths.root, 'templates'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'review-template.md'),
      '# {{REVIEW_ID}} review of cycle {{CYCLE}} against {{BASE_BRANCH}} for {{PR_URL}}\n')
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({
      autoMerge: true,
      issueQueueEnabled: true,
      scanEnabled: true,
      maxParallel: 0,
      autoPr: false,
      reviewEnabled: true,
      autoReview: true,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'stale merged fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    const issue = fakeForge.issues.get(issueNumber)
    if (issue !== undefined) issue.updatedAt = '2026-08-01T00:00:00.000Z'
    recordIssuesForTask(paths, taskId, [issueNumber])
    const commentIssue = fakeForge.commentIssue.bind(fakeForge)
    let attempts = 0
    fakeForge.commentIssue = async (...args) => {
      // The stale claim is heartbeated while the task waits to merge; only the merge
      // marker is made to fail.
      if (args[1].startsWith('MERGED:')) {
        attempts += 1
        if (attempts === 1) throw new Error('comment unavailable')
      }
      await commentIssue(...args)
    }

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)).toMatchObject({ status: 'merged', run_branch: 'main' })
    expect(issuePromotionForIssue(paths, issueNumber)?.commentConfirmed).not.toBe(true)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(attempts).toBe(1)
    expect((await fakeForge.getIssue(issueNumber)).labels).not.toContain(LABEL_READY)
    expect(logText()).toContain(`could not reconcile issue #${issueNumber} after merging 066_auto`)

    expect(await loop.poll()).toBe('continue')

    expect(issuePromotionForIssue(paths, issueNumber)?.commentConfirmed).toBe(true)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(true)
    expect(attempts).toBe(2)
  })

  it('keeps merging later tasks while one merged issue cannot be reconciled, then stops', async () => {
    const stuckTaskId = '20260811_120000_069_auto-deleted-issue'
    const laterTaskId = '20260811_120000_070_auto-later-fix'
    initializeGitRepo()
    makeCompletedTask(stuckTaskId)
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'deleted issue', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, stuckTaskId, [issueNumber])
    const listIssueComments = fakeForge.listIssueComments.bind(fakeForge)
    fakeForge.listIssueComments = async (number) => {
      if (number === issueNumber) throw new Error('issue not found')
      return listIssueComments(number)
    }

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, stuckTaskId)?.status).toBe('merged')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    makeCompletedTask(laterTaskId)
    await loop.poll()

    expect(readStatus(paths, laterTaskId)?.status).toBe('merged')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logText()).toContain(
      `ERROR could not reconcile issue #${issueNumber} after merging 069_auto: issue not found (repeated 2 times)`,
    )
  })

  it('keeps promotion unconfirmed while a published merge marker is absent from read-back', async () => {
    const taskId = '20260811_120000_068_auto-listing-lag'
    initializeGitRepoWithRemote()
    makeCompletedTask(taskId)
    mkdirSync(join(paths.root, 'templates'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'review-template.md'),
      '# {{REVIEW_ID}} review of cycle {{CYCLE}} against {{BASE_BRANCH}} for {{PR_URL}}\n')
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({
      autoMerge: true,
      issueQueueEnabled: true,
      scanEnabled: true,
      maxParallel: 0,
      autoPr: false,
      reviewEnabled: true,
      autoReview: true,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'lagging merge marker', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    const issue = fakeForge.issues.get(issueNumber)
    if (issue !== undefined) issue.updatedAt = '2026-08-01T00:00:00.000Z'
    recordIssuesForTask(paths, taskId, [issueNumber])
    const listIssueComments = fakeForge.listIssueComments.bind(fakeForge)
    let markerVisible = false
    fakeForge.listIssueComments = async (number) => {
      const comments = await listIssueComments(number)
      return markerVisible ? comments : []
    }

    expect(await loop.poll()).toBe('continue')

    const mergedStatus = readStatus(paths, taskId)
    const expectedMarker = `MERGED: ${taskId}\nMerged as ${mergedStatus?.merge_commit} into run branch main. This issue closes on promotion.`
    expect(mergedStatus).toMatchObject({ status: 'merged', run_branch: 'main' })
    // The stale claim is heartbeated while the task waits to merge.
    const nonHeartbeats = (): string[] | undefined => fakeForge.issueComments.get(issueNumber)
      ?.filter((body) => !body.startsWith('Heartbeat: '))
    expect(nonHeartbeats()).toEqual([expectedMarker])
    expect(issuePromotionForIssue(paths, issueNumber)?.commentConfirmed).not.toBe(true)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logText()).toContain('merge comment is not visible after publishing it')

    markerVisible = true
    expect(await loop.poll()).toBe('continue')

    expect(nonHeartbeats()).toEqual([expectedMarker])
    expect(fakeForge.issueCommentAuthors.get(issueNumber)?.every((author) =>
      author.login === 'worker-a' && author.hasWriteAccess)).toBe(true)
    expect(issuePromotionForIssue(paths, issueNumber)?.commentConfirmed).toBe(true)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(true)
  })

  it('defers a merge marker whose author permission could not be read instead of reposting it', async () => {
    const taskId = '20260811_120000_070_auto-lookup-failed'
    initializeGitRepoWithRemote()
    makeCompletedTask(taskId)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({
      autoMerge: true,
      issueQueueEnabled: true,
      scanEnabled: true,
      maxParallel: 0,
      autoPr: false,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'unreadable marker author', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    const listIssueComments = fakeForge.listIssueComments.bind(fakeForge)
    let lookupFails = true
    fakeForge.listIssueComments = async (number) => (await listIssueComments(number))
      .map((comment) => lookupFails
        ? { ...comment, author: { login: comment.author.login, hasWriteAccess: false, permissionLookupFailed: true } }
        : comment)

    expect(await loop.poll()).toBe('continue')
    expect(await loop.poll()).toBe('continue')

    const mergedStatus = readStatus(paths, taskId)
    const expectedMarker = `MERGED: ${taskId}\nMerged as ${mergedStatus?.merge_commit} into run branch main. This issue closes on promotion.`
    const markers = (): string[] | undefined => fakeForge.issueComments.get(issueNumber)
      ?.filter((body) => body.startsWith('MERGED: '))
    expect(markers()).toEqual([expectedMarker])
    expect(issuePromotionForIssue(paths, issueNumber)?.commentConfirmed).not.toBe(true)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(logText()).not.toContain('could not reconcile')

    lookupFails = false
    expect(await loop.poll()).toBe('continue')

    expect(markers()).toEqual([expectedMarker])
    expect(issuePromotionForIssue(paths, issueNumber)?.commentConfirmed).toBe(true)
  })

  it('retries a failed automerge on the next poll and lets the cycle gate proceed', async () => {
    const taskId = '20260810_040800_064_auto-retry-merge'
    initializeGitRepo()
    makeCompletedTask(taskId)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    let mergeChecks = 0
    const transientProject: ProjectAdapter = {
      ...stubProject,
      mergeChecks: () => ++mergeChecks === 1
        ? [{ label: 'Transient outage', cwd: '', command: 'node -e "process.exit(1)"' }]
        : [],
    }
    const loop = makeLoop({
      autoMerge: true,
      issueQueueEnabled: true,
      reviewEnabled: true,
      autoReview: false,
      autoPr: false,
      taskGate: 'full',
    }, transientProject)
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'pending fix', body: '', labels: [LABEL_FINDING, 'loop:in-progress'],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])

    expect(await loop.poll()).toBe('continue')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(logged).toContain('Waiting remote      issues #1')

    expect(await loop.poll()).toBe('continue')
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(logged.filter((line) => line.startsWith('Merging 064_auto'))).toHaveLength(2)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('0\n')
  })

  it('holds the final local gate while a scanned task is still unmerged', async () => {
    const taskId = '20260810_040700_066_auto-unmerged'
    initializeGitRepo()
    makeCompletedTask(taskId)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    let mergeChecks = 0
    const transientProject: ProjectAdapter = {
      ...stubProject,
      mergeChecks: () => ++mergeChecks === 1
        ? [{ label: 'Transient outage', cwd: '', command: 'node -e "process.exit(1)"' }]
        : [],
    }
    const loop = makeLoop({
      autoMerge: true,
      issueQueueEnabled: false,
      scanEnabled: false,
      reviewEnabled: false,
      autoPr: false,
      maxScanCycles: 1,
      maxConsecutiveMergeFailures: 3,
      taskGate: 'full',
    }, transientProject)
    loop.initializeSessionStateForBranch()

    expect(await loop.poll()).toBe('continue')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('1\n')
    expect(logged.some((line) => line.startsWith('CYCLE_COMPLETE:'))).toBe(false)
    expect(logged.some((line) => line.startsWith('LOOP_DONE:'))).toBe(false)
    expect(logged.at(-1)).toMatch(/Waiting=merge of 066_auto$/)

    expect(await loop.poll()).toBe('done')
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('reruns the passed cycle gate when a task merges after it', async () => {
    const taskId = '20260810_040800_065_auto-after-gate'
    initializeGitRepo()
    makeCompletedTask(taskId)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    writeFileSync(join(paths.queueDir, 'cycle-complete-1'), '')
    writeFileSync(join(paths.queueDir, 'cycle-resume-1'), '')
    const suiteProject: ProjectAdapter = {
      ...stubProject,
      cycleSuite: () => [{
        label: 'Marker', cwd: '',
        command: `node -e "require('node:fs').appendFileSync('suite-runs', 'run\\n')"`,
      }],
    }
    const loop = makeLoop({
      autoMerge: true,
      issueQueueEnabled: false,
      scanEnabled: false,
      maxParallel: 0,
      reviewEnabled: true,
      autoReview: false,
      autoPr: false,
      taskGate: 'light',
    }, suiteProject)
    loop.initializeSessionStateForBranch()

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(readFileSync(join(repoRoot, 'suite-runs'), 'utf8')).toBe('run\n')
    expect(readFileSync(join(paths.queueDir, 'cycle-suite-tip-1'), 'utf8').trim())
      .toBe(git(['rev-parse', 'HEAD']).trim())
    expect(logged).toContain('CYCLE_COMPLETE: 1/3')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'cycle-resume-1'))).toBe(true)
  })

  it('merges when a claim finds its existing local task completed but unmerged', async () => {
    const taskId = '20260810_040800_064_auto-claimed-again'
    const description = '[BUG] retry the completed local task'
    initializeGitRepo()
    makeCompletedTask(taskId, false)
    recordTaskIdForDesc(paths, 'auto', description, taskId)
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    await fakeForge.createIssue({
      title: 'retry completed work',
      body: buildIssueBody(description, 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const listOpenIssues = fakeForge.listOpenIssues.bind(fakeForge)
    let exposedCompletion = false
    fakeForge.listOpenIssues = async (label) => {
      if (label === LABEL_FINDING && !exposedCompletion) {
        exposedCompletion = true
        writeRawStatus(taskId, 'completed')
      }
      return listOpenIssues(label)
    }

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(logged).toContain('Claimed 064_auto    #1')
    expect(logged).not.toContain('Merging 064_auto')

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(runnerStarts).toHaveLength(0)
    expect(logged).toContain('Claimed 064_auto    #1')
    expect(logged).toContain('Merging 064_auto')
    expect(logged.some((line) => line.startsWith('Merged 064_auto'))).toBe(true)
    expect(logged.indexOf('Claimed 064_auto    #1'))
      .toBeLessThan(logged.indexOf('Merging 064_auto'))
  })

  it('rolls back a claim whose issue holds a malformed conflict retry record', async () => {
    initializeGitRepo()
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'retry from kept commits',
      body: buildIssueBody('[BUG] `src/shared.ts` retry from kept commits', 'scan-task'),
      labels: [LABEL_FINDING, LABEL_READY],
    })
    const record = join(paths.queueDir, 'conflict-retry', `${issueConflictKey(issueNumber)}.json`)
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, '[]\n')

    expect(await loop.poll()).toBe('continue')

    // The claim reads the record only after the issue is taken, so it is handed back
    // ready and unassigned, and no task starts without the attempts it should carry.
    expect(logged).toContain(
      `WARN issue queue unreachable: Malformed conflict retry record ${record}; repair or remove it`,
    )
    expect(logged.some((line) => line.startsWith('Claimed '))).toBe(false)
    expect(runnerStarts).toEqual([])
    expect(backlogEntries()).toEqual([])
    await expect(fakeForge.getIssue(issueNumber)).resolves.toMatchObject({
      state: 'open', assignees: [], labels: [LABEL_FINDING, LABEL_READY],
    })
    expect(readFileSync(record, 'utf8')).toBe('[]\n')

    expect(await loop.poll()).toBe('continue')

    expect(logged.some((line) => line.startsWith('Claimed '))).toBe(false)
    expect(runnerStarts).toEqual([])
    expect(readFileSync(record, 'utf8')).toBe('[]\n')
  })

  it('keeps a conflicted task for a person when its conflict retry record is malformed', async () => {
    const taskId = '20260815_181908_191_user-rebase-conflict'
    const { runHead, taskTip } = makeConflictingLocalTask(taskId)
    const record = join(paths.queueDir, 'conflict-retry', `${taskId}.json`)
    mkdirSync(dirname(record), { recursive: true })
    writeFileSync(record, '{"taskId": ')
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: false, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()

    expect(await loop.poll()).toBe('continue')

    expect(logged).toContain(
      'WARN 191_user rebase conflict was abandoned but cleanup or issue release failed: '
      + `Malformed conflict retry record ${record}; repair or remove it`,
    )
    expect(logged.some((line) => line.startsWith('Merged 191_user'))).toBe(false)
    expect(logged.some((line) => line.startsWith('Requeued 191_user'))).toBe(false)
    expect(git(['rev-parse', 'HEAD'])).toBe(runHead)
    expect(readStatus(paths, taskId)?.status).toBe('failed')
    // The record could not be read, so cleanup never ran: the task branch, its worktree,
    // and the record itself stay for a person, and no retry is queued from a guess.
    expect(git(['rev-parse', branchName(taskId)])).toBe(taskTip)
    expect(existsSync(worktreeDir(paths, taskId))).toBe(true)
    expect(backlogEntries()).toEqual([])
    expect(readFileSync(record, 'utf8')).toBe('{"taskId": ')
  })
})
