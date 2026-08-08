import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { branchName, finalMessageFile, statusFile, worktreeDir, type OrchPaths } from './paths.ts'
import { readStatus } from './status.ts'

/**
 * Stop a task's process and remove its worktree, branch, status and markers.
 * Cleanup precedes a retry, so the announce markers under queue/scanned go too —
 * leaving them would let the loop watch the retry in silence, completed and failed
 * alike.
 */
export function cleanupTask(paths: OrchPaths, taskId: string): void {
  const status = readStatus(paths, taskId)
  if (status !== undefined && status.pid !== null) {
    try {
      process.kill(status.pid, 0)
      console.log(`Stopping running process: pid=${status.pid}`)
      process.kill(status.pid)
    } catch {
      // already gone
    }
  }

  const worktree = worktreeDir(paths, taskId)
  if (existsSync(worktree)) {
    try {
      execFileSync('git', ['worktree', 'remove', worktree, '--force'], { cwd: paths.repoRoot })
    } catch {
      rmSync(worktree, { recursive: true, force: true })
    }
  }
  try {
    execFileSync('git', ['branch', '-D', branchName(taskId)], { cwd: paths.repoRoot })
  } catch {
    // no branch to delete
  }

  rmSync(statusFile(paths, taskId), { force: true })
  rmSync(finalMessageFile(paths, taskId), { force: true })
  rmSync(join(paths.queueDir, 'scanned', taskId), { force: true })
  rmSync(join(paths.queueDir, 'scanned', `${taskId}.failed`), { force: true })
  console.log(`Cleaned up ${taskId}.`)
}
