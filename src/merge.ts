import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, rmdirSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Forge } from './adapters/forge.ts'
import { operatingSystem } from './adapters/os.ts'
import type { ProjectAdapter } from './adapters/project.ts'
import { shortTaskId } from './ids.ts'
import { verifyModuleIsolation } from './moduleIsolation.ts'
import {
  branchName, isInspectionTaskId, logFile, packageFile, worktreeDir, PACKAGE_ROOT,
  type OrchPaths,
} from './paths.ts'
import {
  forgetTaskProcess, taskProcessPid, terminableTaskProcessPid,
} from './processRegistry.ts'
import { execShellSync } from './shell.ts'
import { noChangeMarkerPresent } from './refresh.ts'
import { readStatus, writeMergedStatus, writeStatus } from './status.ts'
import { currentProcessStartIdentity, lockOwnerIsCurrent } from './processOwner.ts'
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

/** A stale local task cannot be refreshed and must not be selected for merge again. */
export class RebaseConflictError extends MergeError {}

/** Remote bookkeeping for a valid no-change verdict failed and should be retried. */
export class NoChangeReconciliationError extends MergeError {}

/** A fatal dependency mismatch: continuing would run orchestration on the wrong tree. */
export class OrchestrationDepsInstallError extends MergeError {}

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
  /** All issues resolved by a grouped task; takes precedence over closesIssue. */
  closesIssues?: readonly number[] | undefined
  /** Required for a linked issue; the core does not know forge-specific closing syntax. */
  forge?: Pick<Forge, 'issueClosingCommitMessage'> | undefined
  /**
   * When set, everything the merge prints — including test output — goes to this file
   * instead of stdout, so a loop's log stays readable and the details stay findable.
   */
  outputFile?: string | undefined
  orchestrationDepsRuntime?: OrchestrationDepsRuntime | undefined
  onOrchestrationDepsEvent?: OrchestrationDepsEvent | undefined
  /** Close or otherwise reconcile linked work before accepting a no-change verdict. */
  onNoChange?: (() => Promise<void>) | undefined
  /** Worktree cleanup implementation; tests replace it to exercise retained cleanup state. */
  worktreeRemovalRuntime?: WorktreeRemovalRuntime | undefined
  /** Called only after this process has acquired the per-task merge guard. */
  onMergeStart?: (() => void) | undefined
  /** Report an idempotent attempt without treating it as a merge failure. */
  onMergeSkipped?: ((reason: 'active' | 'succeeded') => void) | undefined
}

export interface RemoteMergeOptions extends MergeOptions {
  /** Persist adoption before post-merge work begins or this function returns. */
  onMerged?: ((mergeCommit: string) => void) | undefined
}

export interface NoChangeOptions {
  outputFile?: string | undefined
  onNoChange?: (() => Promise<void>) | undefined
  /** Worktree cleanup implementation; tests replace it to exercise retained cleanup state. */
  worktreeRemovalRuntime?: WorktreeRemovalRuntime | undefined
}

export type MergeTaskResult =
  | { outcome: 'merged'; mergeCommit: string }
  | { outcome: 'no-change' }
  | { outcome: 'skipped'; reason: 'active' | 'succeeded' }

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

/** Use the standard installer against the package copy in the selected merge checkout. */
export function orchestrationDepsRuntimeForPackage(
  packageRoot: string,
): OrchestrationDepsRuntime {
  return { ...orchestrationDepsRuntime, packageRoot }
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
    event('Installed', subject)
  } catch (error) {
    throw new OrchestrationDepsInstallError(
      `Orchestration dependency installation ${subject} failed in ${root}: `
      + `${installFailureSummary(error)}. Run "npm ci --no-audit --no-fund" in ${root}, `
      + 'then restart the loop.',
    )
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
  // Only the repository this loop was started against gets its package synchronized. A
  // package outside it belongs to someone else's checkout, and installing there would
  // rewrite dependencies nobody here asked about.
  //
  // The package may equally be the repository — that is how this repository runs itself,
  // and a core that updates its own source has no one else to install the lockfile it
  // just pulled. `npm ci` empties node_modules before refilling it, so this is safe only
  // because it happens at startup, before any task or suite depends on that directory.
  // What must never happen is a process reaching this from somewhere else and pointing it
  // at its own package: that is why the daemon starts in the repository it was given
  // rather than in the package directory (see `cmdLoop`).
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
  os: operatingSystem,
  git,
}

function removeFinishedWorktree(
  paths: OrchPaths,
  worktree: string,
  log: (text: string) => void,
  runtime: WorktreeRemovalRuntime,
  completion: string,
): boolean {
  const result = removeWorktreeWithFallback(paths.repoRoot, worktree, runtime)
  if (result.fallback === undefined) return true
  if (result.fallbackFailure !== undefined) {
    log(`WARN: ${completion}, but the worktree is still there and has to go by hand: ${worktree} (${result.gitFailure})`)
    return false
  }
  log(`Worktree removal needed the ${result.fallback}: ${worktree} (${result.gitFailure})`)
  return true
}

export function removeMergedWorktree(
  paths: OrchPaths,
  worktree: string,
  log: (text: string) => void,
  runtime: WorktreeRemovalRuntime = worktreeRemovalRuntime,
): boolean {
  return removeFinishedWorktree(paths, worktree, log, runtime, 'merged')
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Bring a completed local task up to the run tip before any merge-gate work begins. */
function rebaseTaskOntoRunTip(
  worktree: string,
  currentBranch: string,
  io: MergeIo,
): void {
  try {
    git(worktree, ['merge-base', '--is-ancestor', currentBranch, 'HEAD'])
    return
  } catch {
    // The task started before later work landed on the run branch.
  }

  io.out(`=== Rebasing task onto ${currentBranch} ===`)
  try {
    git(worktree, [
      'rebase', '--quiet', '--reapply-cherry-picks', '--empty=keep', currentBranch,
    ])
  } catch {
    try {
      git(worktree, ['rebase', '--abort'])
    } catch {
      // nothing to abort
    }
    throw new RebaseConflictError(
      `A conflict occurred while rebasing the task onto ${currentBranch}; the rebase was aborted.`,
    )
  }
}

/** Whether every task commit has the same tree as its parent. */
function taskCommitsAreEmpty(worktree: string, currentBranch: string): boolean {
  const commits = git(worktree, ['rev-list', '--reverse', `${currentBranch}..HEAD`])
    .trim().split(/\s+/).filter((commit) => commit !== '')
  return commits.every((commit) =>
    git(worktree, ['rev-parse', `${commit}^{tree}`]).trim()
      === git(worktree, ['rev-parse', `${commit}^1^{tree}`]).trim())
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
        execShellSync(command, {
          cwd, stdio: ['ignore', outputFd, outputFd], windowsHide: true,
          encoding: 'utf8',
        })
      } finally {
        closeSync(outputFd)
      }
    } else {
      try {
        const result = execShellSync(command, {
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
    if (options.project.verifyDependencyIsolation === true
      && !ranIsolated(worktree, 'the worktree', io)) {
      throw new MergeError('Tests passed against borrowed dependencies. Aborting merge.')
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
    const directory = join(worktree, check.cwd)
    const passed = io.tryRun(directory, check.command, check.label)
    const isolated = options.project.verifyDependencyIsolation !== true
      || (passed && ranIsolated(directory, check.label, io))
    ok = passed && isolated && ok
  }
  if (!ok) throw new MergeError('Tests failed. Aborting merge.')
}

/**
 * Whether a check that just passed did so on dependencies of its own. A worktree sits
 * inside the checkout it was cut from, so Node resolves whatever the directory lacks from
 * the parent's node_modules: a half-finished install produces a pass against a dependency
 * tree nobody assembled, describing neither tree.
 *
 * This runs after the command, not before it, because a check may install as its own
 * first step — the core's own gate is `english-only && npm ci && tsc && npm test` in one
 * command, and judging it beforehand condemns every gate for a worktree that has not
 * installed yet.
 */
function ranIsolated(directory: string, label: string, io: MergeIo): boolean {
  const isolation = verifyModuleIsolation(directory)
  if (isolation.isolated) return true
  io.out(`=== ${label}: passed on dependencies it does not have ===`)
  io.out(isolation.reason ?? '')
  return false
}

export function removeTemporaryWorktree(
  paths: OrchPaths,
  worktree: string,
  runtime: WorktreeRemovalRuntime = worktreeRemovalRuntime,
): void {
  const result = removeWorktreeWithFallback(paths.repoRoot, worktree, runtime)
  if (result.fallbackFailure === undefined) return
  throw new MergeError(
    `Could not remove temporary worktree ${worktree}; merge was not applied. `
    + `(git: ${result.gitFailure}; fallback: ${result.fallbackFailure})`,
  )
}

function stopCompletedRunner(paths: OrchPaths, taskId: string, pid: number): void {
  const terminablePid = terminableTaskProcessPid(paths, taskId)
  if (terminablePid === undefined) {
    // A dead or replaced owner is already gone. An owner that remains visible only in
    // the blocking view lacks the identity needed to make termination safe.
    if (taskProcessPid(paths, taskId) !== undefined) {
      throw new MergeError(
        `Could not verify completed runner ${pid}; task state was retained.`,
      )
    }
    return
  }
  if (terminablePid !== pid) {
    throw new MergeError(`Completed runner ownership changed; task state was retained.`)
  }
  try {
    operatingSystem.terminateProcessTree(terminablePid)
    if (operatingSystem.processTreeIsAlive(terminablePid)) {
      throw new Error(`Process tree ${terminablePid} is still alive.`)
    }
    forgetTaskProcess(paths, taskId)
  } catch {
    throw new MergeError(
      `Could not stop completed runner ${terminablePid}; task state was retained.`,
    )
  }
}

/**
 * Find a merge this code already applied before its durable state callback failed.
 * The second parent identifies the exact task head, while the message distinguishes
 * orchestration's checked merge from an unrelated merge of the same commit.
 */
function appliedMergeCommit(
  repoRoot: string,
  runRef: string,
  mergedHead: string,
  mergeMessage: string,
): string | undefined {
  const merges = git(repoRoot, [
    'rev-list', '--first-parent', '--merges', '--parents', runRef,
  ]).split(/\r?\n/).filter((line) => line !== '')
  for (const merge of merges) {
    const [commit, firstParent, secondParent, ...otherParents] = merge.trim().split(/\s+/)
    if (commit === undefined || firstParent === undefined || secondParent !== mergedHead
      || otherParents.length > 0) continue
    if (git(repoRoot, ['show', '-s', '--format=%B', commit]).trim() === mergeMessage) {
      return commit
    }
  }
  return undefined
}

async function finalizeLocalMerge(
  paths: OrchPaths,
  taskId: string,
  currentBranch: string,
  branch: string,
  worktree: string,
  mergeCommit: string,
  io: MergeIo,
  depsEvent: OrchestrationDepsEvent,
  options: MergeOptions,
): Promise<string> {
  await writeMergedStatus(paths, taskId, mergeCommit, currentBranch)
  syncOrchestrationDepsAfterMerge(
    paths, mergeCommit, taskId, depsEvent, options.orchestrationDepsRuntime,
  )

  // Removing the worktree is tidying, not part of the merge. On Windows a handle held
  // by an editor or a scanner makes the removal fail with EBUSY, and letting that abort
  // once left the merge in place while the task was recorded as failed.
  const worktreeRemoved = removeMergedWorktree(
    paths, worktree, io.out, options.worktreeRemovalRuntime,
  )
  try {
    git(paths.repoRoot, ['branch', '-d', branch])
  } catch {
    try {
      git(paths.repoRoot, ['branch', '-D', branch])
    } catch {
      // an inspection task's branch may already be gone
    }
  }
  io.out(worktreeRemoved
    ? `Merged ${taskId} and removed the worktree.`
    : `Merged ${taskId}; manual worktree cleanup remains: ${worktree}`)
  return mergeCommit
}

async function finalizeNoChange(
  paths: OrchPaths,
  taskId: string,
  branch: string,
  worktree: string,
  io: MergeIo,
  options: NoChangeOptions,
): Promise<void> {
  try {
    await options.onNoChange?.()
  } catch (error) {
    throw new NoChangeReconciliationError(
      `Could not reconcile the no-change verdict: ${installFailureSummary(error)}`,
    )
  }
  await writeStatus(paths, taskId, 'no-change')
  const worktreeRemoved = removeFinishedWorktree(
    paths, worktree, io.out, options.worktreeRemovalRuntime ?? worktreeRemovalRuntime,
    'task completed without changes',
  )
  try {
    git(paths.repoRoot, ['branch', '-d', branch])
  } catch {
    try {
      git(paths.repoRoot, ['branch', '-D', branch])
    } catch {
      // The task branch may already be gone after an interrupted cleanup.
    }
  }
  io.out(worktreeRemoved
    ? `Completed ${taskId} without changes and removed the worktree.`
    : `Completed ${taskId} without changes; manual worktree cleanup remains: ${worktree}`)
}

/**
 * Accept an explicit no-change verdict against a caller-selected base. Worker mode may
 * run detached, so its known base SHA is authoritative rather than a branch name.
 */
export async function completeTaskWithoutChanges(
  paths: OrchPaths,
  taskId: string,
  baseRef: string,
  options: NoChangeOptions = {},
): Promise<void> {
  const status = readStatus(paths, taskId)
  if (status === undefined) throw new MergeError(`Task not found: ${taskId}`)
  if (status.status !== 'completed') {
    throw new MergeError(`Task status is not 'completed' (current: ${status.status}).`)
  }
  if (!noChangeMarkerPresent(paths, taskId)) {
    throw new MergeError(`${taskId} did not report NO_CHANGE_WARRANTED.`)
  }
  if (status.pid !== null) stopCompletedRunner(paths, taskId, status.pid)

  const worktree = worktreeDir(paths, taskId)
  if (git(worktree, ['status', '--porcelain']).trim() !== '') {
    throw new MergeError(`The worktree has uncommitted changes: ${worktree}`)
  }
  if (git(worktree, ['log', `${baseRef}..HEAD`, '--oneline']).trim() !== '') {
    throw new MergeError(`${taskId} has commits and cannot complete without changes.`)
  }

  await finalizeNoChange(
    paths, taskId, branchName(taskId), worktree, mergeIo(options.outputFile), options,
  )
}

interface MergeGuardOwner {
  state: 'active'
  pid: number
  startIdentity: string | null
}

function mergeGuardDir(paths: OrchPaths, taskId: string): string {
  return join(paths.queueDir, 'merge-guards', taskId)
}

function activeMergeGuardOwner(dir: string): MergeGuardOwner | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as Partial<MergeGuardOwner>
    if (value.state !== 'active' || !Number.isInteger(value.pid) || Number(value.pid) < 1) {
      return undefined
    }
    return {
      state: 'active',
      pid: Number(value.pid),
      startIdentity: typeof value.startIdentity === 'string' ? value.startIdentity : null,
    }
  } catch {
    return undefined
  }
}

function acquireMergeGuard(
  paths: OrchPaths,
  taskId: string,
): { acquired: true; file: string; owner: MergeGuardOwner } | {
  acquired: false
  reason: 'active' | 'succeeded'
} {
  const dir = mergeGuardDir(paths, taskId)
  mkdirSync(dirname(dir), { recursive: true })
  const owner: MergeGuardOwner = {
    state: 'active', pid: process.pid, startIdentity: currentProcessStartIdentity(),
  }
  for (;;) {
    try {
      mkdirSync(dir)
      writeFileSync(join(dir, 'owner.json'), `${JSON.stringify(owner)}\n`, { flag: 'wx' })
      return { acquired: true, file: dir, owner }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (existsSync(join(dir, 'succeeded'))) return { acquired: false, reason: 'succeeded' }
      const recorded = activeMergeGuardOwner(dir)
      // An ownerless directory is the narrow acquisition window of another process.
      if (recorded === undefined) return { acquired: false, reason: 'active' }
      if (lockOwnerIsCurrent(recorded.pid, recorded.startIdentity)) {
        return { acquired: false, reason: 'active' }
      }
      // Removing the owner before the directory makes stale reclamation safe between
      // multiple waiters: rmdir can never remove a replacement's non-empty guard.
      try {
        rmSync(join(dir, 'owner.json'))
        rmdirSync(dir)
      } catch {
        // A concurrent owner changed the marker; retry against its current state.
      }
    }
  }
}

function finishMergeGuard(
  guard: { file: string; owner: MergeGuardOwner },
  succeeded: boolean,
): void {
  let ownsGuard = false
  try {
    ownsGuard = readFileSync(join(guard.file, 'owner.json'), 'utf8').trim()
      === JSON.stringify(guard.owner)
  } catch {
    return
  }
  if (!ownsGuard) return
  if (!succeeded) {
    rmSync(guard.file, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    return
  }
  writeFileSync(join(guard.file, 'succeeded'), '')
  rmSync(join(guard.file, 'owner.json'), { force: true })
}

async function mergeTaskWithGuardHeld(
  paths: OrchPaths,
  taskId: string,
  options: MergeOptions,
): Promise<MergeTaskResult> {
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
  if (status.pid !== null) stopCompletedRunner(paths, taskId, status.pid)

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

  const baseMergeMessage = `Merge ${taskId} via orchestration`
  const closingIssues = options.closesIssues ?? (options.closesIssue === undefined
    ? []
    : [options.closesIssue])
  if (closingIssues.length > 0 && options.forge === undefined) {
    throw new MergeError('A forge adapter is required to close the linked issue on promotion.')
  }
  const mergeMessage = closingIssues.reduce(
    (message, issueNumber) => options.forge!.issueClosingCommitMessage(message, issueNumber),
    baseMergeMessage,
  )
  const newCommits = git(worktree, ['log', `${currentBranch}..HEAD`, '--oneline']).trim()
  if (newCommits === '') {
    const taskHead = git(worktree, ['rev-parse', 'HEAD']).trim()
    const appliedCommit = appliedMergeCommit(
      paths.repoRoot, currentBranch, taskHead, mergeMessage,
    )
    if (appliedCommit !== undefined) {
      const mergeCommit = await finalizeLocalMerge(
        paths, taskId, currentBranch, branch, worktree, appliedCommit,
        io, depsEvent, options,
      )
      return { outcome: 'merged', mergeCommit }
    }
    if (!isInspectionTaskId(paths, taskId) && noChangeMarkerPresent(paths, taskId)) {
      if (closingIssues.length > 0 && options.onNoChange === undefined) {
        throw new NoChangeReconciliationError(
          'A linked no-change task requires issue reconciliation.',
        )
      }
      await finalizeNoChange(paths, taskId, branch, worktree, io, options)
      return { outcome: 'no-change' }
    }
    if (!isInspectionTaskId(paths, taskId)) {
      throw new MergeError(
        `${taskId} has no new commits relative to ${currentBranch}.\n`
        + `Check the log: ${logFile(paths, taskId)}\nThe worktree will be kept: ${worktree}`,
      )
    }
  }
  rebaseTaskOntoRunTip(worktree, currentBranch, io)
  if (!isInspectionTaskId(paths, taskId) && taskCommitsAreEmpty(worktree, currentBranch)) {
    if (closingIssues.length > 0 && options.onNoChange === undefined) {
      throw new NoChangeReconciliationError(
        'A linked no-change task requires issue reconciliation.',
      )
    }
    await finalizeNoChange(paths, taskId, branch, worktree, io, options)
    return { outcome: 'no-change' }
  }
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
  // Publish the merge identity before any post-merge work. If dependency synchronization
  // or later cleanup is interrupted, startup can retry it without attempting to merge
  // commits that are already on the run branch or counting a false merge failure.
  const finalizedCommit = await finalizeLocalMerge(
    paths, taskId, currentBranch, branch, worktree, mergeCommit,
    io, depsEvent, options,
  )
  return { outcome: 'merged', mergeCommit: finalizedCommit }
}

/**
 * Merge a completed task into the current branch. A durable per-task guard makes the
 * operation idempotent across the daemon and CLI; failures release it for a real retry.
 * Uncommitted changes or a missing deliverable stop the merge and keep the worktree.
 */
export async function mergeTask(
  paths: OrchPaths,
  taskId: string,
  options: MergeOptions,
): Promise<MergeTaskResult> {
  const status = readStatus(paths, taskId)
  if (status?.status === 'merged' || status?.status === 'no-change') {
    options.onMergeSkipped?.('succeeded')
    return { outcome: 'skipped', reason: 'succeeded' }
  }
  const acquired = acquireMergeGuard(paths, taskId)
  if (!acquired.acquired) {
    options.onMergeSkipped?.(acquired.reason)
    return { outcome: 'skipped', reason: acquired.reason }
  }
  let succeeded = false
  try {
    const guardedStatus = readStatus(paths, taskId)
    if (guardedStatus?.status === 'merged' || guardedStatus?.status === 'no-change') {
      succeeded = true
      options.onMergeSkipped?.('succeeded')
      return { outcome: 'skipped', reason: 'succeeded' }
    }
    options.onMergeStart?.()
    const result = await mergeTaskWithGuardHeld(paths, taskId, options)
    succeeded = result.outcome === 'merged' || result.outcome === 'no-change'
    return result
  } finally {
    finishMergeGuard(acquired, succeeded)
  }
}

/** Merge an already-fetched worker branch through the same selected checks as a local task. */
export async function mergeRemoteTask(
  paths: OrchPaths,
  issueNumber: number,
  remote: string,
  branch: string,
  expectedHead: string,
  options: RemoteMergeOptions,
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

  const taskId = branch.slice('task/'.length)
  const worktree = join(paths.worktreesDir, `.adopt-${issueNumber}-${process.pid}-${Date.now()}`)
  const io = mergeIo(options.outputFile)
  const depsEvent = options.onOrchestrationDepsEvent
    ?? ((name: 'Installed' | 'WARN', subject: string) => io.out(`${name} ${subject}`))
  const baseMergeMessage = `Merge ${taskId} via orchestration`
  if (options.forge === undefined) {
    throw new MergeError('A forge adapter is required to close the linked issue on promotion.')
  }
  const closingIssues = options.closesIssues ?? [issueNumber]
  const mergeMessage = closingIssues.reduce(
    (message, closingIssue) => options.forge!.issueClosingCommitMessage(message, closingIssue),
    baseMergeMessage,
  )
  const currentBranch = git(paths.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const commitCount = Number(git(paths.repoRoot, [
    'rev-list', '--count', `${currentBranch}..${remoteRef}`,
  ]).trim())
  if (!Number.isInteger(commitCount) || commitCount < 1) {
    const appliedCommit = appliedMergeCommit(
      paths.repoRoot, currentBranch, expectedHead, mergeMessage,
    )
    if (appliedCommit === undefined) {
      throw new MergeError(`${branch} has no new commits relative to ${currentBranch}.`)
    }
    options.onMerged?.(appliedCommit)
    syncOrchestrationDepsAfterMerge(
      paths, appliedCommit, taskId, depsEvent, options.orchestrationDepsRuntime,
    )
    return appliedCommit
  }
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
  } finally {
    removeTemporaryWorktree(paths, worktree)
  }

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
  options.onMerged?.(mergeCommit)
  syncOrchestrationDepsAfterMerge(
    paths, mergeCommit, taskId, depsEvent, options.orchestrationDepsRuntime,
  )
  return mergeCommit
}
