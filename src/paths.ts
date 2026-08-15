import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// The on-disk layout is shared state with everything the loop leaves behind between
// runs, so the names here are contract, not implementation: queue markers, status
// files, logs and worktrees must land exactly where the bash implementation put them.

/**
 * This package's own directory, derived from where it executes rather than from an
 * assumed position inside the repository. A consumer keeps the package at
 * <repo>/orchestration/ts; the repository that owns it keeps it at the root. Anything
 * that re-invokes the CLI, or reaches for the package's lockfile or node_modules,
 * resolves from here — hardcoding 'orchestration/ts' broke the owning repository.
 */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** This package's repository-relative path when it is installed inside a consumer. */
export function packageSubtreePrefix(
  repoRoot: string,
  packageRoot = PACKAGE_ROOT,
): string | undefined {
  const prefix = relative(repoRoot, packageRoot)
  if (prefix === '' || prefix === '..' || prefix.startsWith(`..${sep}`)
    || isAbsolute(prefix)) return undefined
  return prefix.replaceAll('\\', '/')
}

export function packageFile(...segments: string[]): string {
  return join(PACKAGE_ROOT, ...segments)
}

export function packageCommandPrefix(repoRoot: string, packageRoot = PACKAGE_ROOT): string {
  const packageDirectory = relative(repoRoot, packageRoot).replaceAll('\\', '/')
  const packageArgument = packageDirectory.includes(' ')
    ? `"${packageDirectory}"`
    : packageDirectory
  return packageDirectory === '' ? 'npm run' : `npm run -C ${packageArgument}`
}

/** Prefix a repository-relative package file, including its separator when needed. */
export function packagePathPrefix(repoRoot: string, packageRoot = PACKAGE_ROOT): string {
  const packageDirectory = relative(repoRoot, packageRoot).replaceAll('\\', '/')
  return packageDirectory === '' ? '' : `${packageDirectory}/`
}

export function packageScriptCommand(
  repoRoot: string,
  script: string,
  packageRoot = PACKAGE_ROOT,
): string {
  return `${packageCommandPrefix(repoRoot, packageRoot)} ${script}`
}

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

/** The merge target used when the daemon checkout is frozen for a run. */
export function integrationWorktreeDir(paths: OrchPaths): string {
  return join(paths.worktreesDir, '.integration')
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
