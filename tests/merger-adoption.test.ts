import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const runBranchReads = vi.hoisted(() => ({
  failures: 0,
  answer: '' as string | Error,
  // The poll's own checkout check reads through optionalGit; a test of a later read
  // leaves it alone so the poll gets that far.
  includeOptional: true,
}))

// A fetch of a worker branch runs unchanged unless a test sets the message git fails with.
const workerFetches = vi.hoisted(() => ({ failure: undefined as string | undefined }))

// The loop's run-branch lookups run unchanged unless a test makes the next ones fail.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = ((...args: Parameters<typeof actual.execFileSync>) => {
    const [file, gitArgs] = args
    if (file === 'git' && Array.isArray(gitArgs) && gitArgs[0] === 'fetch'
      && workerFetches.failure !== undefined) {
      throw new Error(`Command failed: git ${gitArgs.join(' ')}\n${workerFetches.failure}`)
    }
    if (file === 'git' && Array.isArray(gitArgs) && gitArgs.join(' ') === 'branch --show-current'
      && runBranchReads.failures > 0) {
      // Only a lookup the loop itself runs; gitRemote.ts reads the branch on its behalf.
      const callers = (new Error().stack ?? '').split(/\r?\n/).slice(2, 5)
      if (/[\\/]src[\\/]loop\.ts/.test(callers[0] ?? '')
        && (runBranchReads.includeOptional || !callers.some((frame) => /\boptionalGit\b/.test(frame)))) {
        runBranchReads.failures -= 1
        if (runBranchReads.answer instanceof Error) throw runBranchReads.answer
        return runBranchReads.answer
      }
    }
    return actual.execFileSync(...args)
  }) as typeof actual.execFileSync
  return { ...actual, execFileSync }
})

import type { ProjectAdapter } from '../src/adapters/project.ts'
import { loadConfig } from '../src/config.ts'
import {
  issueConflictKey, readConflictedAttempts, writeConflictedAttempts,
} from '../src/conflictRetry.ts'
import {
  buildIssueBody, issuePromotionForIssue, LABEL_FINDING, LABEL_GROUP_SINGLETON, LABEL_IN_PROGRESS,
  LABEL_MERGE_FAILED, LABEL_MERGE_READY, LABEL_READY,
} from '../src/issueQueue.ts'
import { createLoop } from '../src/loop.ts'
import type { OrchestrationDepsRuntime } from '../src/merge.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { buildCheckouts, git, runner } from './adoptionHarness.ts'
import { makeFakeForge, type FakeForge } from './fakeForge.ts'
import { buildRepositoryTemplate, type RepositoryTemplate } from './repositoryTemplate.ts'
import { stubProject } from './stubProject.ts'

let tempRoot: string
let repoRoot: string
let workerRoot: string
let origin: string
let paths: OrchPaths
let forge: FakeForge
let logged: string[]

async function mergeReadyIssue(branch: string, head: string): Promise<number> {
  const issueNumber = await forge.createIssue({
    title: 'worker task',
    body: 'Shared worker task.',
    labels: [LABEL_FINDING, LABEL_MERGE_READY],
  })
  await forge.commentIssue(issueNumber,
    `Worker completed the task.\nBranch: ${branch}\nHead commit: ${head}`)
  return issueNumber
}

function makeLoop(project: ProjectAdapter, orchestrationDepsRuntime?: OrchestrationDepsRuntime) {
  const loop = createLoop({
    paths,
    config: loadConfig({ ISSUE_QUEUE_ENABLED: 'true', SCAN_ENABLED: 'false' }),
    forge,
    runner,
    project,
    log: (line) => logged.push(line),
    now: () => new Date('2026-08-09T12:00:00Z'),
    orchestrationDepsRuntime,
  })
  loop.initializeSessionStateForBranch()
  return loop
}

function pushWorkerBranch(taskId: string): { branch: string; head: string } {
  const branch = `task/${taskId}`
  git(workerRoot, ['checkout', '-q', '-b', branch])
  writeFileSync(join(workerRoot, 'worker-change.txt'), `${taskId}\n`)
  git(workerRoot, ['add', 'worker-change.txt'])
  git(workerRoot, ['commit', '-qm', 'feat: remote worker change'])
  git(workerRoot, ['push', '-q', 'origin', branch])
  return { branch, head: git(workerRoot, ['rev-parse', 'HEAD']).trim() }
}

let checkouts: RepositoryTemplate<void> | undefined

beforeAll(() => {
  checkouts = buildRepositoryTemplate(buildCheckouts, ['merger', 'worker'])
})

afterAll(() => {
  checkouts?.dispose()
})

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'orch-adopt-'))
  repoRoot = join(tempRoot, 'merger')
  workerRoot = join(tempRoot, 'worker')
  origin = join(tempRoot, 'origin.git')
  checkouts!.copyTo(tempRoot)
  git(repoRoot, ['remote', 'set-url', 'origin', origin])
  git(workerRoot, ['remote', 'set-url', 'origin', origin])
  paths = orchPaths(repoRoot)
  forge = makeFakeForge()
  logged = []
})

afterEach(() => {
  runBranchReads.failures = 0
  runBranchReads.answer = ''
  runBranchReads.includeOptional = true
  workerFetches.failure = undefined
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('remote task adoption into a fleet queue', () => {
  it('names no queue issue in the merge and closes the issues once the run PR merges', async () => {
    paths = {
      ...paths,
      fleet: {
        dir: tempRoot, project: 'example', repository: 'owner/example', issueRepository: 'owner/fleet',
      },
    }
    const task = pushWorkerBranch('20260809_000000_003_auto-fleet-remote-fix')
    const issueNumbers = await Promise.all([1, 2].map(() => forge.createIssue({
      title: 'grouped worker task',
      body: 'Shared grouped worker task.',
      labels: [LABEL_FINDING, LABEL_MERGE_READY],
    })))
    const issueList = issueNumbers.map((number) => `#${number}`).join(' ')
    await Promise.all(issueNumbers.map((issueNumber) => forge.commentIssue(issueNumber,
      `Worker completed the task.\nBranch: ${task.branch}\nHead commit: ${task.head}\nIssues: ${issueList}`)))
    forge.issueClosingCommitMessage = (message, issueNumber) => `${message} (closes #${issueNumber})`

    expect(await makeLoop(stubProject).poll()).toBe('continue')

    const mergeCommit = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim())
      .toBe('Merge 20260809_000000_003_auto-fleet-remote-fix via orchestration')
    for (const issueNumber of issueNumbers) {
      expect((await forge.getIssue(issueNumber)).state).toBe('open')
      expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({ mergeCommit })
    }

    forge.prStatusValue = {
      state: 'merged', isDraft: false, url: 'https://example.test/pull/1', headSha: mergeCommit, checks: [],
    }
    expect(await makeLoop(stubProject).poll()).toBe('continue')

    for (const issueNumber of issueNumbers) {
      const issue = await forge.getIssue(issueNumber)
      expect(issue.state).toBe('closed')
      expect(forge.issueComments.get(issueNumber)?.at(-1))
        .toContain('PROMOTED: 20260809_000000_003_auto-fleet-remote-fix')
    }
    expect(logged.some((line) => line.includes('Promoted') && line.includes(`#${issueNumbers[0]}`)))
      .toBe(true)
  })
})

describe('remote task adoption reasons', () => {
  it('records the adopted issue\'s requirement in the merge commit body', async () => {
    const task = pushWorkerBranch('20260809_000000_004_auto-reasoned-remote-fix')
    const issueNumber = await forge.createIssue({
      title: 'reasoned worker task',
      body: buildIssueBody('[BUG] `src/list.ts` drops the last page of results', 'scan-1'),
      labels: [LABEL_FINDING, LABEL_MERGE_READY],
    })
    await forge.commentIssue(issueNumber,
      `Worker completed the task.\nBranch: ${task.branch}\nHead commit: ${task.head}\nIssues: #${issueNumber}`)

    expect(await makeLoop(stubProject).poll()).toBe('continue')

    expect(git(repoRoot, ['log', '-1', '--format=%b']).trim())
      .toBe('Why: [BUG] `src/list.ts` drops the last page of results')
  })
})

describe('remote task adoption', () => {
  it('adopts one grouped branch and links the merge to every reported issue', async () => {
    const task = pushWorkerBranch('20260809_000000_002_auto-grouped-remote-fix')
    const issueNumbers = await Promise.all([1, 2].map(() => forge.createIssue({
      title: 'grouped worker task',
      body: 'Shared grouped worker task.',
      labels: [LABEL_FINDING, LABEL_MERGE_READY],
    })))
    const issueList = issueNumbers.map((number) => `#${number}`).join(' ')
    await Promise.all(issueNumbers.map((issueNumber) => forge.commentIssue(issueNumber,
      `Worker completed the task.\nBranch: ${task.branch}\nHead commit: ${task.head}\nIssues: ${issueList}`)))
    forge.issueClosingCommitMessage = (message, issueNumber) => `${message} (closes #${issueNumber})`

    expect(await makeLoop(stubProject).poll()).toBe('continue')

    const mergeCommit = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim())
      .toContain(`(closes #${issueNumbers[0]}) (closes #${issueNumbers[1]})`)
    for (const issueNumber of issueNumbers) {
      expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({ mergeCommit })
      expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_READY)
    }
    expect(logged.filter((line) => line.startsWith('Merged '))).toHaveLength(1)
  })

  it('removes the commits an earlier local attempt kept for an adopted issue', async () => {
    const task = pushWorkerBranch('20260809_000000_011_auto-adopted-after-conflict')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const head = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const earlierId = '20260809_000000_001_auto-adopted-after-conflict'
    const keptBranch = `conflict/${earlierId}`
    git(repoRoot, ['branch', keptBranch, head])
    writeConflictedAttempts(paths, issueConflictKey(issueNumber), [{
      taskId: earlierId,
      branch: keptBranch,
      runBranch: 'main',
      runTip: head,
      base: head,
      taskTip: head,
      conflictedFiles: ['README.md'],
      conflictingCommits: [head],
    }])

    expect(await makeLoop(stubProject).poll()).toBe('continue')

    expect(issuePromotionForIssue(paths, issueNumber)).toBeDefined()
    expect(git(repoRoot, ['branch', '--list', keptBranch])).toBe('')
    expect(readConflictedAttempts(paths, issueConflictKey(issueNumber))).toEqual([])
  })

  it('quarantines every reporter when a forged group names an unavailable issue', async () => {
    const task = pushWorkerBranch('20260809_000000_010_auto-forged-unavailable-group')
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const issueNumbers = await Promise.all([1, 2].map(() => forge.createIssue({
      title: 'forged unavailable grouped task',
      body: 'A worker report names an issue outside the available findings.',
      labels: [LABEL_FINDING, LABEL_MERGE_READY],
      assignees: ['worker-a'],
    })))
    const unavailableIssueNumber = 999
    await Promise.all(issueNumbers.map((issueNumber) => forge.commentIssue(issueNumber,
      `Worker completed the task.\nBranch: ${task.branch}\nHead commit: ${task.head}\nIssues: #${issueNumber} #${unavailableIssueNumber}`)))

    await makeLoop(stubProject).adoptRemoteTasks()

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    expect(existsSync(join(repoRoot, 'worker-change.txt'))).toBe(false)
    for (const issueNumber of issueNumbers) {
      const issue = await forge.getIssue(issueNumber)
      expect(issue.labels).toContain(LABEL_MERGE_FAILED)
      expect(issue.labels).not.toContain(LABEL_MERGE_READY)
      expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()
      expect(forge.issueComments.get(issueNumber)?.join('\n'))
        .toContain(`names unavailable issue #${unavailableIssueNumber}`)
    }
  })

  it('releases every member when forged grouped reports name different worker branches', async () => {
    const firstTask = pushWorkerBranch('20260809_000000_011_auto-forged-group-a')
    const secondTask = pushWorkerBranch('20260809_000000_012_auto-forged-group-b')
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const issueNumbers = await Promise.all([1, 2].map(() => forge.createIssue({
      title: 'inconsistent grouped worker task',
      body: 'Grouped members report different worker branches.',
      labels: [LABEL_FINDING, LABEL_MERGE_READY],
      assignees: ['worker-a'],
    })))
    const issueList = issueNumbers.map((number) => `#${number}`).join(' ')
    await forge.commentIssue(issueNumbers[0]!,
      `Worker completed the task.\nBranch: ${firstTask.branch}\nHead commit: ${firstTask.head}\nIssues: ${issueList}`)
    await forge.commentIssue(issueNumbers[1]!,
      `Worker completed the task.\nBranch: ${secondTask.branch}\nHead commit: ${secondTask.head}\nIssues: ${issueList}`)

    await makeLoop(stubProject).adoptRemoteTasks()

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    expect(existsSync(join(repoRoot, 'worker-change.txt'))).toBe(false)
    for (const issueNumber of issueNumbers) {
      const issue = await forge.getIssue(issueNumber)
      expect(issue.labels).toContain(LABEL_READY)
      expect(issue.labels).toContain(LABEL_GROUP_SINGLETON)
      expect(issue.labels).not.toContain(LABEL_MERGE_READY)
      expect(issue.labels).not.toContain(LABEL_MERGE_FAILED)
      expect(issue.assignees).toEqual([])
      expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()
      expect(forge.issueComments.get(issueNumber)?.join('\n'))
        .toContain('does not report the same worker branch')
    }
  })

  it('waits for a grouped member the worker has not published yet', async () => {
    const task = pushWorkerBranch('20260809_000000_013_auto-group-still-publishing')
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const published = await forge.createIssue({
      title: 'grouped worker task',
      body: 'Shared grouped worker task.',
      labels: [LABEL_FINDING, LABEL_MERGE_READY],
      assignees: ['worker-a'],
    })
    const unpublished = await forge.createIssue({
      title: 'grouped worker task',
      body: 'Shared grouped worker task.',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: ['worker-a'],
    })
    const report = `Worker completed the task.\nBranch: ${task.branch}\nHead commit: ${task.head}\nIssues: #${published} #${unpublished}`
    await forge.commentIssue(published, report)

    await makeLoop(stubProject).adoptRemoteTasks()

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    expect((await forge.getIssue(published)).labels).toEqual([LABEL_FINDING, LABEL_MERGE_READY])
    expect((await forge.getIssue(unpublished)).labels).toEqual([LABEL_FINDING, LABEL_IN_PROGRESS])
    for (const issueNumber of [published, unpublished]) {
      expect((await forge.getIssue(issueNumber)).assignees).toEqual(['worker-a'])
      expect(forge.issueComments.get(issueNumber)?.join('\n') ?? '')
        .not.toContain('Remote task adoption failed')
    }

    await forge.commentIssue(unpublished, report)
    await forge.addLabel(unpublished, LABEL_MERGE_READY)
    await forge.removeLabel(unpublished, LABEL_IN_PROGRESS)
    await makeLoop(stubProject).adoptRemoteTasks()

    const mergeCommit = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    expect(mergeCommit).not.toBe(headBefore)
    for (const issueNumber of [published, unpublished]) {
      expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({ mergeCommit })
    }
  })

  it('waits for a grouped member still claimed under a report from an earlier task', async () => {
    const earlier = pushWorkerBranch('20260809_000000_014_auto-group-earlier-task')
    const task = pushWorkerBranch('20260809_000000_015_auto-group-republishing')
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const published = await forge.createIssue({
      title: 'grouped worker task',
      body: 'Shared grouped worker task.',
      labels: [LABEL_FINDING, LABEL_MERGE_READY],
      assignees: ['worker-a'],
    })
    const unpublished = await forge.createIssue({
      title: 'grouped worker task',
      body: 'Shared grouped worker task.',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: ['worker-a'],
    })
    await forge.commentIssue(unpublished,
      `Worker completed the task.\nBranch: ${earlier.branch}\nHead commit: ${earlier.head}\nIssues: #${unpublished}`)
    const report = `Worker completed the task.\nBranch: ${task.branch}\nHead commit: ${task.head}\nIssues: #${published} #${unpublished}`
    await forge.commentIssue(published, report)

    await makeLoop(stubProject).adoptRemoteTasks()

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    expect((await forge.getIssue(published)).labels).toEqual([LABEL_FINDING, LABEL_MERGE_READY])
    expect((await forge.getIssue(unpublished)).labels).toEqual([LABEL_FINDING, LABEL_IN_PROGRESS])
    for (const issueNumber of [published, unpublished]) {
      expect((await forge.getIssue(issueNumber)).assignees).toEqual(['worker-a'])
      expect(forge.issueComments.get(issueNumber)?.join('\n') ?? '')
        .not.toContain('Remote task adoption failed')
    }
  })

  it('returns every member of an abandoned remote group as singleton-ready', async () => {
    const branch = 'task/20260809_000000_099_auto-missing-group'
    const head = 'a'.repeat(40)
    const issueNumbers = await Promise.all([1, 2].map(() => forge.createIssue({
      title: 'failed grouped worker task',
      body: 'Shared grouped worker task.',
      labels: [LABEL_FINDING, LABEL_MERGE_READY],
      assignees: ['worker-a'],
    })))
    const issueList = issueNumbers.map((number) => `#${number}`).join(' ')
    await Promise.all(issueNumbers.map((issueNumber) => forge.commentIssue(issueNumber,
      `Worker completed the task.\nBranch: ${branch}\nHead commit: ${head}\nIssues: ${issueList}`)))

    await makeLoop(stubProject).poll()

    for (const issueNumber of issueNumbers) {
      const issue = await forge.getIssue(issueNumber)
      expect(issue.labels).toContain(LABEL_READY)
      expect(issue.labels).toContain(LABEL_GROUP_SINGLETON)
      expect(issue.labels).not.toContain(LABEL_MERGE_READY)
      expect(issue.labels).not.toContain(LABEL_MERGE_FAILED)
      expect(issue.assignees).toEqual([])
    }
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('1')
  })

  it('logs git\'s reason for a failed worker branch fetch without posting it', async () => {
    const branch = 'task/20260809_000000_097_auto-missing-branch'
    const issueNumber = await forge.createIssue({
      title: 'missing worker branch',
      body: 'The reported worker branch was never pushed.',
      labels: [LABEL_FINDING, LABEL_MERGE_READY],
    })
    await forge.commentIssue(issueNumber,
      `Worker completed the task.\nBranch: ${branch}\nHead commit: ${'b'.repeat(40)}`)

    await makeLoop(stubProject).adoptRemoteTasks()

    const mergeLog = readFileSync(join(paths.logsDir, `issue-${issueNumber}.merge.log`), 'utf8')
    expect(mergeLog).toContain(`couldn't find remote ref refs/heads/${branch}`)
    expect(mergeLog).toContain(`Could not fetch ${branch} from origin.`)
    expect(forge.issueComments.get(issueNumber)?.at(-1))
      .toBe(`Remote task adoption failed: Could not fetch ${branch} from origin.`)
    expect((await forge.getIssue(issueNumber)).labels).toContain(LABEL_MERGE_FAILED)
  })

  it('reports a failure relabel that could not remove merge-ready', async () => {
    const branch = 'task/20260809_000000_096_auto-relabel-interrupted'
    const issueNumber = await forge.createIssue({
      title: 'missing worker branch',
      body: 'The reported worker branch was never pushed.',
      labels: [LABEL_FINDING, LABEL_MERGE_READY],
    })
    await forge.commentIssue(issueNumber,
      `Worker completed the task.\nBranch: ${branch}\nHead commit: ${'b'.repeat(40)}`)
    const removeLabel = forge.removeLabel.bind(forge)
    let failures = 0
    forge.removeLabel = async (number, label) => {
      if (label === LABEL_MERGE_READY && failures++ === 0) throw new Error('label service unavailable')
      await removeLabel(number, label)
    }

    await makeLoop(stubProject).adoptRemoteTasks()

    const issue = await forge.getIssue(issueNumber)
    expect(issue.labels).toContain(LABEL_MERGE_FAILED)
    expect(issue.labels).toContain(LABEL_MERGE_READY)
    expect(logged.join('\n'))
      .toContain(`could not relabel issue #${issueNumber}: label service unavailable`)
  })

  it('reports a failure relabel whose merge-ready removal did not take effect', async () => {
    const branch = 'task/20260809_000000_095_auto-relabel-ignored'
    const issueNumber = await forge.createIssue({
      title: 'missing worker branch',
      body: 'The reported worker branch was never pushed.',
      labels: [LABEL_FINDING, LABEL_MERGE_READY],
    })
    await forge.commentIssue(issueNumber,
      `Worker completed the task.\nBranch: ${branch}\nHead commit: ${'b'.repeat(40)}`)
    forge.removeLabel = async () => {}

    await makeLoop(stubProject).adoptRemoteTasks()

    expect(logged.join('\n')).toContain(
      `could not relabel issue #${issueNumber}: Issue #${issueNumber} did not reach the single ${LABEL_MERGE_FAILED} lifecycle state`)
  })

  it('retries a partial release until every member leaves grouped adoption', async () => {
    const branch = 'task/20260809_000000_098_auto-partial-group'
    const head = 'b'.repeat(40)
    const issueNumbers = await Promise.all([1, 2].map(() => forge.createIssue({
      title: 'partially released grouped worker task',
      body: 'Shared grouped worker task.',
      labels: [LABEL_FINDING, LABEL_MERGE_READY],
      assignees: ['worker-a'],
    })))
    const issueList = issueNumbers.map((number) => `#${number}`).join(' ')
    await Promise.all(issueNumbers.map((issueNumber) => forge.commentIssue(issueNumber,
      `Worker completed the task.\nBranch: ${branch}\nHead commit: ${head}\nIssues: ${issueList}`)))
    const addLabel = forge.addLabel.bind(forge)
    let failed = false
    forge.addLabel = async (issueNumber, label) => {
      if (!failed && issueNumber === issueNumbers[1] && label === LABEL_READY) {
        failed = true
        throw new Error('temporary release failure')
      }
      await addLabel(issueNumber, label)
    }
    const loop = makeLoop(stubProject)

    await loop.poll()
    expect((await forge.getIssue(issueNumbers[0]!)).labels).toContain(LABEL_READY)
    expect((await forge.getIssue(issueNumbers[1]!)).labels).toContain(LABEL_MERGE_READY)

    await loop.poll()
    for (const issueNumber of issueNumbers) {
      const issue = await forge.getIssue(issueNumber)
      expect(issue.labels).toContain(LABEL_GROUP_SINGLETON)
      expect(issue.labels).not.toContain(LABEL_MERGE_READY)
      if (issue.labels.includes(LABEL_READY)) expect(issue.assignees).toEqual([])
    }
  })

  it('guarded-merges a worker branch and records a later failed adoption', async () => {
    git(repoRoot, ['remote', 'rename', 'origin', 'shared'])
    const task = pushWorkerBranch('20260809_000000_003_auto-remote-fix')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const failedIssueNumber = await mergeReadyIssue(
      'task/20260809_000000_004_auto-missing-remote-fix',
      task.head,
    )
    let selectedPaths: string[] = []
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'adoption-test',
      mergeChecks: () => [{
        label: 'Worker file',
        cwd: '',
        command: 'node -e "if (!require(\'fs\').existsSync(\'worker-change.txt\')) process.exit(1)"',
        appliesTo: (changed) => {
          selectedPaths = changed
          return changed.includes('worker-change.txt')
        },
      }],
      cycleSuite: () => [],
    }

    expect(await makeLoop(project).poll()).toBe('continue')

    expect(selectedPaths).toContain('worker-change.txt')
    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      'Merge 20260809_000000_003_auto-remote-fix via orchestration',
    )
    expect(git(repoRoot, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ')).toHaveLength(3)
    expect(logged.join('\n')).toMatch(/Merged 003_auto    commit [0-9a-f]{8}/)
    const failedLogPath = `logs/issue-${failedIssueNumber}.merge.log`
    expect(logged).toContain(`Failed 004_auto    log ${failedLogPath}`)
    expect(existsSync(join(paths.root, failedLogPath))).toBe(true)
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_READY)
    expect(forge.issueComments.get(issueNumber)).toContain(
      `MERGED: 20260809_000000_003_auto-remote-fix\nMerged as ${git(repoRoot, ['rev-parse', 'HEAD']).trim()} into run branch main. This issue closes on promotion.`,
    )

    const failedIssue = await forge.getIssue(failedIssueNumber)
    expect(failedIssue.labels).toContain(LABEL_MERGE_FAILED)
    expect(failedIssue.labels).not.toContain(LABEL_MERGE_READY)
    expect(forge.issueComments.get(failedIssueNumber)?.join('\n'))
      .toContain('Remote task adoption failed')
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('1')
  })
})
