import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// The on-disk layout is shared state with everything the loop leaves behind between
// runs, so the names here are contract, not implementation: queue markers, status
// files, logs and worktrees must land exactly where the bash implementation put them.

export interface OrchPaths {
  root: string
  repoRoot: string
  tasksDir: string
  worktreesDir: string
  statusDir: string
  logsDir: string
  queueDir: string
}

export function orchPaths(repoRoot: string): OrchPaths {
  const root = join(repoRoot, 'orchestration')
  const paths: OrchPaths = {
    root,
    repoRoot,
    tasksDir: join(root, 'tasks'),
    worktreesDir: join(root, 'worktrees'),
    statusDir: join(root, 'status'),
    logsDir: join(root, 'logs'),
    queueDir: join(root, 'queue'),
  }
  for (const dir of [paths.tasksDir, paths.worktreesDir, paths.statusDir, paths.logsDir, paths.queueDir]) {
    mkdirSync(dir, { recursive: true })
  }
  return paths
}

export function statusFile(paths: OrchPaths, taskId: string): string {
  return join(paths.statusDir, `${taskId}.json`)
}

export function logFile(paths: OrchPaths, taskId: string): string {
  return join(paths.logsDir, `${taskId}.log`)
}

export function finalMessageFile(paths: OrchPaths, taskId: string): string {
  return join(paths.logsDir, `${taskId}.final`)
}

export function worktreeDir(paths: OrchPaths, taskId: string): string {
  return join(paths.worktreesDir, taskId)
}

export function branchName(taskId: string): string {
  return `task/${taskId}`
}

// Scan ids have carried two shapes: the old scan-<timestamp> prefix and the current
// <timestamp>_<seq>_scan. Both must keep matching, because status files and worktrees
// left by older runs still use the first.
export function isScanTaskId(taskId: string): boolean {
  return taskId.startsWith('scan-') || taskId.endsWith('_scan')
}

// Review ids are <timestamp>_<seq>_review-c<cycle>, one per review round of a cycle.
export function isReviewTaskId(taskId: string): boolean {
  return taskId.includes('_review-c')
}

// A task that only inspects reports findings and never commits: an empty worktree is
// its expected result, not work an agent forgot to commit. A delegated task says the
// same of itself through the queue/inspect marker, because its id carries the
// description rather than the purpose.
export function isInspectionTaskId(paths: OrchPaths, taskId: string): boolean {
  if (existsSync(join(paths.queueDir, 'inspect', taskId))) return true
  return isScanTaskId(taskId) || isReviewTaskId(taskId)
}
