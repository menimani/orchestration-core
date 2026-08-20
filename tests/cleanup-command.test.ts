import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupTask } from '../src/cleanup.ts'
import {
  CLEANUP_USAGE, runCleanupCommand, type CleanupCommandRuntime,
} from '../src/cleanupCommand.ts'
import {
  completeIssueReleaseIntent, issueNumbersForTask, issueReleaseIntentForTask,
  issueReleasePreparationForTask, LABEL_FINDING, LABEL_GROUP_SINGLETON, LABEL_IN_PROGRESS,
  LABEL_MERGE_FAILED, LABEL_MERGE_READY, LABEL_READY, prepareIssueReleaseIntent,
  reapStaleLeases, reconcileIssueReleaseIntents, recordIssueReleaseIntent, recordIssuesForTask,
} from '../src/issueQueue.ts'
import { finalMessageFile, orchPaths, statusFile, type OrchPaths } from '../src/paths.ts'
import { specFile } from '../src/tasks.ts'
import { makeFakeForge } from './fakeForge.ts'

let repoRoot: string
let paths: OrchPaths
const taskId = '20260813_184040_037_auto-cleanup-claim'

function runtime(
  overrides: Partial<CleanupCommandRuntime> = {},
): CleanupCommandRuntime {
  return {
    issueQueueEnabled: vi.fn(() => true),
    loadForge: vi.fn(async () => makeFakeForge()),
    cleanup: vi.fn(),
    error: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-cleanup-command-'))
  paths = orchPaths(repoRoot)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('cleanup command', () => {
  it('prints usage without reading configuration or loading the forge', async () => {
    const commandRuntime = runtime()

    await expect(runCleanupCommand(paths, [], commandRuntime)).resolves.toBe(1)

    expect(commandRuntime.error).toHaveBeenCalledWith(CLEANUP_USAGE)
    expect(commandRuntime.issueQueueEnabled).not.toHaveBeenCalled()
    expect(commandRuntime.loadForge).not.toHaveBeenCalled()
    expect(commandRuntime.cleanup).not.toHaveBeenCalled()
  })

  it('does not contact the forge when the issue queue is disabled', async () => {
    recordIssuesForTask(paths, taskId, [41])
    const commandRuntime = runtime({ issueQueueEnabled: () => false })

    await expect(runCleanupCommand(paths, [taskId], commandRuntime)).resolves.toBe(0)

    expect(commandRuntime.cleanup).toHaveBeenCalledWith(paths, taskId)
    expect(commandRuntime.loadForge).not.toHaveBeenCalled()
    expect(issueNumbersForTask(paths, taskId)).toEqual([41])
  })

  it('keeps prepared release intent hidden from reconciliation until cleanup completes', async () => {
    recordIssuesForTask(paths, taskId, [41, 42])
    const commandRuntime = runtime({
      cleanup: vi.fn(() => {
        expect(issueReleasePreparationForTask(paths, taskId)).toEqual([41, 42])
        expect(issueReleaseIntentForTask(paths, taskId)).toEqual([])
      }),
    })

    await expect(runCleanupCommand(paths, [taskId], commandRuntime)).resolves.toBe(0)

    expect(commandRuntime.cleanup).toHaveBeenCalledWith(paths, taskId)
  })

  it('does not release a claim while local cleanup has only prepared its intent', async () => {
    const forge = makeFakeForge('worker-a')
    const issueNumber = await forge.createIssue({
      title: 'concurrent cleanup',
      body: 'claimed work',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: [forge.user],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    writeFileSync(statusFile(paths, taskId), JSON.stringify({ task_id: taskId, pid: null }))
    prepareIssueReleaseIntent(paths, taskId, [issueNumber])

    await expect(reconcileIssueReleaseIntents(forge, paths)).resolves.toEqual([])

    const claimed = await forge.getIssue(issueNumber)
    expect(claimed.labels).toContain(LABEL_IN_PROGRESS)
    expect(claimed.labels).not.toContain(LABEL_READY)
    expect(claimed.assignees).toEqual([forge.user])

    completeIssueReleaseIntent(paths, taskId)
    await expect(reconcileIssueReleaseIntents(forge, paths)).resolves.toEqual([])
    const released = await forge.getIssue(issueNumber)
    expect(released.labels).toContain(LABEL_READY)
    expect(released.assignees).toEqual([])
  })

  it('removes release preparation when local cleanup fails', async () => {
    recordIssuesForTask(paths, taskId, [41, 42])
    const cleanupError = new Error('cleanup failed')
    const commandRuntime = runtime({
      cleanup: vi.fn(() => {
        expect(issueReleasePreparationForTask(paths, taskId)).toEqual([41, 42])
        expect(issueReleaseIntentForTask(paths, taskId)).toEqual([])
        throw cleanupError
      }),
    })

    await expect(runCleanupCommand(paths, [taskId], commandRuntime)).rejects.toBe(cleanupError)

    expect(issueNumbersForTask(paths, taskId)).toEqual([41, 42])
    expect(issueReleasePreparationForTask(paths, taskId)).toEqual([])
    expect(issueReleaseIntentForTask(paths, taskId)).toEqual([])
    expect(commandRuntime.loadForge).not.toHaveBeenCalled()
  })

  it('restores an earlier release intent when a repeated cleanup fails', async () => {
    recordIssuesForTask(paths, taskId, [41, 42])
    recordIssueReleaseIntent(paths, taskId, [41])
    const cleanupError = new Error('cleanup failed')
    const commandRuntime = runtime({ cleanup: vi.fn(() => { throw cleanupError }) })

    await expect(runCleanupCommand(paths, [taskId], commandRuntime)).rejects.toBe(cleanupError)

    expect(issueReleaseIntentForTask(paths, taskId)).toEqual([41])
    expect(issueReleasePreparationForTask(paths, taskId)).toEqual([])
    expect(commandRuntime.loadForge).not.toHaveBeenCalled()
  })

  it('releases the issue\'s actual assignees even when another operator cleans up', async () => {
    const forge = makeFakeForge('operator-b')
    const issueNumber = await forge.createIssue({
      title: 'cleanup claim',
      body: 'claimed work',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: ['worker-a', 'worker-c'],
    })
    recordIssuesForTask(paths, taskId, [issueNumber])
    writeFileSync(specFile(paths, taskId), '# claimed task\n')
    const commandRuntime = runtime({ loadForge: vi.fn(async () => forge) })

    await expect(runCleanupCommand(paths, [taskId], commandRuntime)).resolves.toBe(0)

    const issue = await forge.getIssue(issueNumber)
    expect(issue.labels).toContain(LABEL_READY)
    expect(issue.labels).not.toContain(LABEL_IN_PROGRESS)
    expect(issue.assignees).toEqual([])
    expect(issueNumbersForTask(paths, taskId)).toEqual([])
    expect(existsSync(specFile(paths, taskId))).toBe(false)
    expect(commandRuntime.error).not.toHaveBeenCalled()
  })

  it('returns every grouped issue as an individually claimable finding', async () => {
    const forge = makeFakeForge('worker-a')
    const issueNumbers = await Promise.all([1, 2].map((index) => forge.createIssue({
      title: `grouped cleanup ${index}`,
      body: 'grouped claimed work',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: [forge.user],
    })))
    recordIssuesForTask(paths, taskId, issueNumbers)
    const commandRuntime = runtime({ loadForge: vi.fn(async () => forge) })

    await expect(runCleanupCommand(paths, [taskId], commandRuntime)).resolves.toBe(0)

    for (const issueNumber of issueNumbers) {
      const issue = await forge.getIssue(issueNumber)
      expect(issue.labels).toEqual(expect.arrayContaining([LABEL_READY, LABEL_GROUP_SINGLETON]))
      expect(issue.labels).not.toContain(LABEL_IN_PROGRESS)
      expect(issue.assignees).toEqual([])
    }
    expect(issueNumbersForTask(paths, taskId)).toEqual([])
  })

  it('keeps successful local cleanup when the forge cannot release the issue', async () => {
    execFileSync('git', ['init'], { cwd: repoRoot, windowsHide: true })
    writeFileSync(statusFile(paths, taskId), JSON.stringify({ task_id: taskId, pid: null }))
    writeFileSync(finalMessageFile(paths, taskId), 'TASK_COMPLETE\n')
    writeFileSync(specFile(paths, taskId), '# claimed task\n')
    recordIssuesForTask(paths, taskId, [51, 52])
    const commandRuntime = runtime({
      loadForge: vi.fn(async () => { throw new Error('forge unavailable') }),
      cleanup: cleanupTask,
    })

    await expect(runCleanupCommand(paths, [taskId], commandRuntime)).resolves.toBe(0)

    expect(existsSync(statusFile(paths, taskId))).toBe(false)
    expect(existsSync(finalMessageFile(paths, taskId))).toBe(false)
    expect(existsSync(specFile(paths, taskId))).toBe(false)
    expect(issueNumbersForTask(paths, taskId)).toEqual([51, 52])
    expect(issueReleaseIntentForTask(paths, taskId)).toEqual([51, 52])
    expect(commandRuntime.error).toHaveBeenCalledWith(expect.stringMatching(
      /^WARN: Could not release issues #51 #52 from the forge .* The daemon will retry the persisted release\.$/,
    ))
  })

  it.each([
    'unassign:worker-a',
    'unassign:worker-b',
    `add:${LABEL_GROUP_SINGLETON}`,
    `add:${LABEL_READY}`,
    `remove:${LABEL_MERGE_READY}`,
    `remove:${LABEL_MERGE_FAILED}`,
    `remove:${LABEL_IN_PROGRESS}`,
  ])('persists and reconciles the %s partial release state end to end', async (failure) => {
    const forge = makeFakeForge('operator')
    const issueNumbers = await Promise.all([1, 2].map((index) => forge.createIssue({
      title: `partial cleanup ${index}`,
      body: 'claimed work',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_MERGE_READY, LABEL_MERGE_FAILED],
      assignees: ['worker-a', 'worker-b'],
    })))
    const failingIssue = issueNumbers[0]!
    recordIssuesForTask(paths, taskId, issueNumbers)
    writeFileSync(specFile(paths, taskId), '# claimed task\n')

    const unassignIssue = forge.unassignIssue.bind(forge)
    const addLabel = forge.addLabel.bind(forge)
    const removeLabel = forge.removeLabel.bind(forge)
    let failed = false
    forge.unassignIssue = async (number, assignee) => {
      if (!failed && number === failingIssue && `unassign:${assignee}` === failure) {
        failed = true
        throw new Error(`${failure} failed`)
      }
      await unassignIssue(number, assignee)
    }
    forge.addLabel = async (number, label) => {
      if (!failed && number === failingIssue && `add:${label}` === failure) {
        failed = true
        throw new Error(`${failure} failed`)
      }
      await addLabel(number, label)
    }
    forge.removeLabel = async (number, label) => {
      if (!failed && number === failingIssue && `remove:${label}` === failure) {
        failed = true
        throw new Error(`${failure} failed`)
      }
      await removeLabel(number, label)
    }
    const commandRuntime = runtime({ loadForge: vi.fn(async () => forge) })

    await expect(runCleanupCommand(paths, [taskId], commandRuntime)).resolves.toBe(0)

    expect(failed).toBe(true)
    expect(issueNumbersForTask(paths, taskId)).toEqual(issueNumbers)
    expect(issueReleaseIntentForTask(paths, taskId)).toEqual(issueNumbers)
    expect(existsSync(specFile(paths, taskId))).toBe(false)
    expect(commandRuntime.error).toHaveBeenCalledWith(expect.stringContaining(failure))

    await expect(reapStaleLeases(
      forge, paths, 3, new Date('2026-08-14T00:00:00Z'),
    )).resolves.toEqual([])

    expect(issueReleaseIntentForTask(paths, taskId)).toEqual([])
    expect(issueNumbersForTask(paths, taskId)).toEqual([])
    for (const issueNumber of issueNumbers) {
      const issue = await forge.getIssue(issueNumber)
      expect(issue.assignees).toEqual([])
      expect(issue.labels.filter((label) => [
        LABEL_READY, LABEL_IN_PROGRESS, LABEL_MERGE_READY, LABEL_MERGE_FAILED,
      ].includes(label))).toEqual([LABEL_READY])
      expect(issue.labels).toContain(LABEL_GROUP_SINGLETON)
    }
  })
})
