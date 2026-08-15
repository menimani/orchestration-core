import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { operatingSystem, type OperatingSystem } from './adapters/os.ts'
import { type OrchPaths } from './paths.ts'
import {
  bootedAt, forgetTaskProcess, taskProcessPid, terminableTaskProcessPid,
} from './processRegistry.ts'
import { listTaskIds } from './refresh.ts'

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
    const pid = taskProcessPid(
      paths, taskId, bootedAt, os.processStartIdentity, os.processIsAlive,
    )
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) continue
    // Detection asks whether that process is running, not whether it leads a group. A
    // recorded PID that is not a group leader answered "gone" on POSIX, so this waved
    // through a daemon starting beside a live foreign task.
    if (os.processIsAlive(pid)) {
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
    const terminablePid = terminableTaskProcessPid(
      paths, task.taskId, bootedAt, os.processStartIdentity, os.processIsAlive,
    )
    if (terminablePid === undefined) {
      result.failures.push({
        ...task,
        error: 'process identity was not captured at launch or is currently unavailable',
      })
      continue
    }
    try {
      if (os.terminateProcessTree(terminablePid)) result.terminated.push(task)
      // Stopping is what makes the recorded number false, so it is dropped here rather
      // than left for whoever reads next. A tree that resisted termination keeps its
      // entry: something is still running under that number.
      forgetTaskProcess(paths, task.taskId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failures.push({ ...task, error: message })
    }
  }
  return result
}

export function orphanedWorktreeDirectories(paths: OrchPaths): string[] {
  return readdirSync(paths.worktreesDir, { withFileTypes: true })
    .filter((entry) => entry.name !== '.integration' && entry.isDirectory()
      && !existsSync(join(paths.statusDir, `${entry.name}.json`)))
    .map((entry) => join(paths.worktreesDir, entry.name))
    .sort()
}

export function worktreeHolderHint(
  worktree: string,
  os: OperatingSystem = operatingSystem,
): string {
  return os.worktreePathFor(worktree).holderHint
}
