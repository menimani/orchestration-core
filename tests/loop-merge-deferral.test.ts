import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ForgeIssueNotFoundError, ForgeRateLimitError } from '../src/adapters/forge.ts'
import { operatingSystem } from '../src/adapters/os.ts'
import {
  issueCompletionForIssue, issueNumbersForTask, issuePromotionForIssue, recordIssuesForTask,
  LABEL_FINDING, LABEL_GROUP_SINGLETON, LABEL_IN_PROGRESS, LABEL_READY,
} from '../src/issueQueue.ts'
import { branchName, worktreeDir } from '../src/paths.ts'
import { forgetTaskProcess } from '../src/processRegistry.ts'
import { currentProcessStartIdentity } from '../src/processOwner.ts'
import { readStatus } from '../src/status.ts'
import {
  fakeForge, git, initializeGitRepo, logText, logged, makeCompletedTask, makeLoop, paths,
  registerLoopHooks, repoRoot, writeFinal, writeRawStatus,
} from './loopHarness.ts'

registerLoopHooks()

describe('completed task merge recovery', () => {
  it('stops the loop when the issue claim of a completed task can never be read', async () => {
    const taskId = '20260815_125258_043_auto-unreadable-claim-stops'
    const initialHead = initializeGitRepo()
    makeCompletedTask(taskId)
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: true, scanEnabled: false, maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'never readable claim', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: [fakeForge.user],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    const getIssue = fakeForge.getIssue.bind(fakeForge)
    fakeForge.getIssue = async (number) => {
      if (number === issueNumber) throw new Error('forge unavailable')
      return getIssue(number)
    }
    const stopFile = join(paths.queueDir, 'stop')

    for (let poll = 1; poll <= 20; poll++) {
      await loop.poll()
      expect(existsSync(stopFile)).toBe(false)
    }
    expect(logText()).toContain(
      '043_auto merge deferred: its issue claims could not be read on 20 consecutive polls: '
      + 'forge unavailable')
    await loop.poll()

    expect(existsSync(stopFile)).toBe(true)
    expect(logText()).toContain(
      'ERROR 043_auto merge deferred: its issue claims could not be read on 21 consecutive polls: '
      + 'forge unavailable (repeated 2 times)')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(['rev-parse', 'HEAD'])).toBe(initialHead)
    expect(issueNumbersForTask(paths, taskId)).toEqual([issueNumber])
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

  it('retries a task a rebase emptied after its issue close failed without counting a merge failure', async () => {
    const taskId = '20260814_144306_065_auto-duplicate-fix-retry'
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
      title: 'duplicate fix retry', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '2\n')
    const closeIssue = fakeForge.closeIssue.bind(fakeForge)
    let refused = false
    fakeForge.closeIssue = async (...args) => {
      if (!refused) {
        refused = true
        throw new Error('close rejected')
      }
      return closeIssue(...args)
    }

    expect(await loop.poll()).toBe('continue')

    // The rebase has already emptied the task branch's commit.
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(['diff', `${runHead}..${branchName(taskId)}`])).toBe('')
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('2\n')
    expect(logText()).toContain('could not reconcile no-change task 065_auto')

    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('no-change')
    expect((await fakeForge.getIssue(issueNumber)).state).toBe('closed')
    expect(git(['rev-parse', 'HEAD'])).toBe(runHead)
    expect(existsSync(worktree)).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('2\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(logText()).not.toContain('has only empty commits')
    expect(logged.some((line) => line.startsWith('Failed 065_auto'))).toBe(false)
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

  it.each([
    ['a lookup failure', () => new Error('user lookup failed'), true],
    ['a rate limit', () => new ForgeRateLimitError(new Date('2026-08-11T13:00:00Z')), false],
  ])('releases no grouped issue when the current user cannot be read after %s', async (
    _cause, lookupError, warns,
  ) => {
    const taskId = '20260811_120000_069_auto-abandoned-group-no-user'
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
    const issueNumbers = await Promise.all([1, 2].map((number) =>
      fakeForge.createIssue({
        title: `grouped finding ${number}`,
        body: '',
        labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
        assignees: [fakeForge.user],
      })))
    recordIssuesForTask(paths, taskId, issueNumbers)
    // Without the claimant, a release could strip a claim another account now holds.
    fakeForge.currentUser = async () => { throw lookupError() }

    await loop.poll()

    expect(readStatus(paths, taskId)?.status).toBe('failed')
    for (const issueNumber of issueNumbers) {
      const issue = await fakeForge.getIssue(issueNumber)
      expect(issue.assignees).toEqual([fakeForge.user])
      expect(issue.labels).toContain(LABEL_IN_PROGRESS)
      expect(issue.labels).not.toContain(LABEL_READY)
    }
    expect(logged).not.toContain('Released 069_auto    grouped merge abandoned')
    const warning = 'WARN 069_auto grouped merge failed and its issues could not all be released'
    if (warns) {
      expect(logText()).toContain(`${warning}: user lookup failed`)
    } else {
      expect(logText()).not.toContain(warning)
    }
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
})
