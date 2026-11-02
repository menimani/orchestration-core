import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { operatingSystem } from './adapters/os.ts'
import { finalMessageFile, type OrchPaths } from './paths.ts'
import { taskProcessRecorded } from './processRegistry.ts'
import { readStatus, transitionStatus, type TaskStatus } from './status.ts'

// The status refresh. Only a running task is ever
// rewritten: terminal files (merged, failed) are left byte-for-byte as they are, and
// the running→completed/failed decision goes through the compare-and-swap transition
// so a merge that won the lock first is preserved rather than overwritten.

/**
 * Completion is detected only from the final-message file the runner wrote, never the
 * transcript — TASK_COMPLETE appearing in prompt text echoed to the log is not
 * completion. The marker must occupy its own line.
 */
export function completionMarkerPresent(paths: OrchPaths, taskId: string): boolean {
  const file = finalMessageFile(paths, taskId)
  if (!existsSync(file)) return false
  return readFileSync(file, 'utf8').split(/\r?\n/).some((line) => line === 'TASK_COMPLETE')
}

/** An explicit verdict that a completed implementation task legitimately needs no commit. */
export function noChangeMarkerPresent(paths: OrchPaths, taskId: string): boolean {
  const file = finalMessageFile(paths, taskId)
  if (!existsSync(file)) return false
  return readFileSync(file, 'utf8').split(/\r?\n/)
    .some((line) => line === 'NO_CHANGE_WARRANTED')
}

export interface RefreshOptions {
  /**
   * False when no daemon holds the queue. A graceful stop removes the PID records of the
   * trees it terminated and leaves their statuses running, and the next daemon reports
   * those as dead at startup; failing them here first would turn them into fresh failures
   * counted against their issues and the burst guard.
   */
  daemonOwnsQueue?: boolean
}

/**
 * Refresh one task: a live process with the marker is completed; a dead process is
 * completed or failed by whether the marker made it into the final message. Without a
 * daemon, a task with no PID record and no marker stays running for the next daemon to
 * classify; one whose record outlived its process crashed and is failed. Returns the
 * status after refresh.
 */
export async function refreshTask(
  paths: OrchPaths,
  taskId: string,
  { daemonOwnsQueue = true }: RefreshOptions = {},
): Promise<TaskStatus | undefined> {
  // Asked before the status is read: reading it drops a record whose process is gone,
  // after which a crashed runner would look like one a graceful stop released.
  const recorded = taskProcessRecorded(paths, taskId)
  const status = readStatus(paths, taskId)
  if (status === undefined || status.status !== 'running') return status

  const alive = status.pid !== null && operatingSystem.processIsAlive(status.pid)
  let next: 'completed' | 'failed' | undefined
  let nextPid: number | undefined
  if (alive) {
    if (completionMarkerPresent(paths, taskId)) {
      next = 'completed'
      nextPid = status.pid ?? undefined
    }
  } else if (completionMarkerPresent(paths, taskId)) {
    next = 'completed'
  } else if (daemonOwnsQueue || recorded || status.pid !== null) {
    next = 'failed'
  }
  if (next === undefined) return status

  // When the transition loses, a merge won the lock after this refresh classified the
  // file; the re-read is the answer, not this refresh's stale decision.
  await transitionStatus(paths, taskId, 'running', next, nextPid)
  return readStatus(paths, taskId)
}

export function listTaskIds(paths: OrchPaths): string[] {
  return readdirSync(paths.statusDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort()
}

/** Refresh every task and return the listing `status` prints, one line per task. */
export async function refreshAll(
  paths: OrchPaths,
  options: RefreshOptions = {},
): Promise<string[]> {
  const lines: string[] = []
  for (const taskId of listTaskIds(paths)) {
    const before = readStatus(paths, taskId)
    if (before === undefined) continue
    if (before.status === 'merged' || before.status === 'no-change' || before.status === 'failed') {
      lines.push(`${taskId.padEnd(20)} ${before.status.padEnd(10)} pid=`)
      continue
    }
    const after = before.status === 'running' ? await refreshTask(paths, taskId, options) : before
    const pid = after?.pid ?? ''
    lines.push(`${taskId.padEnd(20)} ${(after?.status ?? '?').padEnd(10)} pid=${pid}`)
  }
  return lines
}
