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

import { ForgeRateLimitError } from '../src/adapters/forge.ts'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { loadConfig } from '../src/config.ts'
import {
  issuePromotionForIssue, LABEL_FINDING, LABEL_MERGE_FAILED, LABEL_MERGE_READY, LABEL_READY,
} from '../src/issueQueue.ts'
import { createLoop } from '../src/loop.ts'
import { TEST_LOCK_BUSY_EXIT_CODE, type OrchestrationDepsRuntime } from '../src/merge.ts'
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
  it('resets the deferral count and logs recovery once the adoption gets past the fetch', async () => {
    const task = pushWorkerBranch('20260809_000000_024_auto-fetch-recovers')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    // A busy test lock keeps the issue merge-ready after the fetch succeeds, so the
    // deferrals that follow show whether the count started again.
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'adoption-deferral-reset',
      mergeChecks: () => [{
        label: 'Locked suite',
        cwd: '',
        command: `node -e "process.exit(${TEST_LOCK_BUSY_EXIT_CODE})"`,
      }],
    }
    const loop = makeLoop(project)
    const stopFile = join(paths.queueDir, 'stop')
    workerFetches.failure = 'fatal: unable to access the remote: Could not resolve host'

    for (let poll = 0; poll < 19; poll += 1) await loop.adoptRemoteTasks()
    workerFetches.failure = undefined
    await loop.adoptRemoteTasks()

    expect(logged.filter((line) => line.includes('Recovered'))).toEqual([
      expect.stringContaining(`Recovered adopting issue #${issueNumber}`),
    ])
    expect(logged.join('\n')).toContain('adoption deferred: the repository test lock stayed busy')

    workerFetches.failure = 'fatal: unable to access the remote: Could not resolve host'
    for (let poll = 0; poll < 19; poll += 1) await loop.adoptRemoteTasks()

    expect(existsSync(stopFile)).toBe(false)
    expect(logged.join('\n')).not.toContain('ERROR')
    expect(logged.filter((line) => line.includes(`issue #${issueNumber} adoption deferred`)))
      .toHaveLength(2)
    expect((await forge.getIssue(issueNumber)).labels).toContain(LABEL_MERGE_READY)
  })

  it('stops the loop on the twentieth consecutive comment-listing deferral', async () => {
    const task = pushWorkerBranch('20260809_000000_029_auto-comments-never-clear')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const labelsBefore = (await forge.getIssue(issueNumber)).labels
    const commentsBefore = [...forge.issueComments.get(issueNumber)!]
    forge.listIssueComments = async () => {
      throw new Error('HTTP 502: Bad Gateway')
    }
    const loop = makeLoop(stubProject)
    const stopFile = join(paths.queueDir, 'stop')

    for (let poll = 1; poll < 20; poll += 1) await loop.adoptRemoteTasks()

    expect(existsSync(stopFile)).toBe(false)
    expect(logged.filter((line) => line.includes('adoption deferred'))).toHaveLength(1)

    await loop.adoptRemoteTasks()

    expect(existsSync(stopFile)).toBe(true)
    const errors = logged.filter((line) => line.includes('ERROR'))
    expect(errors).toEqual([expect.stringContaining(
      `issue #${issueNumber} adoption deferred 20 consecutive times (comment listing failed); stopping the loop`)])
    expect(errors[0]).not.toContain('Bad Gateway')
    expect((await forge.getIssue(issueNumber)).labels).toEqual(labelsBefore)
    expect(forge.issueComments.get(issueNumber)).toEqual(commentsBefore)
  })

  it('does not count a rate-limited comment listing as a deferral', async () => {
    const task = pushWorkerBranch('20260809_000000_030_auto-comments-rate-limited')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    forge.listIssueComments = async () => {
      throw new ForgeRateLimitError(new Date('2026-08-09T12:05:00Z'))
    }
    const loop = makeLoop(stubProject)

    for (let poll = 0; poll < 25; poll += 1) await loop.adoptRemoteTasks()

    expect(existsSync(join(paths.queueDir, 'stop'))).toBe(false)
    expect(logged.join('\n')).not.toContain('adoption deferred')
    expect(logged.join('\n')).not.toContain('ERROR')
    expect((await forge.getIssue(issueNumber)).labels).toContain(LABEL_MERGE_READY)
  })

  it.each([
    'fatal: Couldn\'t find remote ref',
    'fatal: couldn\'t find remote ref',
  ])('fails the adoption at once as a missing branch when git prints %s', async (reason) => {
    const branch = 'task/20260809_000000_031_auto-missing-ref-case'
    const issueNumber = await mergeReadyIssue(branch, 'e'.repeat(40))
    workerFetches.failure = `${reason} refs/heads/${branch}`

    await makeLoop(stubProject).adoptRemoteTasks()

    expect(logged.join('\n')).not.toContain('adoption deferred')
    expect(forge.issueComments.get(issueNumber)?.at(-1))
      .toBe(`Remote task adoption failed: Could not fetch ${branch} from origin.`)
    expect((await forge.getIssue(issueNumber)).labels).toContain(LABEL_MERGE_FAILED)
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('1')
  })

  it('adopts a worker branch when the run branch reads empty once', async () => {
    const task = pushWorkerBranch('20260809_000000_021_auto-transient-run-branch')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const loop = makeLoop(stubProject)
    runBranchReads.failures = 1

    await loop.adoptRemoteTasks()

    expect(runBranchReads.failures).toBe(0)
    const mergeCommit = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({
      issueNumber, mergeCommit, runBranch: 'main',
    })
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_FAILED)
    expect(logged.join('\n')).not.toContain('the run branch could not be read')
  })

  it('defers adoption with one warning and posts no git output while the run branch is unreadable', async () => {
    const task = pushWorkerBranch('20260809_000000_022_auto-unreadable-run-branch')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const loop = makeLoop(stubProject)
    runBranchReads.failures = Number.POSITIVE_INFINITY
    runBranchReads.answer = Object.assign(
      new Error('Command failed: git branch --show-current\nfatal: unable to read HEAD-secret-detail'),
      { status: 128, stderr: 'fatal: unable to read HEAD-secret-detail' },
    )

    await loop.adoptRemoteTasks()
    await loop.adoptRemoteTasks()

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    const issue = await forge.getIssue(issueNumber)
    expect(issue.labels).toContain(LABEL_MERGE_READY)
    expect(issue.labels).not.toContain(LABEL_MERGE_FAILED)
    const comments = forge.issueComments.get(issueNumber)?.join('\n') ?? ''
    expect(comments).not.toContain('Remote task adoption failed')
    expect(comments).not.toContain('HEAD-secret-detail')
    expect(existsSync(join(paths.queueDir, 'merge-failure-count.txt'))
      ? readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()
      : '0').toBe('0')
    expect(logged.filter((line) =>
      line.includes('remote adoption deferred: the run branch could not be read'))).toHaveLength(1)
    expect(logged.join('\n')).not.toContain('HEAD-secret-detail')
    expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()

    runBranchReads.failures = 0
    await loop.adoptRemoteTasks()

    expect(issuePromotionForIssue(paths, issueNumber)).toMatchObject({ runBranch: 'main' })
    expect(logged.some((line) => line.startsWith('Recovered reading the run branch'))).toBe(true)
  })

  it('leaves a closed run pull request\'s issues alone while the held branch is unreadable', async () => {
    const task = pushWorkerBranch('20260809_000000_023_auto-unreadable-held-branch')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const loop = makeLoop(stubProject)
    await loop.adoptRemoteTasks()
    const promotion = issuePromotionForIssue(paths, issueNumber)
    expect(promotion).toMatchObject({ runBranch: 'main' })
    forge.prStatusValue = {
      state: 'closed', isDraft: false, url: 'https://example.test/pull/1', headSha: '', checks: [],
    }
    runBranchReads.failures = Number.POSITIVE_INFINITY
    runBranchReads.answer = ''
    runBranchReads.includeOptional = false

    expect(await loop.poll()).toBe('continue')

    const issue = await forge.getIssue(issueNumber)
    expect(issue.state).toBe('open')
    expect(issue.labels).not.toContain(LABEL_READY)
    expect(forge.issueComments.get(issueNumber)?.join('\n')).not.toContain('UNPROMOTED:')
    expect(issuePromotionForIssue(paths, issueNumber)).toEqual(promotion)
    expect(logged.join('\n'))
      .toContain('could not close promoted issues: the checkout is not on a branch')
  })
})
