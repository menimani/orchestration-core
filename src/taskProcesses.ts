import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { operatingSystem, type OperatingSystem } from './adapters/os.ts'
import { type OrchPaths } from './paths.ts'
import { listTaskIds } from './refresh.ts'
import { readStatus } from './status.ts'

export interface TaskProcess {
  taskId: string
  pid: number
}

export interface TaskProcessTermination {
  terminated: TaskProcess[]
  failures: Array<TaskProcess & { error: string }>
}

export function liveTaskProcesses(
  paths: OrchPaths,
  os: OperatingSystem = operatingSystem,
): TaskProcess[] {
  const live: TaskProcess[] = []
  for (const taskId of listTaskIds(paths)) {
    const pid = readStatus(paths, taskId)?.pid
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) continue
    if (os.processTreeIsAlive(pid)) {
      live.push({ taskId, pid })
    }
  }
  return live
}

/** Try every task even if one tree resists termination. */
export function terminateLiveTaskProcesses(
  paths: OrchPaths,
  os: OperatingSystem = operatingSystem,
): TaskProcessTermination {
  const result: TaskProcessTermination = { terminated: [], failures: [] }
  for (const task of liveTaskProcesses(paths, os)) {
    try {
      if (os.terminateProcessTree(task.pid)) result.terminated.push(task)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failures.push({ ...task, error: message })
    }
  }
  return result
}

export function orphanedWorktreeDirectories(paths: OrchPaths): string[] {
  return readdirSync(paths.worktreesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !existsSync(join(paths.statusDir, `${entry.name}.json`)))
    .map((entry) => join(paths.worktreesDir, entry.name))
    .sort()
}

export function worktreeHolderHint(
  worktree: string,
  os: OperatingSystem = operatingSystem,
): string {
  return os.worktreePathFor(worktree).holderHint
}
