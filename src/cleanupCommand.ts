import type { Forge } from './adapters/forge.ts'
import {
  dropClaimedTaskMaterialization, issueNumbersForTask, issueReleaseIntentForTask,
  reconcileIssueReleaseIntent, recordIssueReleaseIntent, removeIssueReleaseIntent,
  type IssueReleaseFailure,
} from './issueQueue.ts'
import type { OrchPaths } from './paths.ts'

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

  const issueQueueEnabled = runtime.issueQueueEnabled()
  const issueNumbers = issueQueueEnabled ? issueNumbersForTask(paths, taskId) : []
  const previousReleaseIntent = issueNumbers.length > 0
    ? issueReleaseIntentForTask(paths, taskId)
    : []
  if (issueNumbers.length > 0) recordIssueReleaseIntent(paths, taskId, issueNumbers)
  try {
    runtime.cleanup(paths, taskId)
  } catch (error) {
    if (issueNumbers.length > 0) {
      try {
        if (previousReleaseIntent.length > 0) {
          recordIssueReleaseIntent(paths, taskId, previousReleaseIntent)
        } else {
          removeIssueReleaseIntent(paths, taskId)
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Cleanup failed and issue release intent rollback failed for task ${taskId}`,
        )
      }
    }
    throw error
  }
  if (issueNumbers.length === 0) return 0

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
