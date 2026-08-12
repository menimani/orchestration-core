import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type OrchPaths } from './paths.ts'
import {
  processIsAlive, processTreeIsAlive, systemProcessTreeRuntime, terminateProcessTree,
  type ProcessTreeRuntime,
} from './processTree.ts'
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
  runtime: ProcessTreeRuntime = systemProcessTreeRuntime,
): TaskProcess[] {
  const live: TaskProcess[] = []
  for (const taskId of listTaskIds(paths)) {
    const pid = readStatus(paths, taskId)?.pid
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) continue
    if (processIsAlive(pid, runtime) || processTreeIsAlive(pid, runtime)) {
      live.push({ taskId, pid })
    }
  }
  return live
}

/** Try every task even if one tree resists termination. */
export function terminateLiveTaskProcesses(
  paths: OrchPaths,
  runtime: ProcessTreeRuntime = systemProcessTreeRuntime,
): TaskProcessTermination {
  const result: TaskProcessTermination = { terminated: [], failures: [] }
  for (const task of liveTaskProcesses(paths, runtime)) {
    try {
      if (terminateProcessTree(task.pid, runtime)) result.terminated.push(task)
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

export function worktreeHolderHint(worktree: string, platform = process.platform): string {
  if (platform === 'win32') {
    return `Find holder: handle.exe "${worktree}" (Sysinternals)`
  }
  const quoted = `'${worktree.replaceAll("'", "'\\''")}'`
  return `Find holder: lsof +D -- ${quoted}`
}
