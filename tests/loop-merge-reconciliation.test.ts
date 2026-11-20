import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import {
  buildIssueBody, issuePromotionForIssue, recordIssuesForTask, LABEL_FINDING,
  LABEL_IN_PROGRESS, LABEL_READY,
} from '../src/issueQueue.ts'
import { recordTaskIdForDesc } from '../src/ids.ts'
import { issueConflictKey } from '../src/conflictRetry.ts'
import { branchName, worktreeDir } from '../src/paths.ts'
import { readStatus } from '../src/status.ts'
import {
  backlogEntries, fakeForge, git, initializeGitRepo, initializeGitRepoWithRemote, logText,
  logged, makeCompletedTask, makeConflictingLocalTask, makeLoop, paths, registerLoopHooks,
  repoRoot, runnerStarts, stubProject, useFakeRepository, writeRawStatus,
} from './loopHarness.ts'

registerLoopHooks()

describe('completed task merge recovery', () => {
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
    useFakeRepository()
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
