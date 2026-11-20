import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildIssueBody, issuePromotionForIssue, issueReleaseIntentForTask,
  prepareIssueReleaseIntent, recordIssuePromotions, recordIssueReleaseIntent,
  recordIssuesForTask, LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_READY,
} from '../src/issueQueue.ts'
import { shortTaskId } from '../src/ids.ts'
import type { Loop } from '../src/loop.ts'
import { statusFile } from '../src/paths.ts'
import { readStatus } from '../src/status.ts'
import { FAKE_HEAD, type FakeRepository } from './fakeRepository.ts'
import { releasePreparationForTask } from './releasePreparation.ts'
import {
  fakeForge, logText, logged, makeLoop, paths, registerLoopHooks, repoRoot, setPaths,
  useFakeRepository, writeRawStatus,
} from './loopHarness.ts'

// Issue queue decisions that need git only to answer questions about the checkout, its
// commits and its remote, asked of an in-memory checkout (tests/fakeRepository.ts)
// instead of a fixture repository. They share loop-issue-queue.test.ts's describe title;
// the tests there that need a real repository stay there.

registerLoopHooks()

describe('remote issue queue idle detection', () => {
  // initializeGitRepoWithRemote's checkout: main, pushed to origin, which names main as
  // its default branch.
  let repository: FakeRepository

  beforeEach(() => {
    repository = useFakeRepository({
      remotes: [{
        name: 'origin', url: join(repoRoot, 'origin.git'), defaultBranch: 'main',
        branches: { main: FAKE_HEAD },
      }],
      upstreams: { main: 'origin' },
    })
    mkdirSync(join(paths.root, 'templates'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'review-template.md'),
      '# {{REVIEW_ID}} review of cycle {{CYCLE}} against {{BASE_BRANCH}} for {{PR_URL}}\n')
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
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
    const mergeCommit = repository.state.head
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
    const mergeCommit = repository.state.head
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
    repository.state.branch = 'feature/next-run'
    repository.state.branches.push('feature/next-run')
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
    const mergeCommit = repository.state.head
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
    // The deleted run branch's merge commit is still in the checkout.
    const mergeCommit = 'a'.repeat(40)
    repository.state.otherCommits[mergeCommit] = [FAKE_HEAD]
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
    const mergeCommit = repository.state.head
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
    const mergeCommit = 'b'.repeat(40)
    repository.state.otherCommits[mergeCommit] = [FAKE_HEAD]
    repository.state.branches.push('run/unpushed')
    const { loop, issueNumber } = await noPullRequestLoop(mergeCommit, 'run/unpushed')

    await loop.poll()

    stillClaimedWithWarning(issueNumber, 'run/unpushed')
    expect((await fakeForge.getIssue(issueNumber)).assignees).toEqual(['worker-a'])
  })

  it('keeps the issues of a deleted run branch the current HEAD was cut from', async () => {
    // main was fast-forwarded to the deleted run branch's merge commit.
    const mergeCommit = 'c'.repeat(40)
    repository.state.otherCommits[mergeCommit] = [FAKE_HEAD]
    repository.state.head = mergeCommit
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
    const mergeCommit = 'd'.repeat(40)
    repository.state.otherCommits[mergeCommit] = [FAKE_HEAD]
    repository.state.remotes.push({ name: 'missing', url: join(repoRoot, 'missing.git') })
    repository.state.missingRepositories.push(join(repoRoot, 'missing.git'))
    repository.state.pushRemotes.main = 'missing'
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
    const mergeCommit = repository.state.head
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
    // Another clone pushed a commit on top of main that this checkout never fetched.
    const headSha = 'e'.repeat(40)
    repository.state.remotes[0]!.commits = { [headSha]: [FAKE_HEAD] }
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
    const mergeSha = repository.state.head
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
    const foreignSha = 'b'.repeat(40)
    repository.state.otherCommits[foreignSha] = [FAKE_HEAD]
    repository.state.branches.push('foreign')
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
