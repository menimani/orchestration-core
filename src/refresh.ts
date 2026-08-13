import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { operatingSystem } from './adapters/os.ts'
import { finalMessageFile, type OrchPaths } from './paths.ts'
import { readStatus, transitionStatus, type TaskStatus } from './status.ts'

// The status refresh, ported from task-status.sh. Only a running task is ever
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

/**
 * Refresh one task: a live process with the marker is completed; a dead process is
 * completed or failed by whether the marker made it into the final message. Returns
 * the status after refresh.
 */
export async function refreshTask(paths: OrchPaths, taskId: string): Promise<TaskStatus | undefined> {
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
  } else {
    next = completionMarkerPresent(paths, taskId) ? 'completed' : 'failed'
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

/** Refresh every task and return the formatted listing task-status.sh printed. */
export async function refreshAll(paths: OrchPaths): Promise<string[]> {
  const lines: string[] = []
  for (const taskId of listTaskIds(paths)) {
    const before = readStatus(paths, taskId)
    if (before === undefined) continue
    if (before.status === 'merged' || before.status === 'failed') {
      lines.push(`${taskId.padEnd(20)} ${before.status.padEnd(10)} pid=`)
      continue
    }
    const after = before.status === 'running' ? await refreshTask(paths, taskId) : before
    const pid = after?.pid ?? ''
    lines.push(`${taskId.padEnd(20)} ${(after?.status ?? '?').padEnd(10)} pid=${pid}`)
  }
  return lines
}
