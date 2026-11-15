import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ForgeRateLimitError } from '../src/adapters/forge.ts'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import type { LoopConfig } from '../src/config.ts'
import {
  buildIssueBody, issuePromotionForIssue, issueReleaseIntentForTask,
  prepareIssueReleaseIntent, recordIssuePromotions, recordIssueReleaseIntent,
  recordIssuesForTask, LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_MERGE_READY, LABEL_READY,
} from '../src/issueQueue.ts'
import { shortTaskId } from '../src/ids.ts'
import type { Loop } from '../src/loop.ts'
import { statusFile } from '../src/paths.ts'
import { readStatus } from '../src/status.ts'
import { enqueueTask, specFile } from '../src/tasks.ts'
import { releasePreparationForTask } from './releasePreparation.ts'
import {
  backlogEntries, fakeForge, git, initializeGitRepo, initializeGitRepoWithRemote, logText,
  logged, makeLoop, makeRunner, paths, registerLoopHooks, repoRoot, setPaths, stubProject,
  writeFinal, writeRawStatus,
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

registerLoopHooks()

describe('remote issue queue idle detection', () => {
  it('retries closed-issue lifecycle reconciliation during queue initialization', async () => {
    const loop = makeLoop({ issueQueueEnabled: true })
    let attempts = 0
    fakeForge.listClosedIssues = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('closed issue lookup failed')
      return []
    }

    expect(await loop.initializeIssueQueue()).toBe(false)
    expect(await loop.initializeIssueQueue()).toBe(true)

    expect(attempts).toBe(2)
    expect(logText()).toContain(
      'could not reconcile closed issue labels: closed issue lookup failed',
    )
  })

  it('reports recovery once queue label creation succeeds after a failure', async () => {
    const loop = makeLoop({ issueQueueEnabled: true })
    const listLabels = fakeForge.listLabels.bind(fakeForge)
    let attempts = 0
    fakeForge.listLabels = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('label listing failed')
      return listLabels()
    }

    expect(await loop.initializeIssueQueue()).toBe(false)
    expect(await loop.initializeIssueQueue()).toBe(true)

    expect(logText()).toContain(
      'WARN could not ensure issue queue labels: label listing failed',
    )
    expect(logText()).toContain('Recovered ensuring issue queue labels after 0 minutes')
  })

  it('reports recovery once closing promoted issues succeeds after a failure', async () => {
    setPaths({
      ...paths,
      fleet: {
        dir: repoRoot, project: 'example', repository: 'owner/example',
        issueRepository: 'owner/fleet',
      },
    })
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
      maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const mergeCommit = git(['rev-parse', 'HEAD']).trim()
    const issueNumber = await fakeForge.createIssue({
      title: 'promoted fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, 'merged-task', [issueNumber])
    recordIssuePromotions(paths, 'merged-task', mergeCommit, 'main')
    let attempts = 0
    fakeForge.prStatus = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('run pull request unreadable')
      return {
        state: 'merged',
        isDraft: false,
        url: 'https://example.test/pull/9',
        headSha: mergeCommit,
        checks: [],
      }
    }

    await loop.poll()
    expect(logText()).toContain('WARN could not close promoted issues: run pull request unreadable')

    await loop.poll()
    expect(logText()).toContain(`Promoted #${issueNumber}`)
    expect(logText()).toContain('Recovered closing promoted issues after 0 minutes')
  })

  it('neither releases nor recreates the run pull request a person closed mid-run', async () => {
    setPaths({
      ...paths,
      fleet: {
        dir: repoRoot, project: 'example', repository: 'owner/example',
        issueRepository: 'owner/fleet',
      },
    })
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
      maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const mergeCommit = git(['rev-parse', 'HEAD']).trim()
    const issueNumber = await fakeForge.createIssue({
      title: 'promoted fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, 'merged-task', [issueNumber])
    recordIssuePromotions(paths, 'merged-task', mergeCommit, 'main')
    fakeForge.prStatus = async () => ({
      state: 'closed',
      isDraft: false,
      url: 'https://example.test/pull/9',
      headSha: mergeCommit,
      checks: [],
    })
    const createPr = vi.fn(async () => 'https://example.test/pull/10')
    fakeForge.createPr = createPr

    await loop.poll()
    expect(await loop.ensureDraftPr('cycle')).toBe(false)

    // The run branch still holds the merge, so the issue stays promoted to it.
    expect(createPr).not.toHaveBeenCalled()
    expect(logText()).toContain('WARN could not update PR because it is closed')
    expect(logText()).not.toContain(`Released #${issueNumber}`)
    expect(issuePromotionForIssue(paths, issueNumber)?.taskId).toBe('merged-task')
    expect((await fakeForge.getIssue(issueNumber)).labels).not.toContain(LABEL_READY)

    expect(await loop.ensureDraftPr('cycle')).toBe(false)
    expect(logText()).toContain('ERROR could not update PR because it is closed (repeated 2 times)')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(createPr).not.toHaveBeenCalled()

    // A later run on another branch has abandoned the closed one, so its issue is ready.
    git(['switch', '--quiet', '-c', 'feature/next-run'])
    rmSync(join(paths.queueDir, 'stop'), { force: true })
    loop.initializeSessionStateForBranch()
    await loop.poll()
    expect(logText()).toContain(`Released #${issueNumber}`)
    expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()
    expect((await fakeForge.getIssue(issueNumber)).labels).toContain(LABEL_READY)
  })

  it('returns the issues of an old run pull request closed unmerged in a same-repository queue', async () => {
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
      maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const mergeCommit = git(['rev-parse', 'HEAD']).trim()
    const issueNumber = await fakeForge.createIssue({
      title: 'abandoned fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: ['worker-a'],
    })
    recordIssuesForTask(paths, 'abandoned-task', [issueNumber])
    recordIssuePromotions(paths, 'abandoned-task', mergeCommit, 'run/old')
    const prStatusRefs: unknown[] = []
    fakeForge.prStatus = async (ref) => {
      prStatusRefs.push(ref)
      return {
        state: 'closed',
        isDraft: false,
        url: 'https://example.test/pull/9',
        headSha: mergeCommit,
        checks: [],
      }
    }

    await loop.poll()

    expect(prStatusRefs).toContainEqual({ kind: 'branch', value: 'run/old' })
    expect(logText()).toContain(`Released #${issueNumber}`)
    expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()
    const issue = await fakeForge.getIssue(issueNumber)
    expect(issue.state).toBe('open')
    expect(issue.assignees).toEqual([])
    expect(issue.labels).toContain(LABEL_READY)
    expect(issue.labels).not.toContain(LABEL_IN_PROGRESS)
  })

  async function noPullRequestLoop(mergeCommit: string, runBranch: string) {
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
      maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'stranded fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: ['worker-a'],
    })
    recordIssuesForTask(paths, 'stranded-task', [issueNumber])
    recordIssuePromotions(paths, 'stranded-task', mergeCommit, runBranch)
    fakeForge.prStatus = async () => ({ state: 'none', isDraft: false, url: '', headSha: '', checks: [] })
    return { loop, issueNumber }
  }

  it('returns the issues of a deleted run branch that never got a pull request', async () => {
    git(['switch', '--quiet', '-c', 'run/deleted'])
    writeFileSync(join(repoRoot, 'abandoned.txt'), 'abandoned\n')
    git(['add', 'abandoned.txt'])
    git(['commit', '--quiet', '-m', 'abandoned merge'])
    const mergeCommit = git(['rev-parse', 'HEAD']).trim()
    git(['switch', '--quiet', 'main'])
    git(['branch', '--quiet', '-D', 'run/deleted'])
    const { loop, issueNumber } = await noPullRequestLoop(mergeCommit, 'run/deleted')

    await loop.poll()

    expect(logText()).toContain(`Released #${issueNumber}`)
    expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()
    const issue = await fakeForge.getIssue(issueNumber)
    expect(issue.assignees).toEqual([])
    expect(issue.labels).toContain(LABEL_READY)
    expect(issue.labels).not.toContain(LABEL_IN_PROGRESS)
  })

  it('warns about the issues of a run branch without a pull request whose work is on the default branch', async () => {
    const mergeCommit = git(['rev-parse', 'HEAD']).trim()
    const { loop, issueNumber } = await noPullRequestLoop(mergeCommit, 'run/landed')

    await loop.poll()

    expect(logText()).toContain(
      `WARN run branch run/landed has no pull request; issues #${issueNumber} stay claimed`)
    expect(logText()).not.toContain(`Released #${issueNumber}`)
    expect(issuePromotionForIssue(paths, issueNumber)?.taskId).toBe('stranded-task')
    expect((await fakeForge.getIssue(issueNumber)).assignees).toEqual(['worker-a'])
  })

  function stillClaimedWithWarning(issueNumber: number, runBranch: string) {
    expect(logText()).toContain(
      `WARN run branch ${runBranch} has no pull request; issues #${issueNumber} stay claimed`)
    expect(logText()).not.toContain(`Released #${issueNumber}`)
    expect(issuePromotionForIssue(paths, issueNumber)?.taskId).toBe('stranded-task')
  }

  it('keeps the issues of a run branch never pushed that still exists locally', async () => {
    git(['switch', '--quiet', '-c', 'run/unpushed'])
    writeFileSync(join(repoRoot, 'unpushed.txt'), 'unpushed\n')
    git(['add', 'unpushed.txt'])
    git(['commit', '--quiet', '-m', 'unpushed merge'])
    const mergeCommit = git(['rev-parse', 'HEAD']).trim()
    git(['switch', '--quiet', 'main'])
    const { loop, issueNumber } = await noPullRequestLoop(mergeCommit, 'run/unpushed')

    await loop.poll()

    stillClaimedWithWarning(issueNumber, 'run/unpushed')
    expect((await fakeForge.getIssue(issueNumber)).assignees).toEqual(['worker-a'])
  })

  it('keeps the issues of a deleted run branch the current HEAD was cut from', async () => {
    git(['switch', '--quiet', '-c', 'run/earlier'])
    writeFileSync(join(repoRoot, 'earlier.txt'), 'earlier\n')
    git(['add', 'earlier.txt'])
    git(['commit', '--quiet', '-m', 'earlier merge'])
    const mergeCommit = git(['rev-parse', 'HEAD']).trim()
    git(['switch', '--quiet', 'main'])
    git(['merge', '--quiet', '--ff-only', 'run/earlier'])
    git(['branch', '--quiet', '-D', 'run/earlier'])
    const { loop, issueNumber } = await noPullRequestLoop(mergeCommit, 'run/earlier')

    await loop.poll()

    stillClaimedWithWarning(issueNumber, 'run/earlier')
    expect((await fakeForge.getIssue(issueNumber)).assignees).toEqual(['worker-a'])
  })

  it('keeps the issues of a deleted run branch whose merge commit is unknown locally', async () => {
    const { loop, issueNumber } = await noPullRequestLoop('f'.repeat(40), 'run/unknown')

    await loop.poll()

    stillClaimedWithWarning(issueNumber, 'run/unknown')
    expect(logText()).not.toContain('ERROR')
    expect((await fakeForge.getIssue(issueNumber)).assignees).toEqual(['worker-a'])
  })

  it('keeps the issues of a run branch without a pull request when the remote lookup fails', async () => {
    git(['switch', '--quiet', '-c', 'run/unreachable'])
    writeFileSync(join(repoRoot, 'unreachable.txt'), 'unreachable\n')
    git(['add', 'unreachable.txt'])
    git(['commit', '--quiet', '-m', 'unreachable merge'])
    const mergeCommit = git(['rev-parse', 'HEAD']).trim()
    git(['switch', '--quiet', 'main'])
    git(['branch', '--quiet', '-D', 'run/unreachable'])
    git(['remote', 'add', 'missing', join(repoRoot, 'missing.git')])
    git(['config', 'branch.main.pushRemote', 'missing'])
    const { loop, issueNumber } = await noPullRequestLoop(mergeCommit, 'run/unreachable')

    await loop.poll()

    stillClaimedWithWarning(issueNumber, 'run/unreachable')
    expect((await fakeForge.getIssue(issueNumber)).assignees).toEqual(['worker-a'])
  })

  async function promotedIssueLoop(headSha: string) {
    setPaths({
      ...paths,
      fleet: {
        dir: repoRoot, project: 'example', repository: 'owner/example',
        issueRepository: 'owner/fleet',
      },
    })
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
      maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const mergeCommit = git(['rev-parse', 'HEAD']).trim()
    const issueNumber = await fakeForge.createIssue({
      title: 'promoted fix', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, 'merged-task', [issueNumber])
    recordIssuePromotions(paths, 'merged-task', mergeCommit, 'main')
    fakeForge.prStatus = async () => ({
      state: 'merged',
      isDraft: false,
      url: 'https://example.test/pull/9',
      headSha,
      checks: [],
    })
    return { loop, issueNumber }
  }

  it('fetches a merged run head that was pushed outside the loop before comparing', async () => {
    const outside = join(repoRoot, 'outside')
    execFileSync('git', ['clone', '--quiet', join(repoRoot, 'origin.git'), outside], { windowsHide: true })
    git(['config', 'user.email', 'outside@example.test'], outside)
    git(['config', 'user.name', 'Outside'], outside)
    writeFileSync(join(outside, 'outside.txt'), 'outside\n')
    git(['add', 'outside.txt'], outside)
    git(['commit', '--quiet', '-m', 'outside push'], outside)
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/run/outside'], outside)
    const headSha = git(['rev-parse', 'HEAD'], outside).trim()
    const { loop, issueNumber } = await promotedIssueLoop(headSha)

    await loop.poll()

    expect(logText()).toContain(`Promoted #${issueNumber}`)
    expect((await fakeForge.getIssue(issueNumber)).state).toBe('closed')
  })

  it('warns instead of reporting recovery when the merged run head cannot be found', async () => {
    const { loop, issueNumber } = await promotedIssueLoop('f'.repeat(40))

    await loop.poll()

    expect(logText()).toContain('WARN could not close promoted issues:')
    expect(logText()).not.toContain('Recovered closing promoted issues')
    expect((await fakeForge.getIssue(issueNumber)).state).toBe('open')
  })

  beforeEach(() => {
    initializeGitRepoWithRemote()
    mkdirSync(join(paths.root, 'templates'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'review-template.md'),
      '# {{REVIEW_ID}} review of cycle {{CYCLE}} against {{BASE_BRANCH}} for {{PR_URL}}\n')
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
  })

  function makeReviewLoop(issueQueueEnabled: boolean): Loop {
    return makeLoop({
      issueQueueEnabled,
      autoPr: false,
      reviewEnabled: true,
      autoReview: true,
    })
  }

  it('records persisted release failures and stops after three consecutive polls', async () => {
    const loop = makeLoop({
      issueQueueEnabled: true,
      workerMode: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'cleanup release', body: '',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-gone'],
    })
    recordIssueReleaseIntent(paths, 'task-release', [issueNumber])
    fakeForge.addLabel = async (_number, label) => {
      if (label === LABEL_READY) throw new Error('release unavailable')
    }
    const failureFile = join(paths.queueDir, 'issue-release-failure-count.txt')

    await loop.poll()
    expect(readFileSync(failureFile, 'utf8')).toBe('1\n')
    expect(logText()).toContain(
      'WARN could not reconcile persisted issue releases (#1: release unavailable); attempt 1/3',
    )
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    await loop.poll()
    await loop.poll()
    expect(readFileSync(failureFile, 'utf8')).toBe('3\n')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(logText()).toContain(
      'ERROR 3 consecutive issue release failures for #1; stopping the loop',
    )
    expect(logText()).not.toContain('Recovered syncing the issue queue')
  })

  it('resets the persisted release failure streak after reconciliation succeeds', async () => {
    const loop = makeLoop({
      issueQueueEnabled: true,
      workerMode: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'cleanup release', body: '',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-gone'],
    })
    recordIssueReleaseIntent(paths, 'task-release', [issueNumber])
    const addLabel = fakeForge.addLabel.bind(fakeForge)
    let unavailable = true
    fakeForge.addLabel = async (number, label) => {
      if (label === LABEL_READY && unavailable) throw new Error('release unavailable')
      await addLabel(number, label)
    }
    const failureFile = join(paths.queueDir, 'issue-release-failure-count.txt')

    await loop.poll()
    unavailable = false
    await loop.poll()

    expect(readFileSync(failureFile, 'utf8')).toBe('0\n')
    expect(logText()).toContain('Recovered reconciling persisted issue releases after 0 minutes')
    expect(existsSync(join(paths.queueDir, 'issue-release-intent', 'task-release'))).toBe(false)
  })

  it('promotes a prepared release after local cleanup removed the task status', async () => {
    const loop = makeLoop({
      issueQueueEnabled: true,
      workerMode: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
      maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const issueNumber = await fakeForge.createIssue({
      title: 'interrupted cleanup release', body: '',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS], assignees: ['worker-gone'],
    })
    recordIssuesForTask(paths, 'task-release', [issueNumber])
    writeRawStatus('task-release', 'failed')
    prepareIssueReleaseIntent(paths, 'task-release', [issueNumber])
    rmSync(statusFile(paths, 'task-release'))
    expect(readStatus(paths, 'task-release')).toBeUndefined()

    await loop.poll()

    expect(releasePreparationForTask(paths, 'task-release')).toEqual([])
    expect(issueReleaseIntentForTask(paths, 'task-release')).toEqual([])
    await expect(fakeForge.getIssue(issueNumber)).resolves.toMatchObject({
      state: 'open',
      assignees: [],
      labels: expect.arrayContaining([LABEL_FINDING, LABEL_READY]),
    })
    expect((await fakeForge.getIssue(issueNumber)).labels).not.toContain(LABEL_IN_PROGRESS)
  })

  it('fails a completed worker task that has no linked issue instead of skipping it', async () => {
    const loop = makeLoop({
      issueQueueEnabled: true,
      workerMode: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
      maxParallel: 0,
    })
    loop.initializeSessionStateForBranch()
    const taskId = '20260808_120000_001_user-local-fallback'
    writeRawStatus(taskId, 'completed')
    const taskLog = join(paths.logsDir, `${taskId}.log`)

    await loop.poll()

    expect(readStatus(paths, taskId)?.status).toBe('failed')
    expect(logText()).toContain(`WARN worker task ${shortTaskId(taskId)} has no linked issue; marked failed`)
    expect(readFileSync(taskLog, 'utf8')).toContain(
      `Worker merge refused: a worker checkout merges only issue-linked tasks; ${taskId} has no linked issue`,
    )

    await loop.poll()

    expect(logged).toContain(`FAILED: ${taskId} — log: ${taskLog}`)
    expect(logged.filter((line) => line.includes('has no linked issue'))).toHaveLength(1)
  })

  it('logs changed remote work immediately and unchanged work at most every ten minutes', async () => {
    let current = new Date(2026, 7, 8, 12, 0, 0)
    const loop = makeLoop({
      issueQueueEnabled: true,
      autoPr: false,
      reviewEnabled: true,
      autoReview: true,
    }, stubProject, undefined, () => current)
    await fakeForge.createIssue({
      title: 'pending fix',
      body: '',
      labels: [LABEL_FINDING, 'loop:ready', 'loop:in-progress'],
    })

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logged).toEqual(['Waiting remote      issues #1'])

    await loop.triggerScanIfIdle()
    expect(logged).toHaveLength(1)

    await fakeForge.createIssue({
      title: 'another pending fix', body: '', labels: [LABEL_FINDING, 'loop:in-progress'],
    })
    await loop.triggerScanIfIdle()
    expect(logged.at(-1)).toBe('Waiting remote      issues #1 #2')

    current = new Date(2026, 7, 8, 12, 9, 59)
    await loop.triggerScanIfIdle()
    expect(logged).toHaveLength(2)
    current = new Date(2026, 7, 8, 12, 10, 0)
    await loop.triggerScanIfIdle()
    expect(logged.at(-1)).toBe('Waiting remote      issues #1 #2')
    expect(logged).toHaveLength(3)
  })

  it('defers the cycle gate and review while an in-progress issue is open', async () => {
    const loop = makeReviewLoop(true)
    await fakeForge.createIssue({
      title: 'claimed fix', body: '', labels: [LABEL_FINDING, 'loop:in-progress'],
    })

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logText()).toBe('Waiting remote      issues #1')
  })

  it('names an open finding as the reason an idle poll keeps waiting', async () => {
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
    })
    loop.initializeSessionStateForBranch()
    await fakeForge.createIssue({
      title: 'worker still running', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })

    expect(await loop.poll()).toBe('continue')

    expect(logged).toContain('Waiting remote      issues #1')
    expect(logged).toContain('Idle Status      Task=0  Queue=0  0s  Waiting=open finding')
  })

  it('counts a ready shared finding no free slot could claim in the queue counter', async () => {
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
      maxParallel: 1,
    })
    loop.initializeSessionStateForBranch()
    writeRawStatus('20260808_120000_001_auto-busy', 'running', process.pid)
    await fakeForge.createIssue({
      title: 'waiting for a slot', body: '', labels: [LABEL_FINDING, LABEL_READY],
    })

    expect(await loop.poll()).toBe('continue')

    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8').trim()).toBe('')
    expect(logged).toContain('Running Status      Task=1  Queue=1')
  })

  it('claims a ready shared finding while a full scan fleet runs', async () => {
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
      maxParallel: 2,
    })
    loop.initializeSessionStateForBranch()
    writeRawStatus('20260808_120000_001_scan', 'running', process.pid)
    writeRawStatus('20260808_120001_002_scan', 'running', process.pid)
    await fakeForge.createIssue({
      title: 'ready beside two scans',
      body: buildIssueBody('[BUG] `src/beside.ts` finding', '20260808_120000_001_scan'),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    expect(await loop.poll()).toBe('continue')

    expect(logged).toContain('Claimed 001_auto    #1')
    expect(logged.some((line) => line.startsWith('Running Status      Scan=2  Task=1')))
      .toBe(true)
  })

  it('leaves a ready shared finding unclaimed while every task slot is taken', async () => {
    const loop = makeLoop({
      issueQueueEnabled: true,
      scanEnabled: false,
      autoPr: false,
      reviewEnabled: false,
      maxParallel: 2,
    })
    loop.initializeSessionStateForBranch()
    writeRawStatus('20260808_120000_001_auto-first', 'running', process.pid)
    writeRawStatus('20260808_120001_002_auto-second', 'running', process.pid)
    await fakeForge.createIssue({
      title: 'waiting behind two tasks',
      body: buildIssueBody('[BUG] `src/behind.ts` finding', '20260808_120000_001_scan'),
      labels: [LABEL_FINDING, LABEL_READY],
    })

    expect(await loop.poll()).toBe('continue')

    expect(logged.filter((line) => line.startsWith('Claimed'))).toEqual([])
    expect(readFileSync(join(paths.queueDir, 'backlog.txt'), 'utf8').trim()).toBe('')
    expect(logged).toContain('Running Status      Task=2  Queue=1')
  })

  it('stops with the repair when merge-failed issues are the only remaining work', async () => {
    const loop = makeReviewLoop(true)
    await fakeForge.createIssue({
      title: 'adoption needs repair', body: '', labels: [LABEL_FINDING, 'loop:merge-failed'],
    })
    const reason = 'Issues #1 are labelled loop:merge-failed and are the only remaining work. Repair each adoption named in its comment, remove loop:merge-failed and any loop:merge-ready, add loop:ready, and restart the loop.'

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(readFileSync(join(paths.queueDir, 'decisions.txt'), 'utf8')).toBe(`${reason}\n`)
    expect(logText()).toContain(`ERROR ${reason}`)
    expect(logText()).not.toContain('Waiting remote')
  })

  it('stops with the repair when a failure relabel left merge-ready beside merge-failed', async () => {
    const loop = makeReviewLoop(true)
    await fakeForge.createIssue({
      title: 'half-relabelled adoption', body: '',
      labels: [LABEL_FINDING, LABEL_MERGE_READY, 'loop:merge-failed'],
    })

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(logText()).toContain('ERROR Issues #1 are labelled loop:merge-failed')
    expect(logText()).not.toContain('Waiting remote')
  })

  it('keeps waiting on a merge-failed issue while other remote work is active', async () => {
    const loop = makeReviewLoop(true)
    await fakeForge.createIssue({
      title: 'adoption needs repair', body: '', labels: [LABEL_FINDING, 'loop:merge-failed'],
    })
    await fakeForge.createIssue({
      title: 'still running', body: '', labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logText()).toBe('Waiting remote      issues #1 #2')
  })

  it('defers the cycle gate and review when remote issue listing fails', async () => {
    const loop = makeReviewLoop(true)
    fakeForge.listOpenIssues = async () => {
      throw new Error('forge unavailable')
    }

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
    expect(logText()).toContain('WARN could not count remote issue work: forge unavailable')
  })

  it('enters the gate when an in-progress issue has a local promotion record', async () => {
    const loop = makeReviewLoop(true)
    const issueNumber = await fakeForge.createIssue({
      title: 'locally merged fix', body: '', labels: [LABEL_FINDING, 'loop:in-progress'],
    })
    recordIssuesForTask(paths, 'merged-task', [issueNumber])
    recordIssuePromotions(paths, 'merged-task', 'abc123', 'feature/run-9')

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(true)
  })

  it('enters the gate when a collaborator merge marker names an ancestor of HEAD', async () => {
    const mergeSha = git(['rev-parse', 'HEAD'])
    const loop = makeReviewLoop(true)
    const issueNumber = await fakeForge.createIssue({
      title: 'remotely merged fix', body: '', labels: [LABEL_FINDING, 'loop:in-progress'],
    })
    await fakeForge.commentIssue(
      issueNumber,
      `MERGED: remote-task\nMerged as ${mergeSha} into run branch feature/run-9. This issue closes on promotion.`,
    )
    fakeForge.issueCommentAuthors.set(issueNumber, [
      { login: 'collaborator-user', hasWriteAccess: true },
    ])

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(true)
  })

  it('does not exempt a merge marker whose SHA is not an ancestor of HEAD', async () => {
    git(['switch', '-c', 'foreign'])
    writeFileSync(join(repoRoot, 'foreign.txt'), 'foreign\n')
    git(['add', 'foreign.txt'])
    git(['commit', '-m', 'foreign'])
    const foreignSha = git(['rev-parse', 'HEAD'])
    git(['switch', 'main'])
    const loop = makeReviewLoop(true)
    const issueNumber = await fakeForge.createIssue({
      title: 'foreign merged fix', body: '', labels: [LABEL_FINDING, 'loop:in-progress'],
    })
    await fakeForge.commentIssue(
      issueNumber,
      `MERGED: remote-task\nMerged as ${foreignSha} into run branch feature/other-run. This issue closes on promotion.`,
    )

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
  })

  it('does not exempt an ancestral merge marker written by an outsider', async () => {
    const mergeSha = git(['rev-parse', 'HEAD'])
    const loop = makeReviewLoop(true)
    const issueNumber = await fakeForge.createIssue({
      title: 'forged merged fix', body: '', labels: [LABEL_FINDING, 'loop:in-progress'],
    })
    await fakeForge.commentIssue(
      issueNumber,
      `MERGED: forged-task\nMerged as ${mergeSha} into run branch feature/run-9. This issue closes on promotion.`,
    )
    fakeForge.issueCommentAuthors.set(issueNumber, [
      { login: 'outside-user', hasWriteAccess: false },
    ])

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
  })

  it('does not exempt a merge marker with no parseable SHA', async () => {
    const loop = makeReviewLoop(true)
    const issueNumber = await fakeForge.createIssue({
      title: 'unverifiable merged fix', body: '', labels: [LABEL_FINDING, 'loop:in-progress'],
    })
    await fakeForge.commentIssue(issueNumber, 'MERGED: remote-task\nMerged by another checkout.')

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(false)
  })

  it('enters the gate and dispatches the review when no remote issue is open', async () => {
    const loop = makeReviewLoop(true)

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(true)
  })

  it('never consults the forge when the issue queue is disabled', async () => {
    const loop = makeReviewLoop(false)
    fakeForge.listOpenIssues = async () => {
      throw new Error('forge should not be consulted')
    }

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(existsSync(join(paths.queueDir, 'review-id-1'))).toBe(true)
  })
})

describe('documentation findings held for the cycle', () => {
  const heldFile = (): string => join(paths.queueDir, 'held-documentation.txt')
  const heldRecords = (): string[] => existsSync(heldFile())
    ? readFileSync(heldFile(), 'utf8').split(/\r?\n/).filter((line) => line !== '')
    : []
  const suiteRuns = (): boolean => existsSync(join(repoRoot, 'suite-runs'))
  const taskIdsNow = (): string[] => readdirSync(paths.tasksDir).map((name) => name.replace(/\.md$/, ''))
  const gatedProject: ProjectAdapter = {
    ...stubProject,
    cycleSuite: () => [{
      label: 'Marker', cwd: '',
      command: `node -e "require('node:fs').appendFileSync('suite-runs', 'run\\n')"`,
    }],
  }
  const gateConfig: Partial<LoopConfig> = {
    taskGate: 'light', autoPr: false, ciGateEnabled: false, reviewEnabled: true, autoReview: false,
  }

  beforeEach(() => {
    mkdirSync(join(paths.root, 'templates', 'pitfalls'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'pitfalls', 'docs.md'), 'Project documentation pitfalls.\n')
    writeFileSync(join(paths.root, 'templates', 'task-requirements.md'), 'Shared requirements.\n')
  })

  it('starts code at once and releases the documentation as one numbered task after it merges', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop(gateConfig, gatedProject)
    const scanId = '20250101_000000_030_scan'
    writeFinal(scanId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [BUG] `src/parse.ts` drops the last line',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))

    const dispatch = await loop.scanForNextTasks(scanId, 0)

    expect(dispatch.findings).toHaveLength(3)
    const [bugId] = taskIdsNow()
    expect(taskIdsNow()).toHaveLength(1)
    expect(readFileSync(specFile(paths, bugId!), 'utf8')).toContain('[BUG] `src/parse.ts` drops the last line')
    expect(backlogEntries()).toEqual([`${bugId}:1`])
    expect(heldRecords()).toEqual([
      `1\t${scanId}\t[DOCS] \`README.md\` names a removed flag`,
      `1\t${scanId}\t[DOCS] \`SPEC.md\` misstates the retry bound`,
    ])
    expect(logged).toContain(
      "Deferred 030_scan    2 documentation finding(s) until the cycle's other tasks finish",
    )

    // While the code task is queued, running, or awaiting its merge, nothing is released.
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    writeRawStatus(bugId!, 'running')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    writeRawStatus(bugId!, 'completed')
    writeFileSync(join(paths.queueDir, 'scanned', bugId!), '')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(taskIdsNow()).toEqual([bugId])
    expect(heldRecords()).toHaveLength(2)
    expect(suiteRuns()).toBe(false)

    writeRawStatus(bugId!, 'merged')
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    const docsId = taskIdsNow().find((taskId) => taskId !== bugId)
    expect(taskIdsNow()).toHaveLength(2)
    expect(backlogEntries()).toEqual([`${docsId}:1`])
    const spec = readFileSync(specFile(paths, docsId!), 'utf8')
    expect(spec).toContain([
      '## Requirement',
      '',
      '1. [DOCS] `README.md` names a removed flag',
      '2. [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    expect(spec).toContain('Project documentation pitfalls.')
    expect(heldRecords()).toEqual([])
    expect(logged).toContain('Released docs        2 documentation finding(s) as one task')
    expect(suiteRuns()).toBe(false)

    // The cycle closes only once the documentation task is terminal.
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    writeRawStatus(docsId!, 'running')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(suiteRuns()).toBe(false)
    writeRawStatus(docsId!, 'merged')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(readFileSync(join(repoRoot, 'suite-runs'), 'utf8')).toBe('run\n')
    expect(existsSync(join(paths.queueDir, 'cycle-complete-1'))).toBe(true)
    expect(taskIdsNow()).toHaveLength(2)
  })

  it('releases a single held finding without numbering it', async () => {
    const loop = makeLoop()
    const scanId = '20250101_000000_031_scan'
    writeFinal(scanId, 'NEXT_TASK: [DOCS] `README.md` omits the cleanup command\n')
    await loop.scanForNextTasks(scanId, 0)
    expect(taskIdsNow()).toEqual([])
    expect(logged).toContain(
      "Deferred 031_scan    1 documentation finding(s) until the cycle's other tasks finish",
    )

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    const [docsId] = taskIdsNow()
    expect(taskIdsNow()).toHaveLength(1)
    expect(docsId).toContain('_auto-')
    const spec = readFileSync(specFile(paths, docsId!), 'utf8')
    expect(spec).toContain(
      `## Auto-generated task (parent: ${scanId})\n\n[DOCS] \`README.md\` omits the cleanup command\n`,
    )
    expect(spec).not.toContain('1. [DOCS]')
    expect(backlogEntries()).toEqual([`${docsId}:1`])
    expect(logged).toContain('Released docs        1 documentation finding(s) as one task')
  })

  it('holds and releases a documentation finding with interior line separator characters', async () => {
    const loop = makeLoop()
    const scanId = '20250101_000000_036_scan'
    const lineSeparator = String.fromCodePoint(0x2028)
    const paragraphSeparator = String.fromCodePoint(0x2029)
    const finding = `[DOCS] README.md names${lineSeparator}a removed${paragraphSeparator}flag in\rthe cleanup section`
    writeFinal(scanId, `NEXT_TASK: ${finding}\n`)

    await loop.scanForNextTasks(scanId, 0)
    expect(taskIdsNow()).toEqual([])
    expect(heldRecords()).toEqual([`1\t${scanId}\t${finding}`])

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    const [docsId] = taskIdsNow()
    expect(taskIdsNow()).toHaveLength(1)
    expect(readFileSync(specFile(paths, docsId!), 'utf8')).toContain(finding)
    expect(heldRecords()).toEqual([])
    expect(logged).toContain('Released docs        1 documentation finding(s) as one task')
  })

  it('counts a documentation-only scan as a finding scan and releases it when nothing else is open', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    writeFileSync(join(paths.queueDir, 'scan-expected-1'), '1\n')
    writeFileSync(join(paths.queueDir, 'empty-scan-count.txt'), '2\n')
    const loop = makeLoop(gateConfig, gatedProject)
    const scanId = '20250101_000000_032_scan'
    writeFinal(scanId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))

    await loop.scanForNextTasks(scanId, 0)
    loop.recordScanYield(scanId)

    expect(readFileSync(join(paths.queueDir, 'scan-yield-1'), 'utf8')).toBe(`${scanId}\tfound\n`)
    expect(taskIdsNow()).toEqual([])
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(taskIdsNow()).toHaveLength(1)
    expect(suiteRuns()).toBe(false)
    loop.foldScanYields(1)
    expect(readFileSync(join(paths.queueDir, 'empty-scan-count.txt'), 'utf8').trim()).toBe('0')
  })

  it('holds a documentation finding reported by two scans once', async () => {
    const loop = makeLoop()
    const finding = '[DOCS] `README.md` names a removed flag'
    writeFinal('20250101_000000_033_scan', `NEXT_TASK: ${finding}\n`)
    writeFinal('20250101_000000_034_scan', `NEXT_TASK: ${finding}\nNEXT_TASK: ${finding}\n`)

    await loop.scanForNextTasks('20250101_000000_033_scan', 0)
    await loop.scanForNextTasks('20250101_000000_034_scan', 0)

    expect(heldRecords()).toEqual([`1\t20250101_000000_033_scan\t${finding}`])
    expect(logged.filter((line) => line.startsWith('Deferred'))).toHaveLength(1)

    // Once released, the task carrying it suppresses the same finding as any task would.
    await loop.triggerScanIfIdle()
    expect(taskIdsNow()).toHaveLength(1)
    writeFinal('20250101_000000_035_scan', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_035_scan', 0)
    expect(heldRecords()).toEqual([])
    expect(taskIdsNow()).toHaveLength(1)
  })

  it('keeps the holding file across a restart and clears it when a new run starts', async () => {
    initializeGitRepo()
    const loop = makeLoop()
    loop.initializeSessionStateForBranch()
    writeFinal('20250101_000000_036_scan', 'NEXT_TASK: [DOCS] `README.md` names a removed flag\n')
    await loop.scanForNextTasks('20250101_000000_036_scan', 1)

    const restarted = makeLoop()
    restarted.initializeSessionStateForBranch()
    expect(heldRecords()).toEqual([
      '2\t20250101_000000_036_scan\t[DOCS] `README.md` names a removed flag',
    ])
    expect(await restarted.triggerScanIfIdle()).toBe('continue')
    const [docsId] = taskIdsNow()
    expect(backlogEntries()).toEqual([`${docsId}:2`])

    writeFinal('20250101_000000_037_scan', 'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound\n')
    await restarted.scanForNextTasks('20250101_000000_037_scan', 0)
    expect(heldRecords()).toHaveLength(1)
    git(['switch', '-c', 'feature/next-run'])
    makeLoop().initializeSessionStateForBranch()
    expect(existsSync(heldFile())).toBe(false)
  })

  it('drops held findings with the task-limit warning when the combined task has no capacity', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ ...gateConfig, maxTotalTasks: 1 }, gatedProject)
    writeFinal('20250101_000000_038_scan', [
      'NEXT_TASK: [BUG] `src/parse.ts` drops the last line',
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
    ].join('\n'))
    await loop.scanForNextTasks('20250101_000000_038_scan', 0)
    const [bugId] = taskIdsNow()
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    writeRawStatus(bugId!, 'merged')

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(logText()).toContain('WARN task limit 1 ignored findings from 038_scan')
    expect(heldRecords()).toEqual([])
    expect(taskIdsNow()).toEqual([bugId])
    expect(suiteRuns()).toBe(true)
  })

  it('drops held findings with the depth-limit warning when their depth exceeds the bound', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    // Recorded under a run whose bound allowed depth 2; the restarted loop allows only 1.
    writeFileSync(heldFile(), [
      '1\t20250101_000000_040_scan\t[DOCS] `README.md` names a removed flag',
      '2\t20250101_000000_040_scan\t[DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n') + '\n')
    const loop = makeLoop({ ...gateConfig, maxGrowthDepth: 1 }, gatedProject)

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(logText()).toContain('WARN growth depth limit 1 ignored findings from 040_scan')
    expect(logText()).not.toContain('Released')
    expect(heldRecords()).toEqual([])
    expect(taskIdsNow()).toEqual([])
    expect(backlogEntries()).toEqual([])
    expect(suiteRuns()).toBe(true)
  })

  it('leaves a cycle without documentation findings as it was', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop(gateConfig, gatedProject)
    writeFinal('20250101_000000_039_scan', [
      'NEXT_TASK: [BUG] `src/parse.ts` drops the last line',
      'NEXT_TASK: [TEST] `src/parse.test.ts` lacks a trailing-line case',
    ].join('\n'))

    await loop.scanForNextTasks('20250101_000000_039_scan', 0)

    expect(taskIdsNow()).toHaveLength(2)
    expect(backlogEntries()).toHaveLength(2)
    expect(existsSync(heldFile())).toBe(false)
    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    for (const taskId of taskIdsNow()) writeRawStatus(taskId, 'merged')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(suiteRuns()).toBe(true)
    expect(taskIdsNow()).toHaveLength(2)
    expect(logText()).not.toMatch(/Deferred|Released/)
  })

  it('files the held findings as one issue with every fingerprint once the other issues close', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ ...gateConfig, issueQueueEnabled: true }, gatedProject)
    writeFinal('20250101_000000_040_scan', [
      'NEXT_TASK: [BUG] `src/parse.ts` drops the last line',
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))

    await loop.scanForNextTasks('20250101_000000_040_scan', 0)

    expect([...fakeForge.issues.values()].map((issue) => issue.title))
      .toEqual(['[BUG] `src/parse.ts` drops the last line'])
    expect(heldRecords()).toHaveLength(2)
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(fakeForge.issues.size).toBe(1)

    await fakeForge.closeIssue(1, 'fixed')
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(fakeForge.issues.size).toBe(2)
    const combined = await fakeForge.getIssue(2)
    expect(combined.title).toBe('Documentation fixes (cycle 1)')
    expect(combined.body).toContain([
      '1. [DOCS] `README.md` names a removed flag',
      '2. [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    expect(combined.body.match(/^Fingerprint: /gm)).toHaveLength(2)
    expect(combined.body).toContain('Depth: 1')
    expect(heldRecords()).toEqual([])
    expect(suiteRuns()).toBe(false)
  })

  it('keeps the held findings and waits when filing their issue fails, then files them once', async () => {
    initializeGitRepo()
    const loop = makeLoop({ ...gateConfig, issueQueueEnabled: true }, gatedProject)
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const scanId = '20250101_000000_047_scan'
    writeFinal(scanId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    await loop.scanForNextTasks(scanId, 0)
    const held = heldRecords()
    expect(held).toEqual([
      `1\t${scanId}\t[DOCS] \`README.md\` names a removed flag`,
      `1\t${scanId}\t[DOCS] \`SPEC.md\` misstates the retry bound`,
    ])

    const createIssue = fakeForge.createIssue.bind(fakeForge)
    fakeForge.createIssue = async () => {
      throw new Error('temporary publication failure')
    }
    expect(await loop.poll()).toBe('continue')

    expect(fakeForge.issues.size).toBe(0)
    expect(heldRecords()).toEqual(held)
    expect(logText()).toContain(
      'WARN could not file held documentation findings: temporary publication failure',
    )
    expect(logged).toContain('Idle Status      Task=0  Queue=0  0s  Waiting=documentation release')
    expect(logged.filter((line) => line.startsWith('Released'))).toEqual([])
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(suiteRuns()).toBe(false)

    fakeForge.createIssue = createIssue
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(fakeForge.issues.size).toBe(1)
    const combined = await fakeForge.getIssue(1)
    expect(combined.title).toBe('Documentation fixes (cycle 1)')
    expect(combined.body).toContain([
      '1. [DOCS] `README.md` names a removed flag',
      '2. [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    expect(heldRecords()).toEqual([])
    expect(logged.filter((line) => line.startsWith('Released'))).toEqual([
      'Released docs        2 documentation finding(s) as one task',
    ])
    expect(suiteRuns()).toBe(false)

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(fakeForge.issues.size).toBe(1)
    expect(logged.filter((line) => line.startsWith('Released'))).toHaveLength(1)
  })

  it('keeps the held findings and waits when the local enqueue fails, then releases them once', async () => {
    initializeGitRepo()
    let failEnqueue = true
    const loop = makeLoop(
      gateConfig, gatedProject, undefined, () => new Date(2026, 7, 8, 12, 0, 0), makeRunner(),
      (queuePaths, taskId, depth) => {
        if (failEnqueue) throw new Error('temporary local queue failure')
        return enqueueTask(queuePaths, taskId, depth)
      },
    )
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const scanId = '20250101_000000_048_scan'
    writeFinal(scanId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    await loop.scanForNextTasks(scanId, 0)
    const held = heldRecords()
    expect(held).toHaveLength(2)

    expect(await loop.poll()).toBe('continue')

    expect(backlogEntries()).toEqual([])
    expect(heldRecords()).toEqual(held)
    expect(logText()).toContain(
      'WARN could not enqueue finding from 048_scan: temporary local queue failure',
    )
    expect(logged).toContain('Idle Status      Task=0  Queue=0  0s  Waiting=documentation release')
    expect(logged.filter((line) => line.startsWith('Released'))).toEqual([])
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(suiteRuns()).toBe(false)

    failEnqueue = false
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    const [docsId] = taskIdsNow()
    expect(taskIdsNow()).toHaveLength(1)
    expect(backlogEntries()).toEqual([`${docsId}:1`])
    expect(readFileSync(specFile(paths, docsId!), 'utf8')).toContain([
      '## Requirement',
      '',
      '1. [DOCS] `README.md` names a removed flag',
      '2. [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    expect(heldRecords()).toEqual([])
    expect(logged.filter((line) => line.startsWith('Released'))).toEqual([
      'Released docs        2 documentation finding(s) as one task',
    ])
    expect(suiteRuns()).toBe(false)

    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(taskIdsNow()).toEqual([docsId])
    expect(backlogEntries()).toEqual([`${docsId}:1`])
    expect(logged.filter((line) => line.startsWith('Released'))).toHaveLength(1)
  })

  it('warns without stopping when a release fails after the scan that held it recovered', async () => {
    initializeGitRepo()
    let failEnqueue = true
    const loop = makeLoop(
      gateConfig, gatedProject, undefined, () => new Date(2026, 7, 8, 12, 0, 0), makeRunner(),
      (queuePaths, taskId, depth) => {
        if (failEnqueue) throw new Error('temporary local queue failure')
        return enqueueTask(queuePaths, taskId, depth)
      },
    )
    loop.initializeSessionStateForBranch()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const scanId = '20250101_000000_049_scan'
    writeFinal(scanId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [BUG] `src/parse.ts` drops the last line',
    ].join('\n'))

    expect((await loop.scanForNextTasks(scanId, 0)).reconciled).toBe(false)
    expect(logText()).toContain(
      'WARN could not enqueue finding from 049_scan: temporary local queue failure',
    )

    failEnqueue = false
    expect((await loop.scanForNextTasks(scanId, 0)).reconciled).toBe(true)
    const [bugId] = taskIdsNow()
    expect(backlogEntries()).toEqual([`${bugId}:1`])
    expect(heldRecords()).toHaveLength(1)

    writeFileSync(join(paths.queueDir, 'backlog.txt'), '')
    writeRawStatus(bugId!, 'merged')
    failEnqueue = true
    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(heldRecords()).toHaveLength(1)
    expect(logText().match(/WARN could not enqueue finding from 049_scan/g)).toHaveLength(2)
    expect(logText()).not.toContain('ERROR could not enqueue finding')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)

    failEnqueue = false
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(heldRecords()).toEqual([])
    expect(logged).toContain('Released docs        1 documentation finding(s) as one task')
    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
  })

  it('does not file held findings again when listing fails after their issue was created', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    let current = new Date(2026, 7, 11, 14, 0, 0)
    const resetAt = new Date(2026, 7, 11, 14, 40, 0)
    const loop = makeLoop(
      { ...gateConfig, issueQueueEnabled: true }, gatedProject, undefined, () => current,
    )
    writeFinal('20250101_000000_042_scan', [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    await loop.scanForNextTasks('20250101_000000_042_scan', 0)
    expect(heldRecords()).toHaveLength(2)

    // The forge creates the combined issue, then rate-limits the listing that follows.
    const listOpenIssues = fakeForge.listOpenIssues.bind(fakeForge)
    let limited = false
    fakeForge.listOpenIssues = async (label) => {
      if (fakeForge.issues.size === 1 && !limited) {
        limited = true
        throw new ForgeRateLimitError(resetAt)
      }
      return listOpenIssues(label)
    }
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(limited).toBe(true)
    expect(fakeForge.issues.size).toBe(1)
    expect(heldRecords()).toHaveLength(2)

    // Once the limit clears, the gate waits on the open, unmerged issue.
    current = new Date(2026, 7, 11, 14, 41, 0)
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(fakeForge.issues.size).toBe(1)
    expect(heldRecords()).toHaveLength(2)
    expect(logged).toContain('Waiting remote      issues #1')

    // Merged into the run branch, the open issue already carries every held finding.
    recordIssuesForTask(paths, 'docs-task', [1])
    recordIssuePromotions(paths, 'docs-task', 'abc123', 'feature/run-1')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(fakeForge.issues.size).toBe(1)
    expect(existsSync(heldFile())).toBe(false)
    expect(logged).toContain(
      'Deduplicated docs        2 held documentation finding(s) already carried by an open issue',
    )
    expect(logged.filter((line) => line.startsWith('Released'))).toEqual([])

    await fakeForge.closeIssue(1, 'promoted')
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(fakeForge.issues.size).toBe(1)
    expect(existsSync(heldFile())).toBe(false)
  })

  it('releases only the held finding that no open issue carries', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ ...gateConfig, issueQueueEnabled: true }, gatedProject)
    const scanId = '20250101_000000_043_scan'
    writeFinal(scanId, [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [DOCS] `SPEC.md` misstates the retry bound',
    ].join('\n'))
    await loop.scanForNextTasks(scanId, 0)
    expect(heldRecords()).toHaveLength(2)
    // An earlier release of this holding file filed the first finding; its fix merged.
    const covering = await fakeForge.createIssue({
      title: 'merged documentation fix',
      body: buildIssueBody('[DOCS] `README.md` names a removed flag', scanId),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    recordIssuesForTask(paths, 'other-task', [covering])
    recordIssuePromotions(paths, 'other-task', 'abc123', 'feature/run-1')

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(logged).toContain(
      'Deduplicated docs        1 held documentation finding(s) already carried by an open issue',
    )
    expect(fakeForge.issues.size).toBe(2)
    const released = await fakeForge.getIssue(covering + 1)
    expect(released.title).toBe('[DOCS] `SPEC.md` misstates the retry bound')
    expect(released.body).not.toContain('README.md')
    expect(released.body.match(/^Fingerprint: /gm)).toHaveLength(1)
    expect(heldRecords()).toEqual([])
    expect(logged).toContain('Released docs        1 documentation finding(s) as one task')
  })

  it('files a finding observed again after its earlier fix merged and awaits promotion', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ ...gateConfig, issueQueueEnabled: true }, gatedProject)
    const finding = '[DOCS] `README.md` names a removed flag'
    writeFinal('20250101_000000_045_scan', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_045_scan', 0)
    expect(await loop.triggerScanIfIdle()).toBe('continue')
    expect(fakeForge.issues.size).toBe(1)
    const first = await fakeForge.getIssue(1)
    expect(first.body).toContain('Parent: 20250101_000000_045_scan')
    expect(heldRecords()).toEqual([])
    recordIssuesForTask(paths, 'docs-task', [1])
    recordIssuePromotions(paths, 'docs-task', 'abc123', 'feature/run-1')

    // The first fix was incomplete: a later scan reports the same finding again.
    writeFinal('20250101_000000_046_scan', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_046_scan', 0)
    expect(heldRecords()).toEqual([`1\t20250101_000000_046_scan\t${finding}`])
    expect(logged).toContain(
      "Deferred 046_scan    1 documentation finding(s) until the cycle's other tasks finish",
    )

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(logged.filter((line) => line.startsWith('Deduplicated'))).toEqual([])
    expect(fakeForge.issues.size).toBe(2)
    const second = await fakeForge.getIssue(2)
    expect(second.title).toBe(finding)
    expect(second.body).toContain('Parent: 20250101_000000_046_scan')
    expect(second.body.match(/^Fingerprint: .*$/m)?.[0]).toBe(first.body.match(/^Fingerprint: .*$/m)?.[0])
    expect(heldRecords()).toEqual([])
  })

  it('does not count an open issue from an author without write access as coverage', async () => {
    initializeGitRepo()
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const loop = makeLoop({ ...gateConfig, issueQueueEnabled: true }, gatedProject)
    const finding = '[DOCS] `README.md` names a removed flag'
    writeFinal('20250101_000000_044_scan', `NEXT_TASK: ${finding}\n`)
    await loop.scanForNextTasks('20250101_000000_044_scan', 0)
    expect(heldRecords()).toHaveLength(1)
    const outside = await fakeForge.createIssue({
      title: 'outside documentation claim',
      body: buildIssueBody(finding, 'outside'),
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    })
    fakeForge.issues.get(outside)!.author = { login: 'drive-by-user', hasWriteAccess: false }
    recordIssuesForTask(paths, 'outside-task', [outside])
    recordIssuePromotions(paths, 'outside-task', 'abc123', 'feature/run-1')

    expect(await loop.triggerScanIfIdle()).toBe('continue')

    expect(logged.filter((line) => line.startsWith('Deduplicated'))).toEqual([])
    expect(fakeForge.issues.size).toBe(2)
    expect((await fakeForge.getIssue(outside + 1)).title).toBe(finding)
    expect(heldRecords()).toEqual([])
  })

  it('leaves the findings of a review task on their combined path', async () => {
    const loop = makeLoop()
    writeFinal('20250101_000000_041_review-c1', [
      'NEXT_TASK: [DOCS] `README.md` names a removed flag',
      'NEXT_TASK: [BUG] `src/parse.ts` drops the last line',
    ].join('\n'))

    await loop.scanForNextTasks('20250101_000000_041_review-c1', 0)

    expect(existsSync(heldFile())).toBe(false)
    const [fixId] = taskIdsNow()
    expect(taskIdsNow()).toHaveLength(1)
    expect(fixId).toContain('_fix-')
    expect(readFileSync(specFile(paths, fixId!), 'utf8')).toContain([
      '## Requirement',
      '',
      '1. [DOCS] `README.md` names a removed flag',
      '2. [BUG] `src/parse.ts` drops the last line',
    ].join('\n'))
    expect(backlogEntries()).toEqual([`${fixId}:1`])
  })
})
