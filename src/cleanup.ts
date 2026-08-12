import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { branchName, finalMessageFile, statusFile, worktreeDir, type OrchPaths } from './paths.ts'
import { readStatus } from './status.ts'
import { removeWorktreeWithFallback } from './worktree.ts'
import {
  systemProcessTreeRuntime, terminateProcessTree, type ProcessTreeRuntime,
} from './processTree.ts'

interface CommandOptions {
  cwd?: string
  windowsHide?: boolean
}

interface RemoveOptions {
  force?: boolean
  maxRetries?: number
  recursive?: boolean
}

export interface CleanupRuntime extends ProcessTreeRuntime {
  execFile(command: string, args: readonly string[], options: CommandOptions): string
  exists(path: string): boolean
  remove(path: string, options: RemoveOptions): void
}

const systemRuntime: CleanupRuntime = {
  ...systemProcessTreeRuntime,
  execFile: (command, args, options) => {
    return execFileSync(command, [...args], { ...options, encoding: 'utf8' })
  },
  exists: existsSync,
  remove: rmSync,
}

function git(runtime: CleanupRuntime, paths: OrchPaths, args: readonly string[]): string {
  return runtime.execFile('git', args, {
    cwd: paths.repoRoot,
    windowsHide: true,
  })
}

function samePath(runtime: CleanupRuntime, left: string, right: string): boolean {
  const leftResolved = resolve(left)
  const rightResolved = resolve(right)
  return runtime.platform === 'win32'
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved
}

function worktreeIsRegistered(runtime: CleanupRuntime, paths: OrchPaths, worktree: string): boolean {
  const output = git(runtime, paths, ['worktree', 'list', '--porcelain', '-z'])
  return output.split('\0').some((field) =>
    field.startsWith('worktree ') && samePath(runtime, field.slice('worktree '.length), worktree))
}

function branchExists(runtime: CleanupRuntime, paths: OrchPaths, branch: string): boolean {
  const ref = `refs/heads/${branch}`
  const output = git(runtime, paths, ['for-each-ref', '--format=%(refname)', 'refs/heads'])
  return output.split(/\r?\n/).includes(ref)
}

function stopProcess(runtime: CleanupRuntime, pid: number): void {
  try {
    if (terminateProcessTree(pid, runtime)) console.log(`Stopping running process: pid=${pid}`)
  } catch {
    throw new Error(`Could not stop process ${pid}; task state was retained.`)
  }
}

/**
 * Stop a task's process and remove its worktree, branch, status and markers.
 * Cleanup precedes a retry, so the announce markers under queue/scanned go too —
 * leaving them would let the loop watch the retry in silence, completed and failed
 * alike.
 */
export function cleanupTask(
  paths: OrchPaths,
  taskId: string,
  runtime: CleanupRuntime = systemRuntime,
  announce = true,
): void {
  const status = readStatus(paths, taskId)
  if (status !== undefined && status.pid !== null) {
    stopProcess(runtime, status.pid)
  }

  const worktree = worktreeDir(paths, taskId)
  if (runtime.exists(worktree)) {
    removeWorktreeWithFallback(paths.repoRoot, worktree, {
      platform: runtime.platform,
      remove: runtime.remove,
      git: (_cwd, args) => git(runtime, paths, args),
    })
  }
  if (runtime.exists(worktree)) {
    throw new Error(`Could not remove worktree ${worktree}; task state was retained.`)
  }

  try {
    git(runtime, paths, ['worktree', 'prune', '--expire', 'now'])
  } catch {
    throw new Error(`Could not prune worktree metadata for ${worktree}; task state was retained.`)
  }
  let worktreeRegistered: boolean
  try {
    worktreeRegistered = worktreeIsRegistered(runtime, paths, worktree)
  } catch {
    throw new Error(`Could not verify worktree removal for ${worktree}; task state was retained.`)
  }
  if (worktreeRegistered) {
    throw new Error(`Worktree ${worktree} is still registered; task state was retained.`)
  }

  const branch = branchName(taskId)
  try {
    git(runtime, paths, ['branch', '-D', branch])
  } catch {
    // The branch may already be absent; verify below.
  }
  let branchPresent: boolean
  try {
    branchPresent = branchExists(runtime, paths, branch)
  } catch {
    throw new Error(`Could not verify branch removal for ${branch}; task state was retained.`)
  }
  if (branchPresent) {
    throw new Error(`Could not remove branch ${branch}; task state was retained.`)
  }

  runtime.remove(statusFile(paths, taskId), { force: true })
  runtime.remove(finalMessageFile(paths, taskId), { force: true })
  runtime.remove(join(paths.queueDir, 'scanned', taskId), { force: true })
  runtime.remove(join(paths.queueDir, 'scanned', `${taskId}.failed`), { force: true })
  runtime.remove(join(paths.queueDir, 'scanned', `${taskId}.depth`), { force: true })
  runtime.remove(join(paths.queueDir, 'heartbeat', taskId), { force: true })
  if (announce) console.log(`Cleaned up ${taskId}.`)
}
