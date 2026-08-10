import { execFileSync, execSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ProjectAdapter } from './adapters/project.ts'
import { shortTaskId } from './ids.ts'
import { branchName, isInspectionTaskId, logFile, worktreeDir, type OrchPaths } from './paths.ts'
import { readStatus, writeStatus } from './status.ts'

export class MergeError extends Error {
  keepWorktree: boolean
  constructor(message: string, keepWorktree = true) {
    super(message)
    this.keepWorktree = keepWorktree
  }
}

export interface MergeOptions {
  /** Explicit test command; overrides the project's check selection. */
  testCmd?: string | undefined
  skipAutoTest?: boolean
  taskGate: 'full' | 'light'
  /** The repository's own knowledge: which checks verify a merge, and when. */
  project: ProjectAdapter
  /**
   * Issue this merge resolves. The reference rides the merge commit, so the forge
   * closes the issue when the promotion PR lands the commit on the default branch.
   */
  closesIssue?: number | undefined
  /**
   * When set, everything the merge prints — including test output — goes to this file
   * instead of stdout, so a loop's log stays readable and the details stay findable.
   */
  outputFile?: string | undefined
  orchestrationDepsRuntime?: OrchestrationDepsRuntime | undefined
  onOrchestrationDepsEvent?: OrchestrationDepsEvent | undefined
}

export interface OrchestrationDepsRuntime {
  install: (cwd: string) => void
}

export type OrchestrationDepsEvent = (name: 'Installed' | 'WARN', subject: string) => void

const orchestrationDepsRuntime: OrchestrationDepsRuntime = {
  install: (cwd) => {
    execSync('npm install --no-audit --no-fund', {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
  },
}

const ORCHESTRATION_MANIFESTS = new Set([
  'orchestration/ts/package.json',
  'orchestration/ts/package-lock.json',
])

function installFailureSummary(error: unknown): string {
  const failure = error as { stderr?: string | Buffer }
  const stderr = Buffer.isBuffer(failure.stderr)
    ? failure.stderr.toString('utf8')
    : failure.stderr
  return (stderr?.trim() || (error instanceof Error ? error.message : String(error)))
    .replaceAll(/\s+/g, ' ')
}

function installOrchestrationDeps(
  paths: OrchPaths,
  subject: string,
  event: OrchestrationDepsEvent,
  runtime: OrchestrationDepsRuntime,
): void {
  try {
    runtime.install(join(paths.repoRoot, 'orchestration', 'ts'))
    event('Installed', ` orchestration deps  ${subject}`)
  } catch (error) {
    event('WARN', `orchestration deps install ${subject} failed: ${installFailureSummary(error)}`)
  }
}

export function syncOrchestrationDepsAfterMerge(
  paths: OrchPaths,
  mergeCommit: string,
  taskId: string,
  event: OrchestrationDepsEvent,
  runtime: OrchestrationDepsRuntime = orchestrationDepsRuntime,
): void {
  const [, firstParent, secondParent] = git(paths.repoRoot, [
    'rev-list', '--parents', '-n', '1', mergeCommit,
  ]).trim().split(/\s+/)
  if (firstParent === undefined || secondParent === undefined) return
  const changed = git(paths.repoRoot, [
    'diff', '--name-only', firstParent, mergeCommit,
  ]).split(/\r?\n/).filter((path) => path !== '')
  if (!changed.some((path) => ORCHESTRATION_MANIFESTS.has(path))) return
  installOrchestrationDeps(paths, `after ${shortTaskId(taskId)}`, event, runtime)
}

function orchestrationDepsMissing(paths: OrchPaths): boolean {
  const packageFile = join(paths.repoRoot, 'orchestration', 'ts', 'package.json')
  if (!existsSync(packageFile)) return false
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const dependencies = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]
  return dependencies.some((name) => !existsSync(join(
    paths.repoRoot, 'orchestration', 'ts', 'node_modules', ...name.split('/'), 'package.json',
  )))
}

export function syncOrchestrationDepsAtStartup(
  paths: OrchPaths,
  event: OrchestrationDepsEvent,
  runtime: OrchestrationDepsRuntime = orchestrationDepsRuntime,
): void {
  if (!orchestrationDepsMissing(paths)) return
  installOrchestrationDeps(paths, 'at startup', event, runtime)
}

interface MergeIo {
  out: (text: string) => void
  run: (cwd: string, command: string) => void
  tryRun: (cwd: string, command: string, label: string) => boolean
}

export interface WorktreeRemovalRuntime {
  platform: NodeJS.Platform
  remove: typeof rmSync
  git: (cwd: string, args: string[]) => string
}

const worktreeRemovalRuntime: WorktreeRemovalRuntime = {
  platform: process.platform,
  remove: rmSync,
  git,
}

function extendedLengthPath(path: string): string {
  const absolutePath = resolve(path).replaceAll('/', '\\')
  return absolutePath.startsWith('\\\\?\\') ? absolutePath : `\\\\?\\${absolutePath}`
}

function removalFailureDetail(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer }).stderr
  const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr
  const message = detail?.trim() || (error instanceof Error ? error.message : String(error))
  return message.replaceAll(/\s+/g, ' ')
}

export function removeMergedWorktree(
  paths: OrchPaths,
  worktree: string,
  log: (text: string) => void,
  runtime: WorktreeRemovalRuntime = worktreeRemovalRuntime,
): void {
  let gitFailure = ''
  try {
    runtime.git(paths.repoRoot, ['worktree', 'remove', worktree, '--force'])
    return
  } catch (error) {
    gitFailure = removalFailureDetail(error)
  }

  try {
    const removalPath = runtime.platform === 'win32' ? extendedLengthPath(worktree) : worktree
    const options = runtime.platform === 'win32'
      ? { recursive: true, force: true, maxRetries: 3 }
      : { recursive: true, force: true }
    runtime.remove(removalPath, options)
    const fallback = runtime.platform === 'win32'
      ? 'Windows long-path fallback'
      : 'direct-removal fallback'
    log(`Worktree removal needed the ${fallback}: ${worktree} (${gitFailure})`)
  } catch {
    log(`WARN: merged, but the worktree is still there and has to go by hand: ${worktree} (${gitFailure})`)
  }

  try {
    runtime.git(paths.repoRoot, ['worktree', 'prune'])
  } catch {
    // cleanup is best effort; the merge verdict is already known
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function mergeIo(outputFile?: string): MergeIo {
  const out = (text: string): void => {
    if (outputFile !== undefined) {
      appendFileSync(outputFile, `${text}\n`)
    } else {
      console.log(text)
    }
  }
  const run = (cwd: string, command: string): void => {
    if (outputFile !== undefined) {
      const outputFd = openSync(outputFile, 'a')
      try {
        execSync(command, {
          cwd, stdio: ['ignore', outputFd, outputFd], windowsHide: true,
        })
      } finally {
        closeSync(outputFd)
      }
    } else {
      const result = execSync(command, {
        cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      })
      if (result !== '') process.stdout.write(result)
    }
  }
  const tryRun = (cwd: string, command: string, label: string): boolean => {
    out(`=== ${label}: ${command} ===`)
    try {
      run(cwd, command)
      return true
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string }
      if (outputFile !== undefined) {
        appendFileSync(outputFile, `${failed.stdout ?? ''}${failed.stderr ?? ''}`)
      }
      return false
    }
  }
  return { out, run, tryRun }
}

function runMergeChecks(
  worktree: string,
  baseRef: string,
  options: MergeOptions,
  io: MergeIo,
): void {
  if (options.testCmd !== undefined && options.testCmd !== '') {
    io.out(`=== Running tests in worktree: ${options.testCmd} ===`)
    try {
      io.run(worktree, options.testCmd)
    } catch {
      throw new MergeError('Tests failed. Aborting merge.')
    }
    return
  }
  if (options.skipAutoTest === true) return

  const changed = git(worktree, ['diff', '--name-only', `${baseRef}...HEAD`])
    .split(/\r?\n/).filter((line) => line !== '')
  let ok = true
  for (const check of options.project.mergeChecks(options.taskGate)) {
    if (check.appliesTo !== undefined && !check.appliesTo(changed)) continue
    if (check.requires !== undefined && !existsSync(join(worktree, check.requires))) continue
    if (check.unless !== undefined && existsSync(join(worktree, check.unless))) continue
    const install = check.installWhenMissing
    if (install !== undefined && !existsSync(join(worktree, install.path))) {
      ok = io.tryRun(join(worktree, check.cwd), install.command, `${check.label} install`) && ok
    }
    ok = io.tryRun(join(worktree, check.cwd), check.command, check.label) && ok
  }
  if (!ok) throw new MergeError('Tests failed. Aborting merge.')
}

function removeTemporaryWorktree(paths: OrchPaths, worktree: string): void {
  try {
    git(paths.repoRoot, ['worktree', 'remove', worktree, '--force'])
  } catch {
    try {
      rmSync(worktree, { recursive: true, force: true })
      git(paths.repoRoot, ['worktree', 'prune'])
    } catch {
      // cleanup is best effort; the merge verdict is already known
    }
  }
}

/**
 * Merge a completed task into the current branch.
 * Uncommitted changes or a missing deliverable stop the merge and keep the worktree,
 * because removing it would lose work an agent forgot to commit.
 */
export async function mergeTask(paths: OrchPaths, taskId: string, options: MergeOptions): Promise<string> {
  const io = mergeIo(options.outputFile)
  const depsEvent = options.onOrchestrationDepsEvent
    ?? ((name: 'Installed' | 'WARN', subject: string) => io.out(`${name} ${subject}`))

  const status = readStatus(paths, taskId)
  if (status === undefined) {
    throw new MergeError(`Task not found: ${taskId}`)
  }
  if (status.status !== 'completed') {
    throw new MergeError(`Task status is not 'completed' (current: ${status.status}).`)
  }

  const worktree = worktreeDir(paths, taskId)
  const branch = branchName(taskId)
  const currentBranch = git(paths.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()

  if (git(worktree, ['status', '--porcelain']).trim() !== '') {
    throw new MergeError(
      `The worktree has uncommitted changes: ${worktree}\n`
      + 'The runner may have forgotten to commit. Review the changes, commit them in the '
      + 'worktree if they belong, then retry the merge.',
    )
  }

  const newCommits = git(worktree, ['log', `${currentBranch}..HEAD`, '--oneline']).trim()
  if (!isInspectionTaskId(paths, taskId) && newCommits === '') {
    throw new MergeError(
      `${taskId} has no new commits relative to ${currentBranch}.\n`
      + `Check the log: ${logFile(paths, taskId)}\nThe worktree will be kept: ${worktree}`,
    )
  }

  io.out(`=== ${taskId} diff (against ${currentBranch}) ===`)
  try {
    io.out(git(worktree, ['diff', `${currentBranch}...HEAD`]))
  } catch {
    // an empty inspection diff is fine
  }
  runMergeChecks(worktree, currentBranch, options, io)

  const mergeMessage = options.closesIssue === undefined
    ? `Merge ${taskId} via Codex`
    : `Merge ${taskId} via Codex (closes #${options.closesIssue})`
  try {
    git(paths.repoRoot, ['merge', '--quiet', '--no-ff', branch, '-m', mergeMessage])
  } catch {
    try {
      git(paths.repoRoot, ['merge', '--abort'])
    } catch {
      // nothing to abort
    }
    throw new MergeError('A merge conflict occurred. Rebase the worktree, then retry the merge.')
  }

  const mergeCommit = git(paths.repoRoot, ['rev-parse', 'HEAD']).trim()
  syncOrchestrationDepsAfterMerge(
    paths, mergeCommit, taskId, depsEvent, options.orchestrationDepsRuntime,
  )

  // Removing the worktree is tidying, not part of the merge. On Windows a handle held
  // by an editor or a scanner makes the removal fail with EBUSY, and letting that abort
  // once left the merge in place while the task was recorded as failed.
  removeMergedWorktree(paths, worktree, io.out)
  try {
    git(paths.repoRoot, ['branch', '-d', branch])
  } catch {
    try {
      git(paths.repoRoot, ['branch', '-D', branch])
    } catch {
      // an inspection task's branch may already be gone
    }
  }
  await writeStatus(paths, taskId, 'merged')
  io.out(`Merged ${taskId} and removed the worktree.`)
  return mergeCommit
}

/** Merge an already-fetched worker branch through the same selected checks as a local task. */
export async function mergeRemoteTask(
  paths: OrchPaths,
  issueNumber: number,
  branch: string,
  expectedHead: string,
  options: MergeOptions,
): Promise<string> {
  if (!/^task\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branch)) {
    throw new MergeError(`Issue #${issueNumber} reported an invalid task branch: ${branch}`)
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(expectedHead)) {
    throw new MergeError(`Issue #${issueNumber} reported an invalid head commit: ${expectedHead}`)
  }

  const remoteRef = `refs/remotes/origin/${branch}`
  let fetchedHead: string
  try {
    fetchedHead = git(paths.repoRoot, ['rev-parse', '--verify', remoteRef]).trim()
  } catch {
    throw new MergeError(`Remote branch ${branch} does not exist after fetch.`)
  }
  if (fetchedHead !== expectedHead) {
    throw new MergeError(
      `Remote branch ${branch} is at ${fetchedHead}, not the reported ${expectedHead}.`,
    )
  }

  const currentBranch = git(paths.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const commitCount = Number(git(paths.repoRoot, [
    'rev-list', '--count', `${currentBranch}..${remoteRef}`,
  ]).trim())
  if (!Number.isInteger(commitCount) || commitCount < 1) {
    throw new MergeError(`${branch} has no new commits relative to ${currentBranch}.`)
  }

  const taskId = branch.slice('task/'.length)
  const worktree = join(paths.worktreesDir, `.adopt-${issueNumber}-${process.pid}-${Date.now()}`)
  const io = mergeIo(options.outputFile)
  const depsEvent = options.onOrchestrationDepsEvent
    ?? ((name: 'Installed' | 'WARN', subject: string) => io.out(`${name} ${subject}`))
  const mergeMessage = `Merge ${taskId} via Codex (closes #${issueNumber})`
  try {
    git(paths.repoRoot, ['worktree', 'add', '--quiet', '--detach', worktree, currentBranch])
    try {
      git(worktree, ['merge', '--quiet', '--no-ff', remoteRef, '-m', mergeMessage])
    } catch {
      try {
        git(worktree, ['merge', '--abort'])
      } catch {
        // nothing to abort
      }
      throw new MergeError(`A merge conflict occurred while adopting ${branch}.`)
    }
    io.out(`=== ${taskId} diff (against ${currentBranch}) ===`)
    io.out(git(worktree, ['diff', `${currentBranch}...HEAD`]))
    runMergeChecks(worktree, currentBranch, options, io)

    try {
      git(paths.repoRoot, ['merge', '--quiet', '--no-ff', remoteRef, '-m', mergeMessage])
    } catch {
      try {
        git(paths.repoRoot, ['merge', '--abort'])
      } catch {
        // nothing to abort
      }
      throw new MergeError(`A merge conflict occurred while adopting ${branch}.`)
    }
    const mergeCommit = git(paths.repoRoot, ['rev-parse', 'HEAD']).trim()
    syncOrchestrationDepsAfterMerge(
      paths, mergeCommit, taskId, depsEvent, options.orchestrationDepsRuntime,
    )
    return mergeCommit
  } finally {
    removeTemporaryWorktree(paths, worktree)
  }
}
