import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import type { Runner } from '../src/adapters/runner.ts'
import { loadConfig } from '../src/config.ts'
import { createLoop } from '../src/loop.ts'
import {
  buildIssueBody, LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_MERGE_READY,
  LABEL_RETRY_EXHAUSTED, issueNumbersForTask, recordIssuesForTask,
} from '../src/issueQueue.ts'
import {
  branchName, finalMessageFile, logFile, orchPaths, worktreeDir, type OrchPaths,
} from '../src/paths.ts'
import { readStatus, writeStatus } from '../src/status.ts'
import { makeFakeForge, type FakeForge } from './fakeForge.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import { stubProject } from './stubProject.ts'

let tempRoot: string
let repoRoot: string
let origin: string
let paths: OrchPaths
let forge: FakeForge
let logged: string[]

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

const project: ProjectAdapter = {
  ...stubProject,
  name: 'worker-test',
  mergeChecks: () => [],
  cycleSuite: () => [],
}

const runner: Runner = {
  sharedSkills: fakeRunnerSharedSkills,
  start: async () => process.pid,
}

async function completedTask(taskId: string, commit: boolean): Promise<void> {
  const worktree = worktreeDir(paths, taskId)
  git(repoRoot, ['worktree', 'add', worktree, '-b', branchName(taskId)])
  if (commit) {
    writeFileSync(join(worktree, 'worker-change.txt'), `${taskId}\n`)
    git(worktree, ['add', 'worker-change.txt'])
    git(worktree, ['commit', '-qm', 'feat: worker change'])
  }
  await writeStatus(paths, taskId, 'completed')
}

async function claimedIssue(taskId: string, inspect = false): Promise<number> {
  const issueNumber = await forge.createIssue({
    title: 'shared work',
    body: buildIssueBody('[BUG] complete shared work', 'parent', undefined, undefined, inspect),
    labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    assignees: [forge.user],
  })
  recordIssuesForTask(paths, taskId, [issueNumber])
  if (inspect) {
    const inspectDir = join(paths.queueDir, 'inspect')
    mkdirSync(inspectDir, { recursive: true })
    writeFileSync(join(inspectDir, taskId), '')
  }
  return issueNumber
}

async function groupedIssues(taskId: string): Promise<number[]> {
  const issueNumbers = await Promise.all([1, 2].map((index) => forge.createIssue({
    title: `[BUG] \`src/shared.ts\` grouped requirement ${index}`,
    body: buildIssueBody(`[BUG] \`src/shared.ts\` grouped requirement ${index}`, 'parent'),
    labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
    assignees: [forge.user],
  })))
  recordIssuesForTask(paths, taskId, issueNumbers)
  return issueNumbers
}

function taskClaiming(issueNumber: number): string | undefined {
  const issueMap = join(paths.queueDir, 'issue-map')
  if (!existsSync(issueMap)) return undefined
  return readdirSync(issueMap).find((taskId) =>
    issueNumbersForTask(paths, taskId).includes(issueNumber))
}

function makeWorkerLoop(env: Record<string, string> = {}) {
  const config = loadConfig({
    ISSUE_QUEUE_ENABLED: 'true',
    WORKER_MODE: 'true',
    SCAN_ENABLED: 'true',
    ...env,
  })
  const loop = createLoop({
    paths,
    config,
    forge,
    runner,
    project,
    log: (line) => logged.push(line),
    now: () => new Date('2026-08-09T12:00:00Z'),
  })
  loop.initializeSessionStateForBranch()
  return loop
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'orch-worker-'))
  repoRoot = join(tempRoot, 'merger')
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
  paths = orchPaths(repoRoot)
  forge = makeFakeForge()
  logged = []
})

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('worker mode', () => {
  it('fails a grouped task whose final message lacks a per-issue completion marker', async () => {
    const taskId = '20260809_000000_003_auto-grouped-fix'
    await completedTask(taskId, true)
    const issueNumbers = await groupedIssues(taskId)
    writeFileSync(finalMessageFile(paths, taskId),
      `TASK_COMPLETE\nREQUIREMENT_COMPLETE: #${issueNumbers[0]}\n`)
    const loop = makeWorkerLoop()

    await loop.poll()

    expect(() => git(origin, ['rev-parse', `refs/heads/${branchName(taskId)}`])).toThrow()
    expect(logged.join('\n')).toContain(`missing requirement completion markers for #${issueNumbers[1]}`)
    expect(readStatus(paths, taskId)?.status).toBe('failed')

    await loop.poll()

    expect(logged.join('\n')).toContain('Released 003_auto    grouped task failed')
    expect(issueNumbersForTask(paths, taskId)).toEqual([])
    for (const issueNumber of issueNumbers) {
      expect(taskClaiming(issueNumber)).not.toBe(taskId)
      expect((await forge.getIssue(issueNumber)).labels).not.toContain(LABEL_MERGE_READY)
    }
  })

  it('publishes a grouped branch when every per-issue completion marker is present', async () => {
    const taskId = '20260809_000000_003_auto-grouped-fix'
    await completedTask(taskId, true)
    const issueNumbers = await groupedIssues(taskId)
    writeFileSync(finalMessageFile(paths, taskId), [
      'TASK_COMPLETE',
      `REQUIREMENT_COMPLETE: #${issueNumbers[0]}`,
      `REQUIREMENT_COMPLETE: #${issueNumbers[1]}`,
      '',
    ].join('\n'))
    const loop = makeWorkerLoop()

    await loop.poll()

    for (const issueNumber of issueNumbers) {
      const issue = await forge.getIssue(issueNumber)
      expect(issue.labels).toContain(LABEL_MERGE_READY)
      expect(forge.issueComments.get(issueNumber)?.join('\n'))
        .toContain(`Issues: #${issueNumbers[0]} #${issueNumbers[1]}`)
    }
  })

  it('pushes a completed task and relabels its issue as merge-ready without merging locally', async () => {
    git(repoRoot, ['remote', 'rename', 'origin', 'shared'])
    const taskId = '20260809_000000_001_auto-shared-fix'
    await completedTask(taskId, true)
    const issueNumber = await claimedIssue(taskId)
    const loop = makeWorkerLoop()

    expect(await loop.poll()).toBe('continue')

    const issue = await forge.getIssue(issueNumber)
    const remoteHead = git(origin, ['rev-parse', `refs/heads/${branchName(taskId)}`]).trim()
    const localTaskHead = git(worktreeDir(paths, taskId), ['rev-parse', 'HEAD']).trim()
    expect(remoteHead).toBe(localTaskHead)
    expect(git(worktreeDir(paths, taskId), [
      'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
    ]).trim()).toBe(`shared/${branchName(taskId)}`)
    expect(issue.labels).toContain(LABEL_MERGE_READY)
    expect(issue.labels).not.toContain(LABEL_IN_PROGRESS)
    expect(forge.issueComments.get(issueNumber)?.join('\n')).toContain(`Branch: ${branchName(taskId)}`)
    expect(forge.issueComments.get(issueNumber)?.join('\n')).toContain(`Head commit: ${localTaskHead}`)
    expect(existsSync(join(repoRoot, 'worker-change.txt'))).toBe(false)
    expect(logged.join('\n')).toContain('Idle Status      Task=0  Queue=0')
    expect(logged.join('\n')).not.toContain('cycle')
  })

  it('keeps the inspection completion path when its final message has a no-change marker', async () => {
    const taskId = '20260809_000000_002_auto-inspection'
    await completedTask(taskId, false)
    const issueNumber = await claimedIssue(taskId, true)
    writeFileSync(finalMessageFile(paths, taskId),
      'The inspection found nothing to change.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    const loop = makeWorkerLoop()

    expect(await loop.poll()).toBe('continue')

    expect((await forge.getIssue(issueNumber)).state).toBe('closed')
    expect(forge.issueComments.get(issueNumber)?.join('\n'))
      .toContain(`Inspection task ${taskId} completed without commits.`)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(existsSync(worktreeDir(paths, taskId))).toBe(true)
    expect(() => git(origin, ['rev-parse', `refs/heads/${branchName(taskId)}`])).toThrow()
  })

  it('closes an explicit no-change task without publishing an empty branch', async () => {
    const taskId = '20260809_000000_004_auto-already-resolved'
    git(repoRoot, ['checkout', '--detach'])
    await completedTask(taskId, false)
    const issueNumber = await claimedIssue(taskId)
    writeFileSync(finalMessageFile(paths, taskId),
      'The reported defect no longer reproduces.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    const loop = makeWorkerLoop()

    expect(await loop.poll()).toBe('continue')

    expect((await forge.getIssue(issueNumber)).state).toBe('closed')
    expect(forge.issueComments.get(issueNumber)?.join('\n')).toContain('no change was warranted')
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
    expect(existsSync(worktreeDir(paths, taskId))).toBe(false)
    expect(() => git(origin, ['rev-parse', `refs/heads/${branchName(taskId)}`])).toThrow()
  })

  it('counts an unpublishable completion that never clears until its issue is parked', async () => {
    const firstTaskId = '20260809_000000_005_auto-dirty-attempt'
    await completedTask(firstTaskId, true)
    const issueNumber = await claimedIssue(firstTaskId)
    const loop = makeWorkerLoop({ MAX_ISSUE_RETRIES: '2' })
    const attempts: string[] = []

    let next: string | undefined = firstTaskId
    while (next !== undefined && attempts.length < 3) {
      const taskId: string = next
      attempts.push(taskId)
      // Every worker for this issue finishes with work it never committed.
      await writeStatus(paths, taskId, 'completed')
      writeFileSync(join(worktreeDir(paths, taskId), 'left-behind.txt'), 'uncommitted\n')

      await loop.poll()
      expect(readStatus(paths, taskId)?.status).toBe('failed')
      expect(logged.join('\n')).toContain(`${taskId} has uncommitted changes`)
      expect(readFileSync(logFile(paths, taskId), 'utf8'))
        .toContain(`Worker publication refused: ${taskId} has uncommitted changes`)
      await loop.poll()

      expect(() => git(origin, ['rev-parse', `refs/heads/${branchName(taskId)}`])).toThrow()
      expect(taskClaiming(issueNumber)).not.toBe(taskId)
      next = taskClaiming(issueNumber)
    }

    expect(attempts).toHaveLength(2)
    const labels = (await forge.getIssue(issueNumber)).labels
    expect(labels).toContain(LABEL_RETRY_EXHAUSTED)
    expect(labels).not.toContain(LABEL_IN_PROGRESS)
    expect(labels).not.toContain(LABEL_MERGE_READY)
    expect(logged.join('\n')).toContain(`Parked #${issueNumber}`)
  })
})
