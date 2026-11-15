import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ failedPromotionRenames: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (mocks.failedPromotionRenames > 0 && /issue-promotion/.test(String(args[1]))) {
        mocks.failedPromotionRenames -= 1
        throw new Error('temporary promotion write failure')
      }
      return actual.renameSync(...args)
    },
  }
})

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

import { ForgeRateLimitError } from '../src/adapters/forge.ts'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { loadConfig } from '../src/config.ts'
import {
  issuePromotionForIssue, LABEL_FINDING, LABEL_MERGE_FAILED, LABEL_MERGE_READY,
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

describe('remote task adoption', () => {
  it('stops the loop on the twentieth consecutive deferral for an undetermined reporter', async () => {
    const task = pushWorkerBranch('20260809_000000_031_auto-permission-never-clears')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const labelsBefore = (await forge.getIssue(issueNumber)).labels
    const commentsBefore = [...forge.issueComments.get(issueNumber)!]
    // Every poll's permission lookup fails, as with a token missing the scope.
    forge.issueCommentAuthors.get(issueNumber)![0] =
      { login: 'maintainer-one', hasWriteAccess: false, permissionLookupFailed: true }
    const loop = makeLoop(stubProject)
    const stopFile = join(paths.queueDir, 'stop')

    for (let poll = 1; poll < 20; poll += 1) await loop.adoptRemoteTasks()

    expect(existsSync(stopFile)).toBe(false)
    expect(logged.filter((line) => line.includes('adoption deferred'))).toHaveLength(1)
    expect(logged.join('\n')).not.toContain('ERROR')

    await loop.adoptRemoteTasks()

    expect(existsSync(stopFile)).toBe(true)
    expect(logged.filter((line) => line.includes('ERROR'))).toEqual([expect.stringContaining(
      `issue #${issueNumber} adoption deferred 20 consecutive times (permission lookup failed); stopping the loop`)])
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    expect((await forge.getIssue(issueNumber)).labels).toEqual(labelsBefore)
    expect(forge.issueComments.get(issueNumber)).toEqual(commentsBefore)
    expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()
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

  it('keeps an adopted issue merge-ready until its posted merge marker is visible', async () => {
    const task = pushWorkerBranch('20260809_000000_020_auto-lagging-marker')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const listIssueComments = forge.listIssueComments.bind(forge)
    let markerVisible = false
    forge.listIssueComments = async (number) => {
      const comments = await listIssueComments(number)
      return markerVisible ? comments : comments.filter((comment) => !comment.body.startsWith('MERGED: '))
    }
    const loop = makeLoop(stubProject)

    await loop.adoptRemoteTasks()

    const mergedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({ mergeCommit: mergedHead })
    expect(issuePromotionForIssue(paths, issueNumber)?.commentConfirmed).not.toBe(true)
    expect((await forge.getIssue(issueNumber)).labels).toContain(LABEL_MERGE_READY)
    expect(logged.join('\n')).toContain(
      `could not update adopted issue #${issueNumber}: merge comment is not visible after publishing it`)

    await loop.adoptRemoteTasks()
    await loop.adoptRemoteTasks()

    expect(forge.issueComments.get(issueNumber)?.filter((comment) => comment.startsWith('MERGED: ')))
      .toHaveLength(1)
    expect(issuePromotionForIssue(paths, issueNumber)?.commentConfirmed).not.toBe(true)
    expect((await forge.getIssue(issueNumber)).labels).toContain(LABEL_MERGE_READY)
    expect(logged.filter((line) => line.includes(
      `could not update adopted issue #${issueNumber}: merge comment is not visible`))).toHaveLength(1)

    markerVisible = true
    await loop.adoptRemoteTasks()

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(mergedHead)
    expect(issuePromotionForIssue(paths, issueNumber)?.commentConfirmed).toBe(true)
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_READY)
    expect(forge.issueComments.get(issueNumber)?.filter((comment) => comment.startsWith('MERGED: ')))
      .toHaveLength(1)
    expect(logged.at(-1)).toMatch(/^Recovered updating adopted issue #\d+ after \d+ minutes$/)
  })

  it('keeps an adopted issue merge-ready while its merge marker author\'s access is undetermined', async () => {
    const task = pushWorkerBranch('20260809_000000_021_auto-undetermined-marker')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const commentIssue = forge.commentIssue.bind(forge)
    forge.commentIssue = async (number, comment) => {
      await commentIssue(number, comment)
      if (comment.startsWith('MERGED: ')) {
        forge.issueCommentAuthors.get(number)!.splice(-1, 1,
          { login: 'merger', hasWriteAccess: false, permissionLookupFailed: true })
      }
    }
    await makeLoop(stubProject).adoptRemoteTasks()

    const mergedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({ mergeCommit: mergedHead })
    expect(forge.issueComments.get(issueNumber)?.filter((comment) => comment.startsWith('MERGED: ')))
      .toHaveLength(1)

    // A new run finds the marker already standing under the undetermined author.
    logged = []
    const loop = makeLoop(stubProject)
    await loop.adoptRemoteTasks()
    await loop.adoptRemoteTasks()

    expect(forge.issueComments.get(issueNumber)?.filter((comment) => comment.startsWith('MERGED: ')))
      .toHaveLength(1)
    expect(issuePromotionForIssue(paths, issueNumber)?.commentConfirmed).not.toBe(true)
    expect((await forge.getIssue(issueNumber)).labels).toContain(LABEL_MERGE_READY)
    expect(logged.filter((line) => line.includes(`could not update adopted issue #${issueNumber}: `
      + 'merge marker author permission could not be read; deferring'))).toHaveLength(1)

    const authors = forge.issueCommentAuthors.get(issueNumber)!
    authors[authors.length - 1] = { login: 'merger', hasWriteAccess: true }
    await loop.adoptRemoteTasks()

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(mergedHead)
    expect(issuePromotionForIssue(paths, issueNumber)?.commentConfirmed).toBe(true)
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_READY)
    expect(forge.issueComments.get(issueNumber)?.filter((comment) => comment.startsWith('MERGED: ')))
      .toHaveLength(1)
    expect(logged.at(-1)).toMatch(/^Recovered updating adopted issue #\d+ after \d+ minutes$/)
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

  it('synchronizes dependencies when a promotion retry succeeds after the remote merge', async () => {
    const task = pushWorkerBranch('20260809_000000_009_auto-retried-promotion-deps')
    writeFileSync(join(workerRoot, 'package.json'), '{"private":true}\n')
    git(workerRoot, ['add', 'package.json'])
    git(workerRoot, ['commit', '-qm', 'chore: add worker package manifest'])
    git(workerRoot, ['push', '-q', 'origin', task.branch])
    task.head = git(workerRoot, ['rev-parse', 'HEAD']).trim()
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    let installs = 0
    mocks.failedPromotionRenames = 1

    try {
      await makeLoop(stubProject, {
        packageRoot: repoRoot,
        install: () => {
          installs += 1
        },
      }).adoptRemoteTasks()
    } finally {
      mocks.failedPromotionRenames = 0
    }

    const mergedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({
      issueNumber,
      mergeCommit: mergedHead,
      runBranch: 'main',
    })
    expect(installs).toBe(1)
    expect(logged.some((line) => /Installed/.test(line))).toBe(true)
    expect(logged.some((line) => /Merged/.test(line))).toBe(true)
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
    const resumeFlag = join(paths.queueDir, 'cycle-resume-1')
    writeFileSync(resumeFlag, '')
    let completeFlagAtUpdate = true
    let resumeFlagAtUpdate = true
    forge.commentIssue = async () => {
      completeFlagAtUpdate = existsSync(completeFlag)
      resumeFlagAtUpdate = existsSync(resumeFlag)
      throw new ForgeRateLimitError(new Date('2026-08-09T12:05:00Z'))
    }

    await loop.adoptRemoteTasks()

    expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({
      issueNumber,
      mergeCommit: git(repoRoot, ['rev-parse', 'HEAD']).trim(),
    })
    expect(completeFlagAtUpdate).toBe(false)
    expect(existsSync(completeFlag)).toBe(false)
    expect(resumeFlagAtUpdate).toBe(false)
    expect(existsSync(resumeFlag)).toBe(false)
  })
})
