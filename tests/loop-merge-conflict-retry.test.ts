import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import {
  buildIssueBody, issueNumbersForTask, issueReleaseIntentForTask, recordIssuesForTask,
  LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_READY,
} from '../src/issueQueue.ts'
import { shortTaskId } from '../src/ids.ts'
import {
  issueConflictKey, readConflictedAttempts, writeConflictedAttempts,
} from '../src/conflictRetry.ts'
import { TEST_LOCK_BUSY_EXIT_CODE } from '../src/merge.ts'
import { branchName, conflictBranchName, worktreeDir } from '../src/paths.ts'
import { readStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'
import { releasePreparationForTask } from './releasePreparation.ts'
import {
  backlogEntries, fakeForge, git, initializeGitRepo, logText, logged, makeCompletedTask,
  makeConflictingLocalTask, makeLoop, paths, registerLoopHooks, repoRoot, runnerStarts,
  stubProject, useFakeRepository,
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

const releaseCompletionFailure = vi.hoisted(() => ({ taskId: undefined as string | undefined }))

// Publishing a prepared issue release runs unchanged unless a test names a task whose
// rename must fail once, as a file another process holds open fails it on Windows.
vi.mock('../src/issueQueue.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/issueQueue.ts')>()
  return {
    ...actual,
    completeIssueReleaseIntent: (...args: Parameters<typeof actual.completeIssueReleaseIntent>) => {
      if (args[1] === releaseCompletionFailure.taskId) {
        releaseCompletionFailure.taskId = undefined
        throw Object.assign(new Error('EBUSY: resource busy or locked, rename'), { code: 'EBUSY' })
      }
      actual.completeIssueReleaseIntent(...args)
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
    // The surviving failed status leaves the announcement to the next poll's sweep.
    expect(logged.some((line) => line.startsWith(`FAILED: ${taskId}`))).toBe(false)
  })

  it('keeps the issue release preparation when publishing it fails after cleanup', async () => {
    const taskId = '20260815_181908_197_auto-rebase-conflict'
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
    releaseCompletionFailure.taskId = taskId

    expect(await loop.poll()).toBe('continue')

    expect(releaseCompletionFailure.taskId).toBeUndefined()
    expect(logText()).toContain(
      '197_auto rebase conflict was abandoned but cleanup or issue release failed: '
      + 'EBUSY: resource busy or locked, rename',
    )
    expect(readStatus(paths, taskId)).toBeUndefined()
    expect(existsSync(worktree)).toBe(false)
    expect(logged.some((line) => line.startsWith(`FAILED: ${taskId}`))).toBe(true)
    // Cleanup already removed the status, so the preparation was the only record left of
    // the release: it survived the failure, and the same poll's release reconciliation
    // published it and handed the issue back instead of leaving it claimed.
    expect(releasePreparationForTask(paths, taskId)).toEqual([])
    expect(issueReleaseIntentForTask(paths, taskId)).toEqual([])
    const issue = await fakeForge.getIssue(issueNumber)
    expect(issue.assignees).toEqual([])
    expect(issue.labels).toContain(LABEL_READY)
    expect(issue.labels).not.toContain(LABEL_IN_PROGRESS)
  })

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
    expect(logged).toContain(`FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.merge.log`)}`)
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
    const failedLine = `FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.merge.log`)}`
    expect(logged).toContain(failedLine)

    expect(await loop.poll()).toBe('continue')

    expect(readFileSync(join(paths.queueDir, 'failed-2'), 'utf8')).toBe(`${taskId}\n`)
    expect(logged.filter((line) => line.startsWith(`FAILED: ${taskId}`))).toEqual([failedLine])
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
    expect(logged).toContain(`FAILED: ${taskId} — log: ${join(paths.logsDir, `${taskId}.merge.log`)}`)
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
    const repository = useFakeRepository()
    const head = repository.state.head
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
    repository.state.branches.push(conflictBranchName(earlierId))
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

  it('defers a merge whose run branch moved while the gate ran without counting a failure', async () => {
    const taskId = '20260815_125258_040_auto-run-branch-moved'
    initializeGitRepo()
    makeCompletedTask(taskId)
    // A hand merge lands on the run branch each time the gate reads its checks.
    const project: ProjectAdapter = {
      ...stubProject,
      mergeChecks: () => {
        git(['commit', '-q', '--allow-empty', '-m', 'chore: land a hand merge'])
        return []
      },
    }
    const loop = makeLoop({
      autoMerge: true, issueQueueEnabled: false, scanEnabled: false, maxParallel: 0,
    }, project)
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '2\n')

    expect(await loop.poll()).toBe('continue')
    expect(await loop.poll()).toBe('continue')

    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(['log', '-1', '--format=%s'])).toBe('chore: land a hand merge')
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8')).toBe('2\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(logged.filter((line) => line.startsWith('Merging 040_auto'))).toHaveLength(2)
    expect(logText()).toContain('WARN 040_auto merge deferred: the run branch moved while the gate ran')
    expect(logged.some((line) => line.startsWith('Failed 040_auto'))).toBe(false)
    expect(readFileSync(join(paths.logsDir, `${taskId}.merge.log`), 'utf8'))
      .toContain('The integration checkout moved while the merge gate ran')
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
})
