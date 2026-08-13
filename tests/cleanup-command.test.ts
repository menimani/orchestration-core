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
  issueNumbersForTask, LABEL_FINDING, LABEL_GROUP_SINGLETON, LABEL_IN_PROGRESS,
  LABEL_READY, recordIssueForTask, recordIssuesForTask,
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
    recordIssueForTask(paths, taskId, 41)
    const commandRuntime = runtime({ issueQueueEnabled: () => false })

    await expect(runCleanupCommand(paths, [taskId], commandRuntime)).resolves.toBe(0)

    expect(commandRuntime.cleanup).toHaveBeenCalledWith(paths, taskId)
    expect(commandRuntime.loadForge).not.toHaveBeenCalled()
    expect(issueNumbersForTask(paths, taskId)).toEqual([41])
  })

  it('releases a linked issue claim and drops its local materialization', async () => {
    const forge = makeFakeForge('worker-a')
    const issueNumber = await forge.createIssue({
      title: 'cleanup claim',
      body: 'claimed work',
      labels: [LABEL_FINDING, LABEL_IN_PROGRESS],
      assignees: [forge.user],
    })
    recordIssueForTask(paths, taskId, issueNumber)
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
    expect(issueNumbersForTask(paths, taskId)).toEqual([])
    expect(commandRuntime.error).toHaveBeenCalledWith(expect.stringMatching(
      /^WARN: Could not release issues #51 #52 from the forge .* They will return to loop:ready when their leases expire\.$/,
    ))
  })
})
