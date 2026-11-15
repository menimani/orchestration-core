import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  issueNumbersForTask, issuePromotionForIssue, issueReleaseIntentForTask, recordIssuesForTask,
  LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_MERGE_READY, LABEL_READY, LABEL_RETRY_EXHAUSTED,
} from '../src/issueQueue.ts'
import { shortTaskId } from '../src/ids.ts'
import {
  issueConflictKey, readConflictedAttempts, writeConflictedAttempts,
} from '../src/conflictRetry.ts'
import { pendingOrchestrationDepsFile, syncOrchestrationDepsAtStartup } from '../src/merge.ts'
import { branchName, conflictBranchName, worktreeDir } from '../src/paths.ts'
import { readStatus } from '../src/status.ts'
import {
  backlogEntries, fakeForge, git, initializeGitRepo, initializeGitRepoWithRemote, logText,
  logged, makeCompletedTask, makeLoop, paths, registerLoopHooks, repoRoot, setLogged,
  stubProject, writeRawStatus,
} from './loopHarness.ts'

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
})
