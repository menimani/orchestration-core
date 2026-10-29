import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Forge } from './adapters/forge.ts'
import {
  completeIssueReleaseIntent, dropClaimedTaskMaterialization, issueNumbersForTask,
  issueReleaseIntentForTask, prepareIssueReleaseIntent, reconcileIssueReleaseIntent,
  removeIssueReleasePreparation, type IssueReleaseFailure,
} from './issueQueue.ts'
import { isScanTaskId, statusFile, type OrchPaths } from './paths.ts'

export const CLEANUP_USAGE = 'Usage: cleanup <task-id>'

export interface CleanupCommandRuntime {
  issueQueueEnabled(): boolean
  loadForge(): Promise<Forge>
  cleanup(paths: OrchPaths, taskId: string): void
  error(message: string): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function releaseWarning(failures: readonly IssueReleaseFailure[]): string {
  const issues = failures.map(({ issueNumber }) => `#${issueNumber}`).join(' ')
  const details = failures
    .map(({ issueNumber, error }) => `#${issueNumber}: ${errorMessage(error)}`)
    .join('; ')
  const subject = failures.length === 1 ? `issue ${issues}` : `issues ${issues}`
  return `WARN: Could not release ${subject} from the forge (${details}). The daemon will retry the persisted release.`
}

/**
 * The cycle a scan still owes its yield to, read before cleanup removes the markers that
 * show whether it already answered. A scan whose completion or failure the daemon has
 * recorded, or one with no task state left, owes nothing.
 */
function pendingScanCycle(paths: OrchPaths, taskId: string): number | undefined {
  if (!isScanTaskId(taskId) || !existsSync(statusFile(paths, taskId))) return undefined
  const scannedDir = join(paths.queueDir, 'scanned')
  if (existsSync(join(scannedDir, taskId)) || existsSync(join(scannedDir, `${taskId}.failed`))) {
    return undefined
  }
  const scanCountFile = join(paths.queueDir, 'scan-count.txt')
  if (!existsSync(scanCountFile)) return undefined
  const rawCycle = readFileSync(scanCountFile, 'utf8').trim()
  if (!/^[1-9][0-9]*$/.test(rawCycle)) return undefined
  const cycle = Number(rawCycle)
  if (!existsSync(join(paths.queueDir, `scan-expected-${cycle}`))) return undefined
  const yieldFile = join(paths.queueDir, `scan-yield-${cycle}`)
  if (existsSync(yieldFile) && readFileSync(yieldFile, 'utf8').split(/\r?\n/)
    .some((line) => line.startsWith(`${taskId}\t`))) {
    return undefined
  }
  return cycle
}

/**
 * Count a cleaned-up scan as failed for its cycle, the way the daemon counts a scan that
 * died: its yield can no longer arrive, and without the record the cycle waits for it
 * forever.
 */
function recordCleanedScanFailure(paths: OrchPaths, taskId: string, cycle: number): void {
  const failedFile = join(paths.queueDir, `failed-${cycle}`)
  if (existsSync(failedFile)
    && readFileSync(failedFile, 'utf8').split(/\r?\n/).includes(taskId)) {
    return
  }
  appendFileSync(failedFile, `${taskId}\n`)
}

/** Clean local task state and release any operator-owned issue-queue claim. */
export async function runCleanupCommand(
  paths: OrchPaths,
  args: string[],
  runtime: CleanupCommandRuntime,
): Promise<number> {
  const taskId = args[0]
  if (taskId === undefined) {
    runtime.error(CLEANUP_USAGE)
    return 1
  }

  const scanCycle = pendingScanCycle(paths, taskId)
  const issueQueueEnabled = runtime.issueQueueEnabled()
  const issueNumbers = issueQueueEnabled ? issueNumbersForTask(paths, taskId) : []
  const releaseAlreadyCompleted = issueNumbers.length > 0
    ? issueReleaseIntentForTask(paths, taskId)
    : []
  if (issueNumbers.length > 0 && releaseAlreadyCompleted.length === 0) {
    prepareIssueReleaseIntent(paths, taskId, issueNumbers)
  }
  try {
    runtime.cleanup(paths, taskId)
  } catch (error) {
    if (issueNumbers.length > 0 && releaseAlreadyCompleted.length === 0) {
      try {
        removeIssueReleasePreparation(paths, taskId)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Cleanup failed and issue release preparation rollback failed for task ${taskId}`,
        )
      }
    }
    throw error
  }
  if (scanCycle !== undefined) recordCleanedScanFailure(paths, taskId, scanCycle)
  if (issueNumbers.length === 0) return 0
  if (releaseAlreadyCompleted.length === 0) completeIssueReleaseIntent(paths, taskId)

  // Keep the mapping until the durable intent verifies the remote release. Other task
  // materialization can be removed now without losing the issue reconciliation source.
  dropClaimedTaskMaterialization(paths, taskId, true)

  let failures: IssueReleaseFailure[]
  try {
    failures = await reconcileIssueReleaseIntent(await runtime.loadForge(), paths, taskId)
  } catch (error) {
    failures = issueNumbers.map((issueNumber) => ({ issueNumber, error }))
  }
  if (failures.length > 0) runtime.error(releaseWarning(failures))
  return 0
}
