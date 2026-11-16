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
  issuePromotionForIssue, LABEL_FINDING, LABEL_MERGE_FAILED, LABEL_MERGE_READY,
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
  it('defers adoption without counting a failure when the test lock stays busy', async () => {
    const task = pushWorkerBranch('20260809_000000_008_auto-test-lock-busy')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'adoption-lock-busy',
      mergeChecks: () => [{
        label: 'Locked suite',
        cwd: '',
        command: `node -e "process.exit(${TEST_LOCK_BUSY_EXIT_CODE})"`,
      }],
    }

    await makeLoop(project).adoptRemoteTasks()

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    const issue = await forge.getIssue(issueNumber)
    expect(issue.labels).toContain(LABEL_MERGE_READY)
    expect(issue.labels).not.toContain(LABEL_MERGE_FAILED)
    expect(forge.issueComments.get(issueNumber)?.join('\n'))
      .not.toContain('Remote task adoption failed')
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('0')
    expect(readFileSync(join(paths.logsDir, `issue-${issueNumber}.merge.log`), 'utf8'))
      .toContain('the repository test lock stayed busy')
    expect(logged.join('\n'))
      .toContain('008_auto adoption deferred: the repository test lock stayed busy')
    expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()
  })

  it('defers adoption without counting a failure when the run branch moved while the gate ran', async () => {
    const task = pushWorkerBranch('20260809_000000_025_auto-run-branch-moved')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'adoption-run-branch-moved',
      mergeChecks: () => {
        git(repoRoot, ['commit', '-q', '--allow-empty', '-m', 'chore: land a hand merge'])
        return []
      },
    }

    await makeLoop(project).adoptRemoteTasks()

    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe('chore: land a hand merge')
    const issue = await forge.getIssue(issueNumber)
    expect(issue.labels).toContain(LABEL_MERGE_READY)
    expect(issue.labels).not.toContain(LABEL_MERGE_FAILED)
    expect(forge.issueComments.get(issueNumber)?.join('\n'))
      .not.toContain('Remote task adoption failed')
    expect(readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()).toBe('0')
    expect(readFileSync(join(paths.logsDir, `issue-${issueNumber}.merge.log`), 'utf8'))
      .toContain('The integration checkout moved while the merge gate ran')
    expect(logged.join('\n'))
      .toContain('025_auto adoption deferred: the run branch moved while the gate ran')
    expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()
  })

  it('defers adoption without counting a failure when the reporter\'s access is undetermined', async () => {
    const task = pushWorkerBranch('20260809_000000_019_auto-report-permission-unknown')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    forge.issueCommentAuthors.get(issueNumber)![0] =
      { login: 'maintainer-one', hasWriteAccess: false, permissionLookupFailed: true }
    const loop = makeLoop(stubProject)

    await loop.adoptRemoteTasks()

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    const issue = await forge.getIssue(issueNumber)
    expect(issue.labels).toContain(LABEL_MERGE_READY)
    expect(issue.labels).not.toContain(LABEL_MERGE_FAILED)
    expect(forge.issueComments.get(issueNumber)?.join('\n'))
      .not.toContain('Remote task adoption failed')
    expect(existsSync(join(paths.queueDir, 'merge-failure-count.txt'))
      ? readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()
      : '0').toBe('0')
    expect(logged.join('\n')).toContain(`issue #${issueNumber} adoption deferred: `
      + `the worker branch report on issue #${issueNumber} has an author whose write access could not be determined`)
    expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()

    forge.issueCommentAuthors.get(issueNumber)![0] = { login: 'maintainer-one', hasWriteAccess: true }
    await loop.adoptRemoteTasks()

    expect(issuePromotionForIssue(paths, issueNumber)).toBeDefined()
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_READY)
  })

  it('defers adoption without counting a failure when the forge cannot list the comments', async () => {
    const task = pushWorkerBranch('20260809_000000_021_auto-comments-unavailable')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const listIssueComments = forge.listIssueComments.bind(forge)
    let outage = true
    forge.listIssueComments = async (number) => {
      if (outage) throw new Error('HTTP 502: Bad Gateway')
      return listIssueComments(number)
    }
    const loop = makeLoop(stubProject)

    await loop.adoptRemoteTasks()

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    const issue = await forge.getIssue(issueNumber)
    expect(issue.labels).toContain(LABEL_MERGE_READY)
    expect(issue.labels).not.toContain(LABEL_MERGE_FAILED)
    expect(forge.issueComments.get(issueNumber)?.join('\n'))
      .not.toContain('Remote task adoption failed')
    expect(existsSync(join(paths.queueDir, 'merge-failure-count.txt'))
      ? readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()
      : '0').toBe('0')
    expect(logged.filter((line) => line.includes('adoption deferred'))).toEqual([
      expect.stringContaining(
        `issue #${issueNumber} adoption deferred: could not read the comments on issue #${issueNumber}`),
    ])
    expect(readFileSync(join(paths.logsDir, `issue-${issueNumber}.merge.log`), 'utf8'))
      .toContain('HTTP 502: Bad Gateway')

    outage = false
    await loop.adoptRemoteTasks()

    expect(issuePromotionForIssue(paths, issueNumber)).toBeDefined()
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_READY)
  })

  it('defers adoption without counting a failure when the push remote is unreachable', async () => {
    const task = pushWorkerBranch('20260809_000000_022_auto-remote-unreachable')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['remote', 'set-url', 'origin', join(tempRoot, 'unreachable.git')])
    const loop = makeLoop(stubProject)

    await loop.adoptRemoteTasks()

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    const issue = await forge.getIssue(issueNumber)
    expect(issue.labels).toContain(LABEL_MERGE_READY)
    expect(issue.labels).not.toContain(LABEL_MERGE_FAILED)
    expect(forge.issueComments.get(issueNumber)?.join('\n'))
      .not.toContain('Remote task adoption failed')
    expect(existsSync(join(paths.queueDir, 'merge-failure-count.txt'))
      ? readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()
      : '0').toBe('0')
    expect(logged.filter((line) => line.includes('adoption deferred'))).toEqual([
      expect.stringContaining(
        `issue #${issueNumber} adoption deferred: could not fetch ${task.branch} from origin`),
    ])
    expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()

    git(repoRoot, ['remote', 'set-url', 'origin', origin])
    await loop.adoptRemoteTasks()

    expect(issuePromotionForIssue(paths, issueNumber)).toBeDefined()
    expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_READY)
  })

  it('stops the loop on the twentieth consecutive fetch deferral of one issue', async () => {
    const task = pushWorkerBranch('20260809_000000_023_auto-fetch-never-clears')
    const issueNumber = await mergeReadyIssue(task.branch, task.head)
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const labelsBefore = (await forge.getIssue(issueNumber)).labels
    const commentsBefore = [...forge.issueComments.get(issueNumber)!]
    git(repoRoot, ['remote', 'set-url', 'origin', join(tempRoot, 'unreachable.git')])
    const loop = makeLoop(stubProject)
    const stopFile = join(paths.queueDir, 'stop')

    for (let poll = 1; poll < 20; poll += 1) await loop.adoptRemoteTasks()

    expect(existsSync(stopFile)).toBe(false)
    expect(logged.filter((line) => line.includes('adoption deferred'))).toEqual([
      expect.stringContaining(
        `issue #${issueNumber} adoption deferred: could not fetch ${task.branch} from origin`),
    ])
    expect(logged.join('\n')).not.toContain('ERROR')

    await loop.adoptRemoteTasks()

    expect(existsSync(stopFile)).toBe(true)
    const errors = logged.filter((line) => line.includes('ERROR'))
    expect(errors).toEqual([expect.stringContaining(
      `issue #${issueNumber} adoption deferred 20 consecutive times (fetch failed); stopping the loop`)])
    expect(errors[0]).not.toContain('unreachable.git')
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
    expect((await forge.getIssue(issueNumber)).labels).toEqual(labelsBefore)
    expect(forge.issueComments.get(issueNumber)).toEqual(commentsBefore)
    expect(existsSync(join(paths.queueDir, 'merge-failure-count.txt'))
      ? readFileSync(join(paths.queueDir, 'merge-failure-count.txt'), 'utf8').trim()
      : '0').toBe('0')
    expect(issuePromotionForIssue(paths, issueNumber)).toBeUndefined()
  })

  it('counts the deferrals of two issues separately', async () => {
    const first = await mergeReadyIssue('task/20260809_000000_027_auto-first-deferred', 'c'.repeat(40))
    const second = await mergeReadyIssue('task/20260809_000000_028_auto-second-deferred', 'd'.repeat(40))
    workerFetches.failure = 'fatal: unable to access the remote: Could not resolve host'
    const loop = makeLoop(stubProject)
    const stopFile = join(paths.queueDir, 'stop')

    for (let poll = 0; poll < 10; poll += 1) await loop.adoptRemoteTasks()
    // Twenty deferrals in all, but only ten of either issue.
    expect(existsSync(stopFile)).toBe(false)
    expect(logged.join('\n')).not.toContain('ERROR')

    for (let poll = 0; poll < 10; poll += 1) await loop.adoptRemoteTasks()

    expect(existsSync(stopFile)).toBe(true)
    expect(logged.filter((line) => line.includes('ERROR'))).toEqual([
      expect.stringContaining(`issue #${first} adoption deferred 20 consecutive times (fetch failed)`),
    ])
    expect(logged.filter((line) => line.includes('adoption deferred:'))).toEqual([
      expect.stringContaining(`issue #${first} adoption deferred:`),
      expect.stringContaining(`issue #${second} adoption deferred:`),
    ])
    for (const issueNumber of [first, second]) {
      expect((await forge.getIssue(issueNumber)).labels).toContain(LABEL_MERGE_READY)
    }
  })
})
