import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Forge } from './adapters/forge.ts'
import type { ProjectAdapter } from './adapters/project.ts'
import { shortTaskId } from './ids.ts'
import {
  branchName, isInspectionTaskId, logFile, packageFile, worktreeDir, PACKAGE_ROOT,
  type OrchPaths,
} from './paths.ts'
import { readStatus, writeMergedStatus } from './status.ts'
import {
  removeWorktreeWithFallback, type WorktreeRemovalRuntime,
} from './worktree.ts'

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
   * Issue this merge resolves. Its forge decorates the merge commit so promotion
   * closes the issue when the commit lands on the default branch.
   */
  closesIssue?: number | undefined
  /** Required for a linked issue; the core does not know forge-specific closing syntax. */
  forge?: Pick<Forge, 'issueClosingCommitMessage'> | undefined
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
  /**
   * The package whose dependencies are synchronized. Defaults to this package's own
   * directory, which is what a running loop means; tests point it at a fixture.
   */
  packageRoot?: string
}

export type OrchestrationDepsEvent = (name: 'Installed' | 'WARN', subject: string) => void

const orchestrationDepsRuntime: OrchestrationDepsRuntime = {
  install: (cwd) => {
    execSync('npm ci --no-audit --no-fund', {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
  },
}

const ORCHESTRATION_MANIFESTS = new Set([
  packageFile('package.json'),
  packageFile('package-lock.json'),
])

function orchestrationManifests(root: string): Set<string> {
  return new Set(
    [...ORCHESTRATION_MANIFESTS].map((manifest) => resolve(root, relative(PACKAGE_ROOT, manifest))),
  )
}

function orchestrationLockHash(root: string): string | undefined {
  const lockFile = join(root, 'package-lock.json')
  if (!existsSync(lockFile)) return undefined
  return createHash('sha256').update(readFileSync(lockFile)).digest('hex')
}

function orchestrationLockHashFile(root: string): string {
  return join(root, 'node_modules', '.orchestration-lock.sha256')
}

function installFailureSummary(error: unknown): string {
  const failure = error as { stderr?: string | Buffer }
  const stderr = Buffer.isBuffer(failure.stderr)
    ? failure.stderr.toString('utf8')
    : failure.stderr
  return (stderr?.trim() || (error instanceof Error ? error.message : String(error)))
    .replaceAll(/\s+/g, ' ')
}

function installOrchestrationDeps(
  subject: string,
  event: OrchestrationDepsEvent,
  runtime: OrchestrationDepsRuntime,
): void {
  const root = runtime.packageRoot ?? PACKAGE_ROOT
  try {
    runtime.install(root)
    const lockHash = orchestrationLockHash(root)
    if (lockHash !== undefined) {
      const hashFile = orchestrationLockHashFile(root)
      mkdirSync(join(root, 'node_modules'), { recursive: true })
      writeFileSync(hashFile, `${lockHash}\n`)
    }
    event('Installed', ` orchestration deps  ${subject}`)
  } catch (error) {
    event('WARN', `orchestration deps install ${subject} failed: ${installFailureSummary(error)}`)
  }
}

function syncOrchestrationDepsAfterMerge(
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
  const manifests = orchestrationManifests(runtime.packageRoot ?? PACKAGE_ROOT)
  if (!changed.some((path) => manifests.has(resolve(paths.repoRoot, path)))) return
  installOrchestrationDeps(`after ${shortTaskId(taskId)}`, event, runtime)
}

function orchestrationDepsMissing(root: string): boolean {
  const manifestFile = join(root, 'package.json')
  if (!existsSync(manifestFile)) return false
  const lockHash = orchestrationLockHash(root)
  if (lockHash === undefined) return true
  try {
    if (readFileSync(orchestrationLockHashFile(root), 'utf8').trim() !== lockHash) return true
  } catch {
    return true
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const dependencies = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]
  return dependencies.some(
    (name) => !existsSync(join(root, 'node_modules', ...name.split('/'), 'package.json')),
  )
}

/** Whether `directory` is `root` or lies inside it, so a repository only syncs its own copy. */
function isInside(root: string, directory: string): boolean {
  const offset = relative(root, directory)
  return !offset.startsWith('..') && !isAbsolute(offset)
}

export function syncOrchestrationDepsAtStartup(
  paths: OrchPaths,
  event: OrchestrationDepsEvent,
  runtime: OrchestrationDepsRuntime = orchestrationDepsRuntime,
): void {
  const root = runtime.packageRoot ?? PACKAGE_ROOT
  // Installing is for the copy this repository carries. A CLI pointed at some other
  // checkout — a test fixture, another clone — must not reinstall the package it is
  // itself running from.
  if (!isInside(paths.repoRoot, root)) return
  if (!orchestrationDepsMissing(root)) return
  installOrchestrationDeps('at startup', event, runtime)
}

interface MergeIo {
  out: (text: string) => void
  run: (cwd: string, command: string) => void
  tryRun: (cwd: string, command: string, label: string) => boolean
}

const worktreeRemovalRuntime: WorktreeRemovalRuntime = {
  platform: process.platform,
  remove: rmSync,
  git,
}

export function removeMergedWorktree(
  paths: OrchPaths,
  worktree: string,
  log: (text: string) => void,
  runtime: WorktreeRemovalRuntime = worktreeRemovalRuntime,
): void {
  const result = removeWorktreeWithFallback(paths.repoRoot, worktree, runtime)
  if (result.fallback === undefined) return
  if (result.fallbackFailure !== undefined) {
    log(`WARN: merged, but the worktree is still there and has to go by hand: ${worktree} (${result.gitFailure})`)
    return
  }
  const fallback = result.fallback === 'windows-long-path'
    ? 'Windows long-path fallback'
    : 'direct-removal fallback'
  log(`Worktree removal needed the ${fallback}: ${worktree} (${result.gitFailure})`)
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
      try {
        const result = execSync(command, {
          cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        })
        if (result !== '') process.stdout.write(result)
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string }
        if (failed.stdout !== undefined && failed.stdout !== '') process.stdout.write(failed.stdout)
        if (failed.stderr !== undefined && failed.stderr !== '') process.stderr.write(failed.stderr)
        throw error
      }
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

  const baseMergeMessage = `Merge ${taskId} via orchestration`
  if (options.closesIssue !== undefined && options.forge === undefined) {
    throw new MergeError('A forge adapter is required to close the linked issue on promotion.')
  }
  const mergeMessage = options.closesIssue === undefined
    ? baseMergeMessage
    : options.forge!.issueClosingCommitMessage(baseMergeMessage, options.closesIssue)
  const prospectiveWorktree = join(
    paths.worktreesDir, `.merge-${shortTaskId(taskId)}-${process.pid}-${Date.now()}`,
  )
  try {
    git(paths.repoRoot, ['worktree', 'add', '--quiet', '--detach', prospectiveWorktree, currentBranch])
    try {
      git(prospectiveWorktree, ['merge', '--quiet', '--no-ff', branch, '-m', mergeMessage])
    } catch {
      try {
        git(prospectiveWorktree, ['merge', '--abort'])
      } catch {
        // nothing to abort
      }
      throw new MergeError('A merge conflict occurred. Rebase the worktree, then retry the merge.')
    }
    io.out(`=== ${taskId} diff (against ${currentBranch}) ===`)
    try {
      io.out(git(prospectiveWorktree, ['diff', `${currentBranch}...HEAD`]))
    } catch {
      // an empty inspection diff is fine
    }
    runMergeChecks(prospectiveWorktree, currentBranch, options, io)
  } finally {
    removeTemporaryWorktree(paths, prospectiveWorktree)
  }

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

  // Publish the merge identity before cleanup. If the process exits before the loop
  // records/comments on a linked issue, the next process can finish reconciliation
  // without attempting to merge commits that are already on the run branch.
  await writeMergedStatus(paths, taskId, mergeCommit, currentBranch)

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
  io.out(`Merged ${taskId} and removed the worktree.`)
  return mergeCommit
}

/** Merge an already-fetched worker branch through the same selected checks as a local task. */
export async function mergeRemoteTask(
  paths: OrchPaths,
  issueNumber: number,
  remote: string,
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

  const remoteRef = `refs/remotes/${remote}/${branch}`
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
  const baseMergeMessage = `Merge ${taskId} via orchestration`
  if (options.forge === undefined) {
    throw new MergeError('A forge adapter is required to close the linked issue on promotion.')
  }
  const mergeMessage = options.forge.issueClosingCommitMessage(baseMergeMessage, issueNumber)
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
