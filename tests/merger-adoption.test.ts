import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import type { Runner } from '../src/adapters/runner.ts'
import { loadConfig } from '../src/config.ts'
import {
  issuePromotionForIssue, LABEL_FINDING, LABEL_MERGE_FAILED, LABEL_MERGE_READY,
} from '../src/issueQueue.ts'
import { createLoop } from '../src/loop.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { makeFakeForge, type FakeForge } from './fakeForge.ts'
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

function makeLoop(project: ProjectAdapter) {
  const loop = createLoop({
    paths,
    config: loadConfig({ ISSUE_QUEUE_ENABLED: 'true', SCAN_ENABLED: 'false' }),
    forge,
    runner,
    project,
    log: (line) => logged.push(line),
    now: () => new Date('2026-08-09T12:00:00Z'),
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
    expect(logged).toContain('Failed 004_auto    log 004_auto.merge.log')
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
})
