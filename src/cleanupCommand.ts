import type { Forge } from './adapters/forge.ts'
import {
  dropClaimedTaskMaterialization, issueNumbersForTask, releaseIssueClaim,
  returnIssueToReady,
} from './issueQueue.ts'
import type { OrchPaths } from './paths.ts'

export const CLEANUP_USAGE = 'Usage: cleanup <task-id>'

export interface CleanupCommandRuntime {
  issueQueueEnabled(): boolean
  loadForge(): Promise<Forge>
  cleanup(paths: OrchPaths, taskId: string): void
  error(message: string): void
}

interface ReleaseFailure {
  issueNumber: number
  error: unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function releaseWarning(failures: readonly ReleaseFailure[]): string {
  const issues = failures.map(({ issueNumber }) => `#${issueNumber}`).join(' ')
  const details = failures
    .map(({ issueNumber, error }) => `#${issueNumber}: ${errorMessage(error)}`)
    .join('; ')
  const subject = failures.length === 1 ? `issue ${issues}` : `issues ${issues}`
  const pronoun = failures.length === 1 ? 'It' : 'They'
  const lease = failures.length === 1 ? 'its lease expires' : 'their leases expire'
  return `WARN: Could not release ${subject} from the forge (${details}). ${pronoun} will return to loop:ready when ${lease}.`
}

async function releaseIssues(
  forge: Forge,
  issueNumbers: readonly number[],
): Promise<ReleaseFailure[]> {
  if (issueNumbers.length === 1) {
    const issueNumber = issueNumbers[0]!
    try {
      await releaseIssueClaim(forge, issueNumber, await forge.currentUser())
      return []
    } catch (error) {
      return [{ issueNumber, error }]
    }
  }

  const results = await Promise.allSettled(issueNumbers.map((issueNumber) =>
    returnIssueToReady(forge, issueNumber, true)))
  return results.flatMap((result, index) => result.status === 'rejected'
    ? [{ issueNumber: issueNumbers[index]!, error: result.reason }]
    : [])
}

/** Clean local task state, then release any operator-owned issue-queue claim. */
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
  runtime.cleanup(paths, taskId)
  if (issueNumbers.length === 0) return 0

  let failures: ReleaseFailure[]
  try {
    failures = await releaseIssues(await runtime.loadForge(), issueNumbers)
  } catch (error) {
    failures = issueNumbers.map((issueNumber) => ({ issueNumber, error }))
  }

  // Once cleanup succeeds, a future claim must materialize a fresh task rather than
  // resolving the returned issue to this task id, even when the forge is unavailable.
  dropClaimedTaskMaterialization(paths, taskId)
  if (failures.length > 0) runtime.error(releaseWarning(failures))
  return 0
}
