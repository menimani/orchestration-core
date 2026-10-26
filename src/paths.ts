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
  // These commands are rendered into Bash instructions (including Git Bash on
  // Windows). Quote every directory so shell metacharacters are always data; a
  // literal apostrophe is represented by ending the quote, escaping it, and
  // reopening the quote.
  const packageArgument = `'${packageDirectory.replaceAll("'", "'\\''")}'`
  return packageDirectory === '' ? 'npm run' : `npm run -C ${packageArgument}`
}

/** Prefix a repository-relative package file, including its separator when needed. */
export function packagePathPrefix(repoRoot: string, packageRoot = PACKAGE_ROOT): string {
  const packageDirectory = relative(repoRoot, packageRoot).replaceAll('\\', '/')
  return packageDirectory === '' ? '' : `${packageDirectory}/`
}

function shellPathArgument(path: string): string {
  return `'${path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`
}

/** Render a package command that can be copied and run from any working directory. */
export function absolutePackageScriptCommand(
  location: string | readonly string[],
  script: string,
  packageRoot = PACKAGE_ROOT,
): string {
  const command = `npm run -C ${shellPathArgument(packageRoot)} ${script}`
  const args = typeof location === 'string' ? ['--repo', location] : location
  const rendered = args.map((arg) => arg.startsWith('--') ? arg : shellPathArgument(arg))
  return `${command} -- ${rendered.join(' ')}`
}

/**
 * The command prefix for skills installed once per user and run from any fleet project's
 * checkout: it names the fleet in the environment, and the CLI finds the project from the
 * directory the command was started in.
 */
export function fleetCommandPrefix(fleetDir: string, packageRoot = PACKAGE_ROOT): string {
  return `ORCHESTRATION_FLEET=${shellPathArgument(fleetDir)} npm run -C ${shellPathArgument(packageRoot)}`
}

/** A project selected from a fleet checkout rather than from inside its repository. */
export interface FleetLocation {
  /** Absolute path of the fleet checkout holding fleet.json. */
  dir: string
  /** The project name keyed in fleet.json. */
  project: string
  /** The forge repository, as owner/name, that the project's branches and PRs go to. */
  repository: string
  /** The forge repository holding the fleet's shared issue queue, when it has one. */
  issueRepository?: string | undefined
}

export interface OrchPaths {
  /** Runtime state: tasks, worktrees, status, logs and queue live under it. */
  root: string
  /** Project assets: the adapter, templates, accepted limits and config.json. */
  projectRoot: string
  repoRoot: string
  tasksDir: string
  worktreesDir: string
  statusDir: string
  logsDir: string
  queueDir: string
  /** Set when the project was selected from a fleet; absent in the in-repository layout. */
  fleet?: FleetLocation
}

function stateLayout(root: string): Pick<
  OrchPaths, 'tasksDir' | 'worktreesDir' | 'statusDir' | 'logsDir' | 'queueDir'
> {
  return {
    tasksDir: join(root, 'tasks'),
    worktreesDir: join(root, 'worktrees'),
    statusDir: join(root, 'status'),
    logsDir: join(root, 'logs'),
    queueDir: join(root, 'queue'),
  }
}

export function createOrchDirectories(paths: OrchPaths): void {
  for (const dir of [
    paths.tasksDir, paths.worktreesDir, paths.statusDir, paths.logsDir, paths.queueDir,
  ]) mkdirSync(dir, { recursive: true })
}

/** The in-repository layout: state and project assets share <repo>/orchestration. */
export function orchPaths(repoRoot: string, createDirectories = true): OrchPaths {
  const root = join(repoRoot, 'orchestration')
  const paths: OrchPaths = { root, projectRoot: root, repoRoot, ...stateLayout(root) }
  if (createDirectories) createOrchDirectories(paths)
  return paths
}

/**
 * The fleet layout: the target repository holds no orchestration files. Project assets
 * live in <fleet>/projects/<name> and runtime state in <fleet>/state/<name>, so nothing
 * the loop writes lands in the checkout it improves.
 */
export function fleetPaths(
  location: FleetLocation,
  repoRoot: string,
  createDirectories = true,
): OrchPaths {
  const root = join(location.dir, 'state', location.project)
  const paths: OrchPaths = {
    root,
    projectRoot: join(location.dir, 'projects', location.project),
    repoRoot,
    ...stateLayout(root),
    fleet: { ...location },
  }
  if (createDirectories) createOrchDirectories(paths)
  return paths
}

/**
 * Whether queue issues live in a repository other than the project's. Their numbers then
 * mean nothing in the project's repository, so no commit there may reference them.
 */
export function issueQueueIsSeparate(paths: OrchPaths): boolean {
  return paths.fleet?.issueRepository !== undefined
}

/** The CLI arguments that select the same repository again from any working directory. */
export function locationArgs(paths: OrchPaths): string[] {
  return paths.fleet === undefined
    ? ['--repo', paths.repoRoot]
    : ['--fleet', paths.fleet.dir, '--project', paths.fleet.project]
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

// A completed task whose rebase conflicted keeps its commits here until a retry merges.
export function conflictBranchName(taskId: string): string {
  return `conflict/${taskId}`
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
