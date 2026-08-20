import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ForgeRateLimitError } from '../src/adapters/forge.ts'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import type { Runner } from '../src/adapters/runner.ts'
import { loadConfig } from '../src/config.ts'
import {
  issuePromotionForIssue, LABEL_FINDING, LABEL_GROUP_SINGLETON, LABEL_MERGE_FAILED,
  LABEL_MERGE_READY, LABEL_READY,
} from '../src/issueQueue.ts'
import { createLoop } from '../src/loop.ts'
import type { OrchestrationDepsRuntime } from '../src/merge.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { makeFakeForge, type FakeForge } from './fakeForge.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import { stubProject } from './stubProject.ts'

let tempRoot: string
let repoRoot: string
let workerRoot: string
let origin: string
let paths: OrchPaths
let forge: FakeForge
let logged: string[]

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

const runner: Runner = {
  sharedSkills: fakeRunnerSharedSkills,
  start: async () => process.pid,
}

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

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'orch-adopt-'))
  repoRoot = join(tempRoot, 'merger')
  workerRoot = join(tempRoot, 'worker')
  origin = join(tempRoot, 'origin.git')
  git(tempRoot, ['init', '-q', '-b', 'main', repoRoot])
  git(tempRoot, ['init', '-q', '--bare', origin])
  git(repoRoot, ['config', 'user.email', 'test@example.com'])
  git(repoRoot, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
  git(repoRoot, ['add', 'README.md'])
  git(repoRoot, ['commit', '-qm', 'chore: initial commit'])
  git(repoRoot, ['remote', 'add', 'origin', origin])
  git(repoRoot, ['push', '-q', '-u', 'origin', 'main'])
  git(tempRoot, ['clone', '-q', '-b', 'main', origin, workerRoot])
  git(workerRoot, ['config', 'user.email', 'worker@example.com'])
  git(workerRoot, ['config', 'user.name', 'Worker'])
  paths = orchPaths(repoRoot)
  forge = makeFakeForge()
  logged = []
})

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true })
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

  it('retries issue updates for a persisted adoption without merging it again', async () => {
    const task = pushWorkerBranch('20260809_000000_005_auto-retry-adoption')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    let mergeChecks = 0
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'adoption-retry-test',
      mergeChecks: () => [{
        label: 'Count merge checks',
        cwd: '',
        command: 'node -e "process.exit(0)"',
        appliesTo: () => {
          mergeChecks += 1
          return true
        },
      }],
      cycleSuite: () => [],
    }
    const removeLabel = forge.removeLabel.bind(forge)
    let mergeReadyRemovals = 0
    forge.removeLabel = async (number, label) => {
      if (number === issueNumber && label === LABEL_MERGE_READY && mergeReadyRemovals++ === 0) {
        throw new Error('temporary label failure')
      }
      await removeLabel(number, label)
    }
    expect(await makeLoop(project).poll()).toBe('continue')

    const mergedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({
      issueNumber,
      mergeCommit: mergedHead,
      runBranch: 'main',
    })
    expect((await forge.getIssue(issueNumber)).labels).toContain(LABEL_MERGE_READY)
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_FAILED)

    expect(await makeLoop(project).poll()).toBe('continue')

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(mergedHead)
    expect(mergeChecks).toBe(1)
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_READY)
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_FAILED)
    expect(forge.issueComments.get(issueNumber)?.filter((comment) => comment.startsWith('MERGED: ')))
      .toHaveLength(1)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('0')
  })

  it('retries promotion persistence after the remote merge was already applied', async () => {
    const task = pushWorkerBranch('20260809_000000_008_auto-retry-promotion-persistence')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const promotionPath = join(paths.queueDir, 'issue-promotion')
    writeFileSync(promotionPath, 'temporarily unavailable\n')
    let mergeChecks = 0
    const project: ProjectAdapter = {
      ...stubProject,
      mergeChecks: () => [{
        label: 'Count merge checks',
        cwd: '',
        command: 'node -e "process.exit(0)"',
        appliesTo: () => {
          mergeChecks += 1
          return true
        },
      }],
      cycleSuite: () => [],
    }
    const loop = makeLoop(project)

    await loop.adoptRemoteTasks()

    const mergedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    expect((await forge.getIssue(issueNumber)).labels).toContain(LABEL_MERGE_READY)
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_FAILED)
    expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('0')
    expect(logged).toContain(
      `WARN could not persist adopted issue #${issueNumber}; retrying next poll`,
    )

    rmSync(promotionPath)
    await loop.adoptRemoteTasks()

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(mergedHead)
    expect(mergeChecks).toBe(1)
    expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({
      issueNumber,
      mergeCommit: mergedHead,
      runBranch: 'main',
    })
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_READY)
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_FAILED)
  })

  it('persists adoption and stops when post-merge dependency synchronization fails', async () => {
    const task = pushWorkerBranch('20260809_000000_007_auto-persisted-before-return')
    writeFileSync(join(workerRoot, 'package.json'), '{"private":true}\n')
    git(workerRoot, ['add', 'package.json'])
    git(workerRoot, ['commit', '-qm', 'chore: add worker package manifest'])
    git(workerRoot, ['push', '-q', 'origin', task.branch])
    task.head = git(workerRoot, ['rev-parse', 'HEAD']).trim()
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    let promotionDuringSync: ReturnType<typeof issuePromotionForIssue>

    await expect(makeLoop(stubProject, {
      packageRoot: repoRoot,
      install: () => {
        promotionDuringSync = issuePromotionForIssue(paths, issueNumber)
        throw new Error('registry unavailable')
      },
    }).adoptRemoteTasks()).rejects.toThrow(
      /registry unavailable.*Run "npm ci --no-audit --no-fund".*then restart the loop/,
    )

    expect(promotionDuringSync).toMatchObject({
      issueNumber,
      mergeCommit: git(repoRoot, ['rev-parse', 'HEAD']).trim(),
      runBranch: 'main',
    })
  })

  it('invalidates the completed cycle when a post-merge forge update is rate-limited', async () => {
    const task = pushWorkerBranch('20260809_000000_006_auto-rate-limited-adoption')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const loop = makeLoop(stubProject)
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), '1\n')
    const completeFlag = join(paths.queueDir, 'cycle-complete-1')
    writeFileSync(completeFlag, '')
    let completeFlagAtUpdate = true
    forge.commentIssue = async () => {
      completeFlagAtUpdate = existsSync(completeFlag)
      throw new ForgeRateLimitError(new Date('2026-08-09T12:05:00Z'))
    }

    await loop.adoptRemoteTasks()

    expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({
      issueNumber,
      mergeCommit: git(repoRoot, ['rev-parse', 'HEAD']).trim(),
    })
    expect(completeFlagAtUpdate).toBe(false)
    expect(existsSync(completeFlag)).toBe(false)
  })
})
