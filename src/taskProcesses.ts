import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { operatingSystem, type OperatingSystem } from './adapters/os.ts'
import { type OrchPaths } from './paths.ts'
import {
  bootedAt, forgetTaskProcess, registeredTaskIds, taskProcessPid, terminableTaskProcessPid,
} from './processRegistry.ts'
import { listTaskIds } from './refresh.ts'
import { removeWorktreeWithFallback, type WorktreeRemovalRuntime } from './worktree.ts'

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
  // A runner is registered before its status is persisted. If status persistence and
  // startup termination both fail, the registry is the only surviving ownership
  // record and must still make the task visible to stop and daemon-start checks.
  const taskIds = new Set([...listTaskIds(paths), ...registeredTaskIds(paths)])
  for (const taskId of [...taskIds].sort()) {
    const pid = taskProcessPid(
      paths, taskId, bootedAt, os.processStartIdentity, os.processTreeIsAlive,
    )
    if (pid === undefined) continue
    // Ownership blocks while any member of the recorded tree is alive. The runner root
    // can exit before a descendant, and cleanup must still find that orphaned tree.
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
    const terminablePid = terminableTaskProcessPid(
      paths, task.taskId, bootedAt, os.processStartIdentity, os.processTreeIsAlive,
    )
    if (terminablePid === undefined) {
      result.failures.push({
        ...task,
        error: 'process identity was not captured at launch or is currently unavailable',
      })
      continue
    }
    try {
      const terminated = os.terminateProcessTree(terminablePid)
      if (!terminated) {
        result.failures.push({
          ...task,
          error: 'process tree termination could not be verified',
        })
        continue
      }
      result.terminated.push(task)
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

// A merge or adoption gate checks its result out in a worktree named after the process
// that made it, `.merge-<task>-<pid>-<ms>` or `.adopt-<issue>-<pid>-<ms>`, and records
// it nowhere else. When the gate's removal fails the directory stays, and only that name
// says whose it is.
const TEMPORARY_WORKTREE_NAME = /^\.(?:merge|adopt)-.+-(\d+)-\d+$/

export interface TemporaryWorktreeSweep {
  removed: string[]
  failures: Array<{ worktree: string, error: string }>
}

const temporaryWorktreeRemovalRuntime: WorktreeRemovalRuntime = {
  os: operatingSystem,
  git: (cwd, args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }),
}

/**
 * Remove the temporary gate worktrees whose creating process is gone. Nothing else ever
 * refers to them, so without this one failed removal would count as an orphan at every
 * later start. A gate runs inside the daemon and a restart hands over only between polls,
 * so a worktree of the settled predecessor is abandoned even while it still lives. The
 * name holds the creating Node process's own PID, which behind the Windows wrapper is not
 * the predecessor's tree root, so `settledPids` names every PID that process answers to.
 * A worktree that cannot be removed stays, for the orphan check to report.
 */
export function sweepAbandonedTemporaryWorktrees(
  paths: OrchPaths,
  report: (line: string) => void,
  settledPids: number | readonly number[] = [],
  runtime: WorktreeRemovalRuntime = temporaryWorktreeRemovalRuntime,
): TemporaryWorktreeSweep {
  const settled = new Set(typeof settledPids === 'number' ? [settledPids] : settledPids)
  const sweep: TemporaryWorktreeSweep = { removed: [], failures: [] }
  const entries = existsSync(paths.worktreesDir)
    ? readdirSync(paths.worktreesDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    : []
  for (const entry of entries) {
    const owner = TEMPORARY_WORKTREE_NAME.exec(entry.name)?.[1]
    if (owner === undefined || !entry.isDirectory()) continue
    const pid = Number(owner)
    if (!settled.has(pid) && runtime.os.processIsAlive(pid)) continue
    const worktree = join(paths.worktreesDir, entry.name)
    const result = removeWorktreeWithFallback(paths.repoRoot, worktree, runtime, report)
    if (result.fallbackFailure !== undefined || existsSync(worktree)) {
      sweep.failures.push({
        worktree,
        error: `git: ${result.gitFailure}; fallback: ${result.fallbackFailure ?? 'no error'}`,
      })
      continue
    }
    sweep.removed.push(worktree)
  }
  return sweep
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

export interface OrphanedWorktreeReport {
  displayed: string
  holderHint: string
}

// The display path is relative to the checkout for readability, but the holder lookup
// takes the absolute path: in the fleet layout worktrees live outside the checkout, so
// the relative form climbs out with `..`, which handle.exe never matches against its
// absolute handle names and lsof resolves against the operator's shell directory.
export function orphanedWorktreeReport(
  paths: OrchPaths,
  worktree: string,
  os: OperatingSystem = operatingSystem,
): OrphanedWorktreeReport {
  return {
    displayed: relative(paths.repoRoot, worktree),
    holderHint: worktreeHolderHint(worktree, os),
  }
}
