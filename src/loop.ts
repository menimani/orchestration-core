import { execFileSync } from 'node:child_process'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  ForgeIssueNotFoundError, ForgeRateLimitError, type Forge, type ForgeIssue, type ForgeIssueComment,
} from './adapters/forge.ts'
import { dequeueBacklog, ensureBacklog } from './backlog.ts'
import type { ProjectAdapter, SuiteStep } from './adapters/project.ts'
import type { Runner } from './adapters/runner.ts'
import { cleanupTask } from './cleanup.ts'
import type { LoopConfig } from './config.ts'
import {
  descSlug, existingTaskIdForDesc, taskIdForDesc, newTaskId, recordTaskIdForDesc,
  shortTaskId,
} from './ids.ts'
import {
  completeTaskWithoutChanges, mergeRemoteTask, mergeTask, MergeError, MergeRecoveryError,
  NoChangeReconciliationError, RebaseConflictError, TEST_LOCK_BUSY_EXIT_CODE, TestLockBusyError,
  UnverifiedRunnerError, OrchestrationDepsInstallError, syncOrchestrationDepsAfterRecordedMerge,
  VerificationFailedError, withMergeGuard, type OrchestrationDepsRuntime,
} from './merge.ts'
import {
  finalMessageFile, isInspectionTaskId, isReviewTaskId, isScanTaskId, issueQueueIsSeparate, logFile,
  branchName, conflictBranchName, PACKAGE_ROOT, shellPathSpelling, worktreeDir, type OrchPaths,
} from './paths.ts'
import {
  conflictRetriesExhausted, conflictRetrySection, issueConflictKey, readConflictedAttempts,
  removeConflictedAttempts, retireConflictedAttempts as retireKeptConflictedAttempts,
  writeConflictedAttempts, type ConflictedAttempt,
} from './conflictRetry.ts'
import {
  gateFixFinalMessageFile, gateFixRunActive, gateFixSpecFile, gateFixSpecification,
  markGateFixRunActive, mergeLogTail, readGateFixState, removeGateFixState,
  writeGateFixState,
} from './gateFix.ts'
import { buildPrBody, GENERATED_BODY_MARKER, prTitle } from './prbody.ts'
import {
  refreshTask, listTaskIds, noChangeMarkerPresent, type DeadlineVerdict,
} from './refresh.ts'
import { readStatus, readTaskState, transitionStatus, type TaskState } from './status.ts'
import {
  resumeTask, startTask, StartupOwnershipUnknownError, StartupProcessRetainedError,
} from './start.ts'
import { enqueueTask, newTaskSpec, specFile } from './tasks.ts'
import {
  terminateLiveTaskProcesses, type TaskProcessTermination,
} from './taskProcesses.ts'
import {
  frameUntrustedText, frameVerifiedRequirement, readTemplate, repositoryInspectionPreamble,
  reviewScopeTemplateValues,
} from './templates.ts'
import { pitfallsFileForDesc } from './gates.ts'
import { currentBranchPushRemote, currentBranchTrackingRemote } from './gitRemote.ts'
import { LoopWarningLog } from './loopLog.ts'
import { newestChecksByName } from './ciWait.ts'
import { execShellSync } from './shell.ts'
import { operatingSystem, type OperatingSystem } from './adapters/os.ts'
import { interruptedScansFileName } from './scanRecovery.ts'
import {
  clearHeldFindings, heldFindingsFileName, readHeldFindings, writeHeldFindings,
} from './heldFindings.ts'
import {
  updateCoreBeforeCycle, type CoreUpdateOutcome,
} from './coreUpdate.ts'
import { absorbDefaultBranch } from './branchTopology.ts'
import {
  claimIssueGroup, closeIssueAndRemoveLifecycleLabels, closePromotedIssues, commentOnIssueMerge,
  confirmIssuePromotion, dropClaimedTaskMaterialization, groupReadyFindings,
  heartbeatIssueForTask, fingerprintOf, issueMergeComment,
  issueHasExactlyLifecycleLabel, issueNumberForTask, issueNumbersForTask, issuePromotionForIssue,
  isDocumentationFinding, isReadyToClaim,
  issueSourcesForTask, markIssueMergeFailed, missingRequirementCompletionMarkers, parseIssueBody,
  openFindingCoversHeld, publishFinding,
  mergeMarkerStanding, reapStaleLeases, sourceIssueNumbers, standingMergeMarkers,
  trustedCommentPresent,
  completeIssueReleaseIntent, issueReleaseIntentForTask, prepareIssueReleaseIntent,
  reconcileIssueReleaseIntent, type RunBranchProbe,
  clearIssueFailureCounts, recordIssueCompletions, recordIssueFailure,
  recordIssueReleaseIntent, recordIssuesForTask, recordIssuePromotions,
  removeIssueReleasePreparation,
  returnIssueToReady,
  ensureQueueLabels, reconcileClosedIssueLifecycleLabels, reconcileFindingFingerprints,
  unresolvedFindings, type ClaimedRequirement, IssueReleaseReconciliationError,
  LABEL_FINDING, LABEL_IN_PROGRESS, LABEL_MERGE_FAILED, LABEL_MERGE_READY, LABEL_READY,
  LABEL_UNTRUSTED_AUTHOR,
} from './issueQueue.ts'

// The loop core. Every behavior here was learned from a specific failure — the comments
// carry the incident, SPEC.md carries the checklist, and the gate tests pin the sum.

export interface LoopDeps {
  paths: OrchPaths
  config: LoopConfig
  forge: Forge
  runner: Runner
  project: ProjectAdapter
  log: (line: string) => void
  marker?: ((line: string) => void) | undefined
  now: () => Date
  orchestrationDepsRuntime?: OrchestrationDepsRuntime | undefined
  terminateTaskProcesses?: (() => TaskProcessTermination) | undefined
  enqueueTask?: typeof enqueueTask
  startTask?: typeof startTask
  resumeTask?: typeof resumeTask
  updateCoreBeforeCycle?: (cycle: number) => Promise<CoreUpdateOutcome>
  projectAdapterChanged?: () => boolean
  branchGuard?: (() => string | undefined) | undefined
  prepareIntegrationWorktree?: (() => void) | undefined
  os?: OperatingSystem | undefined
}

interface QueueEntry {
  taskId: string
  depth: number
}

interface FindingDispatch {
  findings: string[]
  destinations: string[]
  reconciled: boolean
  /** Why a finding could not be filed, unless the forge only asked the loop to wait. */
  failure?: string
}

const IDLE_LOG_MAX_INTERVAL_MS = 5 * 60 * 1000
const MAX_CONSECUTIVE_ISSUE_RELEASE_FAILURES = 3
// A worker publication that keeps failing for another reason, such as a rejected push or
// a forge error, is retried on this many polls before the task is failed.
const MAX_WORKER_PUBLICATION_FAILURES = 5
// A remote adoption deferred for a transient reason on this many consecutive polls stops the
// loop. Twenty polls is about ten minutes at the default interval: longer than an ordinary
// outage blip, and short enough that a failure that never clears, such as an expired git
// credential, does not keep the loop spinning on the same issue for hours.
const MAX_CONSECUTIVE_ADOPTION_DEFERRALS = 20

class InvalidPersistedCounterError extends Error {}
// A finished worker task whose output can never be published as it stands. Retrying the
// publication cannot help, because the worker that would change it has already exited.
class UnpublishableWorkerTaskError extends Error {}
// A finished worker task whose issues are no longer its own: a lapsed claim was reaped and
// may already belong to another task, so reporting this branch there would have the merger
// adopt stale work.
class LostWorkerClaimError extends UnpublishableWorkerTaskError {
  readonly lostIssues: number[]

  constructor(lostIssues: number[]) {
    super(`${lostIssues.map((number) => `#${number}`).join(', ')} no longer claimed by this task`)
    this.lostIssues = lostIssues
  }
}

// A worker branch report whose author's write access could not be determined. Neither
// trusting nor ignoring the report is safe, so the step that needed it waits for a later
// poll.
class UndeterminedWorkerReportError extends Error {
  constructor(issueNumber: number) {
    super(`the worker branch report on issue #${issueNumber} has an author whose write access could not be determined`)
  }
}

// A forge read or a fetch that failed for a reason that says nothing about the worker's
// pushed work, such as a forge outage or a network error. Marking the issue failed would
// quarantine finished work until a person relabels it, so the adoption waits for a later
// poll instead.
class TransientAdoptionError extends Error {
  /** What kind of step failed, for a log line that must not quote git's or the forge's text. */
  readonly kind: string

  constructor(kind: string, message: string) {
    super(message)
    this.kind = kind
  }
}

function formatIdleDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m${seconds === 0 ? '' : `${seconds}s`}`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h${remainingMinutes === 0 ? '' : `${remainingMinutes}m`}`
}

function nextIdleLogAge(milliseconds: number): number {
  if (milliseconds < 30_000) return 30_000
  if (milliseconds < 60_000) return 60_000
  if (milliseconds < 2 * 60_000) return 2 * 60_000
  return Math.max(
    IDLE_LOG_MAX_INTERVAL_MS,
    (Math.floor(milliseconds / IDLE_LOG_MAX_INTERVAL_MS) + 1)
      * IDLE_LOG_MAX_INTERVAL_MS,
  )
}

export function formatEventLine(name: string, subject = '', detail = ''): string {
  if (subject === '') return name
  if (detail === '') return `${name} ${subject}`
  const subjectColumn = subject.length < 12 ? subject.padEnd(12) : `${subject}  `
  return `${name} ${subjectColumn}${detail}`
}

export function createLoop(deps: LoopDeps) {
  const {
    paths, config, forge: rawForge, runner, project, log, marker = log, now,
    orchestrationDepsRuntime,
    terminateTaskProcesses = () => terminateLiveTaskProcesses(paths),
    enqueueTask: enqueueTaskImpl = enqueueTask,
    startTask: startTaskImpl = startTask,
    resumeTask: resumeTaskImpl = resumeTask,
    os = operatingSystem,
  } = deps
  const queueFile = join(paths.queueDir, 'backlog.txt')
  const stopFile = join(paths.queueDir, 'stop')
  const scannedDir = join(paths.queueDir, 'scanned')
  const scanCountFile = join(paths.queueDir, 'scan-count.txt')
  const emptyScanFile = join(paths.queueDir, 'empty-scan-count.txt')
  const mergeFailureFile = join(paths.queueDir, 'merge-failure-count.txt')
  const issueReleaseFailureFile = join(paths.queueDir, 'issue-release-failure-count.txt')
  const runBranchFile = join(paths.queueDir, 'run-branch.txt')
  const decisionsFile = join(paths.queueDir, 'decisions.txt')
  const prUrlFile = join(paths.queueDir, 'pr-url.txt')
  const totalTaskCountFile = join(paths.queueDir, 'total-task-count.txt')
  const announcedFailuresFile = join(paths.queueDir, 'announced-failures.txt')
  let emptyRun = false
  let finalGateReopened = false

  mkdirSync(scannedDir, { recursive: true })
  ensureBacklog(queueFile)

  // A graceful daemon shutdown terminates its in-flight process trees and removes
  // their ephemeral PID records, while their durable task status remains running.
  // The next daemon must still report those tasks as failed, but they are not fresh
  // evidence of a broken environment and therefore must not trip the burst guard.
  const tasksDeadAtStartup = new Set(listTaskIds(paths).filter((taskId) => {
    try {
      const status = readStatus(paths, taskId)
      return status?.status === 'running' && status.pid === null
    } catch {
      // The poll owns malformed-status reporting; startup classification must not move
      // that failure outside its existing error boundary.
      return false
    }
  }))
  // A finished run removes every `.failed` flag but keeps the task statuses, and lists
  // the failures it already announced. Those belong to that run's PR and issue budget,
  // so this run neither reports them again nor counts them toward the burst guard.
  const tasksFailedBeforeStartup = new Set(existsSync(announcedFailuresFile)
    ? readFileSync(announcedFailuresFile, 'utf8').split(/\r?\n/).filter((taskId) => taskId !== '')
    : [])
  // A task can also be failed before the first poll sees it: a status query after a
  // crash fails running tasks whose runner is gone, and a run on another branch can
  // leave failures it never announced. Each is still announced once and counted
  // against its issues' retry budget, but it is not fresh evidence of a broken
  // environment and therefore must not trip the burst guard either.
  const tasksFailedAtStartup = new Set(listTaskIds(paths).filter((taskId) => {
    try {
      return readStatus(paths, taskId)?.status === 'failed'
        && !existsSync(join(scannedDir, `${taskId}.failed`))
        && !tasksFailedBeforeStartup.has(taskId)
    } catch {
      // The poll owns malformed-status reporting, as for the startup set above.
      return false
    }
  }))
  // Trees stopped so a merged dependency change can be installed died for the loop's
  // own reason, not the task's. Like the startup set, they are reported failed and
  // their issues released, but they count toward neither an issue's retry budget nor
  // the burst guard.
  const tasksStoppedForDependencyInstall = new Set<string>()

  // Resolved once per process; the login cannot change under a running loop.
  let cachedUser: string | undefined
  const warningLog = new LoopWarningLog(paths, log, now)
  let remoteWaitState: { pending: string; loggedAt: number } | undefined
  let forgeRateLimitUntil = 0
  let loggedForgeRateLimitUntil = 0
  const issueCommentCache = new Map<number, {
    updatedAt: string
    comments: ForgeIssueComment[]
  }>()
  const reconciledCycleGates = new Set<number>()
  // The merge marker each adopted issue was given this run, so a marker the listing does
  // not yet show as trusted is waited for rather than posted again on every poll.
  const postedMergeMarkers = new Map<number, string>()
  // Consecutive transient adoption deferrals per merge-ready issue, kept in memory only.
  const adoptionDeferrals = new Map<number, number>()
  let issueQueueInitialized = !config.issueQueueEnabled
  const previousGateFailures = new Map<string, number>()
  // The check names the previous CI gate poll saw, for the PR and head it saw them on.
  let previousCiPoll: { url: string; headSha: string; names: string[] } | undefined
  let gateWaitTarget: string | undefined
  let idleLogState: {
    startedAt: number
    nextLogAge: number
    detail: string
  } | undefined

  function event(name: string, subject = '', detail = ''): void {
    if (name === 'WARN') {
      const caller = new Error().stack?.split(/\r?\n/)[2]?.trim() ?? subject
      warningLog.warn(caller, subject.split(':', 1)[0] || 'operation', subject)
      return
    }
    log(formatEventLine(name, subject, detail))
  }

  const updateCore = deps.updateCoreBeforeCycle ?? ((cycle: number) =>
    updateCoreBeforeCycle(
      paths,
      config,
      rawForge,
      runner,
      project,
      cycle,
      (name, subject, detail = '') => event(name, subject, detail),
    ))
  const projectAdapterChanged = deps.projectAdapterChanged ?? (() => false)
  const branchGuard = deps.branchGuard ?? (() => undefined)
  const prepareIntegration = deps.prepareIntegrationWorktree ?? (() => undefined)
  let restartSubject = 'core'

  function rateLimitTime(resetAt: Date): string {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(resetAt)
  }

  function noteForgeRateLimit(error: ForgeRateLimitError): void {
    const currentTime = now().getTime()
    const resetTime = Number.isFinite(error.resetAt.getTime())
      ? error.resetAt.getTime()
      : currentTime + 60_000
    forgeRateLimitUntil = Math.max(forgeRateLimitUntil, resetTime)
    if (loggedForgeRateLimitUntil !== forgeRateLimitUntil) {
      event(
        'Waiting', 'forge',
        `rate limit until ${rateLimitTime(new Date(forgeRateLimitUntil))}`,
      )
      loggedForgeRateLimitUntil = forgeRateLimitUntil
    }
  }

  const forge = new Proxy(rawForge, {
    get(target, property, receiver) {
      const member = Reflect.get(target, property, receiver)
      if (typeof member !== 'function') return member
      return async (...args: unknown[]) => {
        const currentTime = now().getTime()
        if (forgeRateLimitUntil > currentTime) {
          throw new ForgeRateLimitError(new Date(forgeRateLimitUntil))
        }
        if (forgeRateLimitUntil !== 0) {
          forgeRateLimitUntil = 0
          loggedForgeRateLimitUntil = 0
        }
        try {
          return await Reflect.apply(member, target, args)
        } catch (error) {
          if (error instanceof ForgeRateLimitError) noteForgeRateLimit(error)
          throw error
        }
      }
    },
  }) as Forge

  async function commentsForIssue(issue: ForgeIssue): Promise<ForgeIssueComment[]> {
    const cached = issueCommentCache.get(issue.number)
    if (cached?.updatedAt === issue.updatedAt) return cached.comments
    const comments = await forge.listIssueComments(issue.number)
    // A failed permission lookup is not a verdict. Caching it by updatedAt would hold
    // that undetermined answer until the issue next changes, so the next poll asks again.
    if (comments.some((comment) => comment.author.permissionLookupFailed === true)) {
      issueCommentCache.delete(issue.number)
    } else {
      issueCommentCache.set(issue.number, { updatedAt: issue.updatedAt, comments })
    }
    return comments
  }

  async function issueHasMergeMarker(issue: ForgeIssue): Promise<boolean | undefined> {
    return mergeMarkerStanding(await commentsForIssue(issue))
  }

  async function initializeIssueQueue(): Promise<boolean> {
    if (!config.issueQueueEnabled) return true
    if (issueQueueInitialized) return true
    try {
      await ensureQueueLabels(forge)
      warningLog.recovered('ensure-queue-labels')
    } catch (error) {
      if (!(error instanceof ForgeRateLimitError)) {
        warning('ensure-queue-labels', 'ensuring issue queue labels',
          `could not ensure issue queue labels: ${errorSummary(error)}`)
      }
      return false
    }
    try {
      await reconcileClosedIssueLifecycleLabels(forge)
      warningLog.recovered('reconcile-closed-issue-labels')
    } catch (error) {
      if (error instanceof ForgeRateLimitError) return false
      warning('reconcile-closed-issue-labels', 'reconciling closed issue labels',
        `could not reconcile closed issue labels: ${errorSummary(error)}`)
      return false
    }
    issueQueueInitialized = true
    return true
  }

  function orchestrationDepsEvent(name: 'Installed' | 'Skipped' | 'WARN', subject: string): void {
    if (name === 'WARN') {
      event(name, subject)
      return
    }
    event(name, 'orchestration deps', subject)
  }

  function stopTaskProcessesBeforeDependencyInstall(): boolean {
    const result = terminateTaskProcesses()
    for (const task of result.terminated) {
      tasksStoppedForDependencyInstall.add(task.taskId)
      event('Stopped', shortTaskId(task.taskId),
        `process tree PID ${task.pid} before dependency installation`)
    }
    for (const failure of result.failures) {
      event('WARN',
        `dependency installation skipped; process tree ${shortTaskId(failure.taskId)} `
        + `PID ${failure.pid} survived: ${failure.error}`)
    }
    return result.failures.length === 0
  }

  function reportTaskDeadline(verdict: DeadlineVerdict): void {
    const hours = config.taskDeadlineHours
    if (verdict.stopped) {
      warningLog.recovered(`deadline-${verdict.taskId}`)
      event('Stopped', shortTaskId(verdict.taskId),
        `process tree PID ${verdict.pid} after the ${hours}-hour task deadline`)
      return
    }
    warning(`deadline-${verdict.taskId}`, `deadline stop for ${shortTaskId(verdict.taskId)}`,
      `${shortTaskId(verdict.taskId)} passed the ${hours}-hour task deadline but process tree `
      + `PID ${verdict.pid} could not be stopped: ${verdict.error}`)
  }

  function warning(callSite: string, operation: string, subject: string): void {
    warningLog.warn(callSite, operation, subject)
  }

  function shortLogPath(file: string): string {
    return shellPathSpelling(relative(paths.root, file))
  }

  function errorSummary(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.trim() || 'unknown error'
  }

  function reportGateFailure(message: string, gate = 'draft-pr'): void {
    const previous = previousGateFailures.get(gate)
    const count = (previous ?? 0) + 1
    previousGateFailures.set(gate, count)
    const detail = count === 1 ? message : `${message} (repeated ${count} times)`
    if (count > 1) {
      event('ERROR', detail)
      writeFileSync(stopFile, '')
    } else {
      log(formatEventLine('WARN', detail))
    }
  }

  function requeueAfterStartupFailure(taskId: string, depth: number, error: unknown): void {
    const failure = `${shortTaskId(taskId)} startup failed: ${errorSummary(error)}`
    try {
      enqueueTaskImpl(paths, taskId, depth)
    } catch (requeueError) {
      event('ERROR', `${failure}; could not requeue: ${errorSummary(requeueError)}`)
      writeFileSync(stopFile, '')
      return
    }
    reportGateFailure(failure, `task-startup-${taskId}`)
  }

  function readCount(file: string): number {
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    const value = raw.trim()
    const count = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(count)) {
      const stateFile = shellPathSpelling(relative(paths.root, file))
      const message = `persisted counter ${stateFile} is invalid; expected a non-negative integer; stopping the loop`
      event('ERROR', message)
      writeFileSync(stopFile, '')
      throw new InvalidPersistedCounterError(message)
    }
    return count
  }

  function git(args: string[]): string {
    return gitIn(paths.repoRoot, args)
  }

  function optionalGit(args: string[], quietSuccess = ''): string {
    try {
      const output = git(args)
      return output === '' ? quietSuccess : output
    } catch {
      return ''
    }
  }

  // Exit 1 is the only answer that means "not contained". Any other failure, such as a
  // merged head that was pushed outside the loop and never fetched, would otherwise leave
  // the promoted issue open on every poll while the bookkeeping reported success.
  function promotedCommitContained(ancestor: string, descendant: string): boolean {
    const compare = (): { status: number | null, detail: string } => {
      try {
        git(['merge-base', '--is-ancestor', ancestor, descendant])
        return { status: 0, detail: '' }
      } catch (error) {
        const failure = error as { status?: number | null, stderr?: string, message?: string }
        return {
          status: failure.status ?? null,
          detail: (failure.stderr ?? failure.message ?? '').trim(),
        }
      }
    }
    let result = compare()
    if (result.status !== 0 && result.status !== 1) {
      git(['fetch', '--quiet', currentBranchPushRemote(paths.repoRoot), descendant])
      result = compare()
    }
    if (result.status === 0) return true
    if (result.status === 1) return false
    throw new Error(`could not tell whether ${descendant} contains ${ancestor}`
      + (result.detail === '' ? '' : `: ${result.detail}`))
  }

  // Git answers each question with exit 0 or a single documented "no" status; any other
  // failure leaves it unanswered, so the promoted issues keep waiting.
  function gitAnswer(args: string[], noStatus: number): boolean | undefined {
    try {
      git(args)
      return true
    } catch (error) {
      return (error as { status?: number | null }).status === noStatus ? false : undefined
    }
  }

  function runBranchProbe(
    stranded: (runBranch: string, issueNumbers: number[]) => void,
  ): RunBranchProbe {
    // One fetch of the default branch serves every merge commit of the poll.
    let defaultRef: string | undefined | null = null
    function fetchedDefaultRef(): string | undefined {
      if (defaultRef !== null) return defaultRef
      defaultRef = undefined
      try {
        const remote = currentBranchTrackingRemote(paths.repoRoot)
        const ref = git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]).trim()
        if (!ref.startsWith(`${remote}/`)) return undefined
        git(['fetch', '--quiet', remote, ref.slice(remote.length + 1)])
        defaultRef = ref
      } catch {
        // An unknown default branch answers nothing.
      }
      return defaultRef
    }
    return {
      remoteBranchExists: (runBranch) => {
        let remote: string
        try {
          remote = currentBranchPushRemote(paths.repoRoot)
        } catch {
          return undefined
        }
        return gitAnswer(['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${runBranch}`], 2)
      },
      localBranchExists: (runBranch) =>
        gitAnswer(['show-ref', '--verify', '--quiet', `refs/heads/${runBranch}`], 1),
      // An unknown merge commit makes merge-base fail with a status other than 1, which
      // leaves the question unanswered rather than treating the work as lost.
      onHead: (mergeCommit) => gitAnswer(['merge-base', '--is-ancestor', mergeCommit, 'HEAD'], 1),
      onDefaultBranch: (mergeCommit) => {
        const ref = fetchedDefaultRef()
        return ref === undefined
          ? undefined
          : gitAnswer(['merge-base', '--is-ancestor', mergeCommit, ref], 1)
      },
      stranded,
    }
  }

  function gitIn(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
  }

  async function publishWorkerCompletion(taskId: string, issueNumbers: number[]): Promise<void> {
    const missingMarkers = missingRequirementCompletionMarkers(paths, taskId)
    if (missingMarkers.length > 0) {
      throw new UnpublishableWorkerTaskError(`missing requirement completion markers for ${missingMarkers.map((number) => `#${number}`).join(', ')}`)
    }
    const worktree = worktreeDir(paths, taskId)
    // The comparison base is the checkout's HEAD SHA, not its branch name: a detached
    // worker checkout has an empty branch name, which read as zero commits and left
    // completed work permanently unpublished. A failed read throws so that publication is
    // retried: an empty base would list no commits and close committed work unpublished.
    const baseSha = git(['rev-parse', '--verify', 'HEAD^{commit}']).trim()
    if (gitIn(worktree, ['status', '--porcelain']).trim() !== '') {
      throw new UnpublishableWorkerTaskError(`${taskId} has uncommitted changes`)
    }
    const commits = gitIn(worktree, ['log', `${baseSha}..HEAD`, '--format=%H'])
      .trim().split(/\r?\n/).filter((line) => line !== '')
    if (commits.length === 0) {
      // Re-read every claim right before closing it. An issue an earlier attempt already
      // closed is finished again harmlessly; an open issue that left loop:in-progress was
      // reaped, and may since have been handed to another task.
      const lost: number[] = []
      for (const issueNumber of issueNumbers) {
        const issue = await forge.getIssue(issueNumber)
        if (issue.state === 'open' && (!issue.labels.includes(LABEL_IN_PROGRESS)
          || issue.labels.includes(LABEL_READY))) lost.push(issueNumber)
      }
      if (lost.length > 0) throw new LostWorkerClaimError(lost)
      if (isInspectionTaskId(paths, taskId)) {
        await Promise.all(issueNumbers.map((issueNumber) =>
          closeIssueAndRemoveLifecycleLabels(forge, issueNumber,
            `Inspection task ${taskId} completed without commits.`)))
        return
      }
      if (noChangeMarkerPresent(paths, taskId)) {
        await completeTaskWithoutChanges(paths, taskId, baseSha, {
          outputFile: join(paths.logsDir, `${taskId}.merge.log`),
          onNoChange: async () => {
            await Promise.all(issueNumbers.map((issueNumber) =>
              closeIssueAndRemoveLifecycleLabels(forge, issueNumber,
                `Task ${taskId} completed without commits after reporting that no change was warranted.`)))
            recordIssueCompletions(paths, taskId, 'no-change')
          },
        })
        return
      }
      throw new UnpublishableWorkerTaskError(`${taskId} has no commits and is not an inspection task`)
    }

    const branch = branchName(taskId)
    const head = gitIn(worktree, ['rev-parse', 'HEAD']).trim()
    // Re-read every claim right before reporting on it. An issue an earlier attempt already
    // reported is skipped; any other issue that left loop:in-progress was reaped, and may
    // since have been handed to another task.
    const pending: number[] = []
    const lost: number[] = []
    for (const issueNumber of issueNumbers) {
      const issue = await forge.getIssue(issueNumber)
      if (issue.state === 'open' && issue.labels.includes(LABEL_IN_PROGRESS)
        && !issue.labels.includes(LABEL_READY)) {
        pending.push(issueNumber)
        continue
      }
      const report = issue.labels.includes(LABEL_MERGE_READY)
        ? workerBranchReport(await commentsForIssue(issue))
        : undefined
      // An ordinary failure, so the publication is retried rather than the claim given up.
      if (report === 'undetermined') throw new UndeterminedWorkerReportError(issueNumber)
      if (report?.branch !== branch || report.head !== head) lost.push(issueNumber)
    }
    if (lost.length > 0) throw new LostWorkerClaimError(lost)

    const remote = currentBranchPushRemote(paths.repoRoot)
    gitIn(worktree, ['push', '--quiet', '--set-upstream', remote, branch])
    const issueList = issueNumbers.map((issueNumber) => `#${issueNumber}`).join(' ')
    await Promise.all(pending.map(async (issueNumber) => {
      await forge.commentIssue(issueNumber,
        `Worker completed the task.\nBranch: ${branch}\nHead commit: ${head}\nIssues: ${issueList}`)
      await forge.addLabel(issueNumber, LABEL_MERGE_READY)
      await forge.removeLabel(issueNumber, LABEL_IN_PROGRESS)
    }))
  }

  // The newest report-shaped comment from a write-access author wins. One whose author's
  // access could not be determined may be that newest trusted report, so the answer is
  // "undetermined" rather than whatever older report lies beneath it.
  function workerBranchReport(
    comments: ForgeIssueComment[],
  ): { branch: string; head: string; issueNumbers?: number[] } | 'undetermined' | undefined {
    for (const comment of [...comments].reverse()) {
      if (!comment.author.hasWriteAccess && comment.author.permissionLookupFailed !== true) continue
      const branch = /^Branch: (task\/[A-Za-z0-9][A-Za-z0-9._-]*)$/m.exec(comment.body)?.[1]
      const head = /^Head commit: ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/m.exec(comment.body)?.[1]
      if (branch !== undefined && head !== undefined) {
        if (!comment.author.hasWriteAccess) return 'undetermined'
        const issueLine = /^Issues: ((?:#\d+\s*)+)$/m.exec(comment.body)?.[1]
        const issueNumbers = issueLine?.match(/\d+/g)?.map(Number)
        return { branch, head, ...(issueNumbers === undefined ? {} : { issueNumbers }) }
      }
    }
    return undefined
  }

  async function updateAdoptedIssue(
    issue: ForgeIssue,
    taskId: string,
    mergeCommit: string,
    runBranch: string,
  ): Promise<void> {
    const comment = issueMergeComment(taskId, mergeCommit, runBranch)
    const posted = postedMergeMarkers.get(issue.number) === comment
    // A marker posted earlier this run is re-read fresh: a cached listing may predate it.
    let present = trustedCommentPresent(
      posted ? await forge.listIssueComments(issue.number) : await commentsForIssue(issue),
      comment,
    )
    if (present === false && !posted) {
      await commentOnIssueMerge(forge, issue.number, taskId, mergeCommit, runBranch)
      postedMergeMarkers.set(issue.number, comment)
      present = trustedCommentPresent(await forge.listIssueComments(issue.number), comment)
    }
    // Without merge-ready the issue carries no lifecycle label, so nothing would revisit
    // an unconfirmed promotion; keeping it lets a later poll confirm the marker.
    const warningKey = `adopted-issue-${issue.number}`
    // The marker may already stand under an author whose permission could not be read.
    if (present === undefined) {
      warning(warningKey, `updating adopted issue #${issue.number}`,
        `could not update adopted issue #${issue.number}: `
        + 'merge marker author permission could not be read; deferring')
      return
    }
    if (!present) {
      warning(warningKey, `updating adopted issue #${issue.number}`,
        `could not update adopted issue #${issue.number}: `
        + 'merge comment is not visible after publishing it')
      return
    }
    confirmIssuePromotion(paths, issue.number)
    await forge.removeLabel(issue.number, LABEL_MERGE_READY)
    postedMergeMarkers.delete(issue.number)
    warningLog.recovered(warningKey)
  }

  async function adoptRemoteTasks(openFindings?: readonly ForgeIssue[]): Promise<void> {
    let findings = openFindings
    if (findings === undefined) {
      try {
        findings = await forge.listOpenIssues(LABEL_FINDING)
        warningLog.recovered('list-loop-issues')
      } catch (error) {
        if (!(error instanceof ForgeRateLimitError)) {
          warning('list-loop-issues', 'listing loop issues',
            `could not list loop issues: ${errorSummary(error)}`)
        }
        return
      }
    }
    const issues = findings.filter((issue) =>
      issueHasExactlyLifecycleLabel(issue, LABEL_MERGE_READY))
    const processedIssues = new Set<number>()
    // An issue that left merge-ready no longer has a deferral to count.
    for (const number of [...adoptionDeferrals.keys()]) {
      if (!issues.some((issue) => issue.number === number)) adoptionDeferrals.delete(number)
    }
    // The adoption got past the step a transient failure defers, succeeded, or failed for
    // another reason: whatever deferred it before has cleared.
    const clearAdoptionDeferrals = (issueNumber: number): void => {
      adoptionDeferrals.delete(issueNumber)
      warningLog.recovered(`adoption-deferred-${issueNumber}`)
    }

    for (const issue of issues) {
      if (processedIssues.has(issue.number)) continue
      if (existsSync(stopFile)) return
      const mergeLog = join(paths.logsDir, `issue-${issue.number}.merge.log`)
      const adopted = issuePromotionForIssue(paths, issue.number)
      if (adopted !== undefined) {
        try {
          await updateAdoptedIssue(
            issue,
            adopted.taskId,
            adopted.mergeCommit,
            adopted.runBranch,
          )
        } catch (error) {
          if (error instanceof ForgeRateLimitError) return
          event('WARN', `could not update adopted issue #${issue.number}: ${errorSummary(error)}`)
        }
        continue
      }
      let adoptionTaskId: string | undefined
      let adoptionIssues = [issue]
      try {
        const remote = currentBranchPushRemote(paths.repoRoot)
        const adoptionComments = async (candidate: ForgeIssue): Promise<ForgeIssueComment[]> => {
          try {
            return await commentsForIssue(candidate)
          } catch (error) {
            if (error instanceof ForgeRateLimitError) throw error
            appendFileSync(mergeLog, `${errorSummary(error)}\n`)
            throw new TransientAdoptionError('comment listing',
              `could not read the comments on issue #${candidate.number}`)
          }
        }
        const report = workerBranchReport(await adoptionComments(issue))
        if (report === 'undetermined') throw new UndeterminedWorkerReportError(issue.number)
        if (report === undefined) {
          throw new MergeError(`Issue #${issue.number} has no valid worker branch report.`)
        }
        const requestedIssues = [...new Set(report.issueNumbers ?? [issue.number])]
        adoptionIssues = requestedIssues.map((issueNumber) => {
          const candidate = findings.find((finding) => finding.number === issueNumber)
          if (candidate === undefined) {
            throw new MergeError(`Worker branch report for issue #${issue.number} names unavailable issue #${issueNumber}.`)
          }
          return candidate
        })
        // The worker publishes each member of a group in parallel, so a poll can see one
        // member reported while another is still claimed with no report yet. That member is
        // still being published, not contradicting the group: releasing it here would make
        // the worker's next attempt lose its claim and discard pushed work. A claimed member
        // can still carry a report from an earlier task, so the claim decides, not the report.
        let stillPublishing = false
        for (const candidate of adoptionIssues) {
          if (candidate.labels.includes(LABEL_IN_PROGRESS) && !candidate.labels.includes(LABEL_READY)) {
            stillPublishing = true
            break
          }
          const candidateReport = workerBranchReport(await adoptionComments(candidate))
          if (candidateReport === 'undetermined') {
            throw new UndeterminedWorkerReportError(candidate.number)
          }
          if (candidateReport?.branch !== report.branch || candidateReport.head !== report.head) {
            throw new MergeError(`Grouped issue #${candidate.number} does not report the same worker branch.`)
          }
        }
        adoptionIssues.forEach((candidate) => processedIssues.add(candidate.number))
        if (stillPublishing) {
          clearAdoptionDeferrals(issue.number)
          continue
        }
        const taskId = report.branch.slice('task/'.length)
        adoptionTaskId = taskId
        event('Merging', shortTaskId(taskId))
        try {
          execFileSync('git', [
            'fetch', '--quiet', remote,
            `+refs/heads/${report.branch}:refs/remotes/${remote}/${report.branch}`,
          ], {
            cwd: paths.repoRoot,
            // git's reason is matched below, so it must not be translated.
            env: { ...process.env, LC_ALL: 'C' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
        } catch (error) {
          // git's reason stays in the local log: it can quote the remote URL, and the
          // MergeError text is also posted to the issue.
          appendFileSync(mergeLog, `${errorSummary(error)}\n`)
          // Only a branch the remote definitely lacks fails the worker's work; any other
          // fetch failure may clear by the next poll.
          // git has printed this message capitalized in other versions.
          if (!/couldn't find remote ref/i.test(errorSummary(error))) {
            throw new TransientAdoptionError('fetch',
              `could not fetch ${report.branch} from ${remote}`)
          }
          throw new MergeError(`Could not fetch ${report.branch} from ${remote}.`)
        }
        clearAdoptionDeferrals(issue.number)

        // Read before the merge, and checked: a promotion recorded without its run branch
        // is malformed, and every later reconcile would fail on it. A lookup that fails or
        // answers nothing once is asked again; after that the adoption waits for a later
        // poll, and git's reason is never posted to the issue.
        const runBranch = optionalGit(['branch', '--show-current']).trim()
          || optionalGit(['branch', '--show-current']).trim()
        if (runBranch === '') {
          warning('adoption-run-branch', 'reading the run branch',
            'remote adoption deferred: the run branch could not be read')
          continue
        }
        warningLog.recovered('adoption-run-branch')
        let appliedMergeCommit: string | undefined
        let promotionPersistenceError: unknown
        const persistPromotion = (mergedCommit: string): void => {
          appliedMergeCommit = mergedCommit
          try {
            // The flags go first: once the promotion is recorded, a restart treats the
            // adoption as done and would promote the new commits past a stale gate.
            const cycle = readCount(scanCountFile)
            if (cycle > 0) {
              rmSync(join(paths.queueDir, `cycle-complete-${cycle}`), { force: true })
              rmSync(join(paths.queueDir, `cycle-resume-${cycle}`), { force: true })
            }
            writeFileSync(mergeFailureFile, '0\n')
            recordIssuesForTask(
              paths, taskId, adoptionIssues.map((candidate) => candidate.number),
            )
            recordIssuePromotions(paths, taskId, mergedCommit, runBranch)
            // A local attempt for the same issues may have conflicted earlier; the
            // adopted branch carries the work its kept commits were waiting to deliver.
            retireConflictedAttempts(taskId, adoptionIssues.map((candidate) => candidate.number))
          } catch (error) {
            promotionPersistenceError = error
            throw error
          }
        }
        let mergeCommit: string
        try {
          mergeCommit = await mergeRemoteTask(
            paths,
            issue.number,
            remote,
            report.branch,
            report.head,
            {
              taskGate: config.taskGate,
              testCmd: config.testCmd === '' ? undefined : config.testCmd,
              skipAutoTest: config.skipAutoTest,
              project,
              forge: rawForge,
              outputFile: mergeLog,
              orchestrationDepsRuntime,
              onOrchestrationDepsEvent: orchestrationDepsEvent,
              beforeOrchestrationDepsInstall: stopTaskProcessesBeforeDependencyInstall,
              closesIssues: adoptionIssues.map((candidate) => candidate.number),
              closesSourceIssues: paths.fleet === undefined
                ? undefined
                : sourceIssueNumbers(adoptionIssues.flatMap((candidate) =>
                  parseIssueBody(candidate.body, candidate.number)?.fingerprints ?? []),
                paths.fleet.repository),
              // The worker's spec stays on the worker; the issues hold the same requirements.
              reasons: adoptionIssues.flatMap((candidate) => {
                const requirement = parseIssueBody(candidate.body, candidate.number)?.requirement
                return requirement === undefined ? [] : [requirement]
              }),
              onMerged: persistPromotion,
            },
          )
        } catch (error) {
          if (appliedMergeCommit === undefined || error !== promotionPersistenceError) throw error
          try {
            persistPromotion(appliedMergeCommit)
            mergeCommit = appliedMergeCommit
          } catch (retryError) {
            appendFileSync(mergeLog, `${errorSummary(retryError)}\n`)
            event('WARN', `could not persist adopted issue #${issue.number}; retrying next poll`)
            continue
          }
          // mergeRemoteTask synchronizes dependencies only once onMerged returns, so the
          // failed first attempt skipped it and later gates would run on stale packages.
          syncOrchestrationDepsAfterRecordedMerge(
            paths, mergeCommit, taskId, orchestrationDepsEvent, orchestrationDepsRuntime,
            stopTaskProcessesBeforeDependencyInstall,
          )
        }
        try {
          await Promise.all(adoptionIssues.map((candidate) =>
            updateAdoptedIssue(candidate, taskId, mergeCommit, runBranch)))
        } catch (error) {
          if (error instanceof ForgeRateLimitError) return
          event('WARN', `could not update adopted issue #${issue.number}: ${errorSummary(error)}`)
        }
        event('Merged', shortTaskId(taskId), `commit ${mergeCommit.slice(0, 8)}`)
      } catch (error) {
        if (error instanceof ForgeRateLimitError) return
        const message = error instanceof Error ? error.message : String(error)
        appendFileSync(mergeLog, `${message}\n`)
        // Not a failure: the gate's tests never ran because other worktrees held the
        // repository test lock past its wait limit. The issue stays merge-ready, so the
        // next poll adopts the pushed branch again.
        if (error instanceof TestLockBusyError) {
          const subject = adoptionTaskId === undefined
            ? `issue #${issue.number}`
            : shortTaskId(adoptionTaskId)
          event('WARN', `${subject} adoption deferred: the repository test lock stayed busy`)
          continue
        }
        // Not a failure either: a transient permission lookup says nothing about the
        // report, and a forge or network error says nothing about the pushed work, so
        // every member stays merge-ready for the next poll.
        if (error instanceof UndeterminedWorkerReportError) {
          event('WARN', `issue #${issue.number} adoption deferred: ${message}`)
          continue
        }
        // A transient failure that never clears would defer the issue on every poll for
        // ever while the cycle gate waits on it, so a bounded run of them stops the loop.
        // The issue keeps its labels and comments, so a person finds the branch untouched.
        if (error instanceof TransientAdoptionError) {
          const deferrals = (adoptionDeferrals.get(issue.number) ?? 0) + 1
          adoptionDeferrals.set(issue.number, deferrals)
          warning(`adoption-deferred-${issue.number}`, `adopting issue #${issue.number}`,
            `issue #${issue.number} adoption deferred: ${message}`)
          if (deferrals >= MAX_CONSECUTIVE_ADOPTION_DEFERRALS) {
            event('ERROR', `issue #${issue.number} adoption deferred ${deferrals} consecutive times `
              + `(${error.kind} failed); stopping the loop`)
            writeFileSync(stopFile, '')
            return
          }
          continue
        }
        clearAdoptionDeferrals(issue.number)
        if (error instanceof OrchestrationDepsInstallError || error instanceof MergeRecoveryError) {
          throw error
        }
        if (adoptionTaskId === undefined) {
          event('WARN', `remote adoption failed for issue #${issue.number}`)
        } else {
          event('Failed', shortTaskId(adoptionTaskId), `log ${shortLogPath(mergeLog)}`)
        }
        try {
          await Promise.all(adoptionIssues.map((candidate) =>
            forge.commentIssue(candidate.number, `Remote task adoption failed: ${message}`)))
        } catch (commentError) {
          if (!(commentError instanceof ForgeRateLimitError)) {
            event('WARN', `could not comment on issue #${issue.number}: ${errorSummary(commentError)}`)
          }
        }
        try {
          if (adoptionIssues.length > 1) {
            await Promise.all(adoptionIssues.map((candidate) =>
              returnIssueToReady(forge, candidate.number, true)))
          } else {
            await markIssueMergeFailed(forge, issue.number)
          }
        } catch (labelError) {
          if (!(labelError instanceof ForgeRateLimitError)) {
            event('WARN', `could not relabel issue #${issue.number}: ${errorSummary(labelError)}`)
          }
        }
        noteMergeFailure(mergeLog)
      }
    }
  }

  function countRunning(): number {
    return listTaskIds(paths)
      .filter((taskId) => readTaskState(paths, taskId) === 'running').length
  }

  // MAX_PARALLEL caps ordinary task processes and shared-issue claims; scan fan-out is
  // governed by SCAN_PARALLEL alone. Counting scans here let a full scan fleet hold back
  // a ready finding that no task was working on.
  function countRunningTasks(): number {
    return listTaskIds(paths)
      .filter((taskId) => !isScanTaskId(taskId)
        && readTaskState(paths, taskId) === 'running').length
  }

  // A reserved handback is owed the next free slot. Counted only once its runner started,
  // it waited while every slot freed during a poll was refilled from claims and the backlog.
  function countReservedHandbacks(): number {
    if (config.maxGateFixAttempts === 0) return 0
    return listTaskIds(paths).filter((taskId) => readTaskState(paths, taskId) === 'completed'
      && readGateFixState(paths, taskId)?.pending === true).length
  }

  function queueLength(): number {
    if (!existsSync(queueFile)) return 0
    return readFileSync(queueFile, 'utf8').split(/\r?\n/).filter((line) => line !== '').length
  }

  // This is a cumulative session counter, not a snapshot of active local work. A
  // generated task continues to consume the growth budget after it finishes or is
  // published to a remote issue queue. The fallback seeds upgrades from current-session
  // active and scanned state; cleanup writes an explicit zero so old tasks are not recounted.
  function countAllTasks(): number {
    if (existsSync(totalTaskCountFile)) return readCount(totalTaskCountFile)
    const taskIds = new Set(listTaskIds(paths).filter((taskId) => {
      const status = readTaskState(paths, taskId)
      return status === 'running' || status === 'completed'
    }))
    if (existsSync(queueFile)) {
      for (const line of readFileSync(queueFile, 'utf8').split(/\r?\n/)) {
        const taskId = line.split(':', 1)[0]
        if (taskId !== undefined && taskId !== '') taskIds.add(taskId)
      }
    }
    for (const name of readdirSync(scannedDir)) {
      taskIds.add(name.replace(/\.(?:depth|failed)$/, ''))
    }
    writeFileSync(totalTaskCountFile, `${taskIds.size}\n`)
    return taskIds.size
  }

  function recordPublishedTask(): void {
    writeFileSync(totalTaskCountFile, `${countAllTasks() + 1}\n`)
  }

  function hasTaskCapacity(taskId: string): boolean {
    if (countAllTasks() < config.maxTotalTasks) return true
    event('WARN', `task limit ${config.maxTotalTasks} ignored findings from ${shortTaskId(taskId)}`)
    return false
  }

  function dequeueNext(remoteOperationsAvailable: boolean): QueueEntry | undefined {
    const first = dequeueBacklog(queueFile, (line) => {
      if (remoteOperationsAvailable) return true
      const taskId = line.split(':', 1)[0]
      return taskId !== undefined && issueNumberForTask(paths, taskId) === undefined
    })
    if (first === undefined) return undefined
    const sep = first.indexOf(':')
    const depthRaw = sep === -1 ? '' : first.slice(sep + 1)
    return {
      taskId: sep === -1 ? first : first.slice(0, sep),
      depth: /^\d+$/.test(depthRaw) ? Number(depthRaw) : 0,
    }
  }

  // Logs may quote either a Markdown template, which carries literal angle brackets, or
  // rendered HTML documentation, where the same brackets remain entity-encoded. Neither
  // form is work the loop can perform.
  function hasFormatPlaceholder(text: string): boolean {
    const decoded = text.replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    return ['<description>', '<text>', '<and how>', '<and what it costs>']
      .some((placeholder) => decoded.includes(placeholder))
  }

  function reportsNothing(text: string): boolean {
    const trimmed = text.trim()
    const normalized = trimmed.replace(/[.!]+$/, '').toLowerCase()
    if (['none', 'n/a', 'nothing', 'no findings', 'no finding', 'nothing to report', 'nothing found']
      .includes(normalized)) return true
    const firstSentence = (trimmed.split(/(?<=[.!?])\s/, 1)[0] ?? '')
      .replace(/[.!]+$/, '').toLowerCase()
    return /^none\b/.test(firstSentence)
      || /^(?:no (?:actionable )?(?:issues|findings)(?: (?:were )?found)?|(?:sections? [\w, -]+|the review|review|i|we) found no (?:actionable )?(?:issues|findings)|nothing to report)$/
        .test(firstSentence)
  }

  /**
   * The concrete NEXT_TASK findings in a final response. Enqueueing, review gating and
   * scan-yield accounting all consume this filter, so a line ignored by one cannot hold
   * either gate open.
   */
  function actionableFindings(finalFile: string): string[] {
    if (!existsSync(finalFile)) return []
    const lines = readFileSync(finalFile, 'utf8').split(/\r?\n/)
    if (lines.some((line) => line === 'NO_FINDINGS')
      && lines.some((line) => line.startsWith('NEXT_TASK:'))) {
      event('WARN', 'final message has NO_FINDINGS and NEXT_TASK; keeping findings')
    }
    return lines
      .filter((line) => line.startsWith('NEXT_TASK:'))
      .map((line) => line.replace(/^NEXT_TASK:\s*/, '').trim())
      .filter((desc) => {
        if (desc === '' || hasFormatPlaceholder(desc) || reportsNothing(desc)) return false
        if (!/[a-z0-9]/.test(descSlug(desc))) {
          event('WARN', `ignored finding with an empty slug: ${desc}`)
          return false
        }
        return true
      })
  }

  function appendSharedRequirements(
    newId: string,
    parentId: string,
    desc: string,
    includeDescription = true,
    pitfallKey = desc,
  ): void {
    const parts = [`\n## Auto-generated task (parent: ${parentId})\n`]
    if (includeDescription) parts.push(`\n${desc}\n`)
    parts.push(`\n${readTemplate(paths, 'task-requirements.md')}`)
    const pitfalls = pitfallsFileForDesc(paths, pitfallKey)
    if (existsSync(pitfalls)) parts.push(`\n${readFileSync(pitfalls, 'utf8')}`)
    appendFileSync(specFile(paths, newId), parts.join(''))
  }

  function appendClaimedRequirements(
    taskId: string,
    requirements: ClaimedRequirement[],
  ): void {
    if (requirements.length === 1) {
      const requirement = requirements[0]!
      appendSharedRequirements(
        taskId,
        `issue-${requirement.issueNumber}`,
        frameVerifiedRequirement(requirement.requirement),
        true,
        requirement.requirement,
      )
      return
    }
    const issueList = requirements.map(({ issueNumber }) => `#${issueNumber}`).join(', ')
    const parts = [`\n## Auto-generated task (findings: ${issueList})\n`]
    for (const [index, requirement] of requirements.entries()) {
      parts.push(
        `\n### Requirement ${index + 1} (issue #${requirement.issueNumber})\n\n`,
        frameVerifiedRequirement(requirement.requirement),
        `\n\nAfter addressing this requirement, include this exact standalone line in the final response:\n\nREQUIREMENT_COMPLETE: #${requirement.issueNumber}\n`,
      )
    }
    parts.push(`\n${readTemplate(paths, 'task-requirements.md')}`)
    const pitfallFiles = new Set(requirements.map(({ requirement }) =>
      pitfallsFileForDesc(paths, requirement)))
    for (const file of pitfallFiles) {
      if (existsSync(file)) parts.push(`\n${readFileSync(file, 'utf8')}`)
    }
    appendFileSync(specFile(paths, taskId), parts.join(''))
  }

  /**
   * An issue whose earlier task conflicted while rebasing hands that attempt to the task
   * claimed for it now, so the retry starts from the kept commits. The issue record stays
   * until the new task merges, which keeps the hand-over safe if this claim is rolled back.
   */
  function attachIssueConflictedAttempts(taskId: string, issueNumbers: number[]): void {
    const attempts = new Map<string, ConflictedAttempt>()
    for (const issueNumber of issueNumbers) {
      for (const attempt of readConflictedAttempts(paths, issueConflictKey(issueNumber))) {
        attempts.set(attempt.taskId, attempt)
      }
    }
    if (attempts.size === 0) return
    const chain = [...attempts.values()]
    appendFileSync(specFile(paths, taskId), conflictRetrySection(chain))
    writeConflictedAttempts(paths, taskId, chain)
  }

  function appendClaimedRequirementsWithConflicts(
    taskId: string,
    requirements: ClaimedRequirement[],
  ): void {
    appendClaimedRequirements(taskId, requirements)
    attachIssueConflictedAttempts(taskId, requirements.map(({ issueNumber }) => issueNumber))
  }

  /**
   * Keep a conflicted task's commits on their own branch before cleanup deletes the task
   * branch. Attempts this task was itself retrying travel with it, so the merge that
   * finally lands removes every branch kept along the way.
   */
  function keepConflictedAttempt(taskId: string, error: RebaseConflictError): {
    branch: string
    attempts: ConflictedAttempt[] | undefined
  } {
    const branch = conflictBranchName(taskId)
    git(['branch', '--force', branch, error.conflict?.taskTip ?? branchName(taskId)])
    if (error.conflict === undefined) return { branch, attempts: undefined }
    return {
      branch,
      attempts: [...readConflictedAttempts(paths, taskId), { ...error.conflict, taskId, branch }],
    }
  }

  /**
   * Queue a local task again after its rebase conflicted, carrying its whole specification
   * behind a section that names the kept commits and what they collided with. Returns
   * undefined once the chain has used its retries.
   */
  function requeueConflictedTask(
    taskId: string,
    attempts: ConflictedAttempt[],
    specification: string,
    effort: string | undefined,
    depth: number,
  ): string | undefined {
    if (conflictRetriesExhausted(attempts)) return undefined
    const retryId = newTaskId(paths, taskId.replace(/^\d{8}_\d{6}_\d{3}_/, ''))
    writeFileSync(specFile(paths, retryId), [
      `# ${retryId}: retry of ${taskId} after a rebase conflict\n`,
      conflictRetrySection(attempts),
      '\n## Specification of the earlier attempt\n\n',
      specification.replace(/^# [^\n]*\n/, ''),
    ].join(''))
    if (effort !== undefined) {
      mkdirSync(join(paths.queueDir, 'effort'), { recursive: true })
      writeFileSync(join(paths.queueDir, 'effort', retryId), effort)
    }
    writeConflictedAttempts(paths, retryId, attempts)
    enqueueTaskImpl(paths, retryId, depth)
    return retryId
  }

  function retireConflictedAttempts(taskId: string, linkedIssues: number[]): void {
    const failures = retireKeptConflictedAttempts(paths, taskId, linkedIssues)
    if (failures.length > 0) {
      event('WARN', `could not remove commits kept for ${shortTaskId(taskId)}: ${failures.join('; ')}`)
    }
  }

  /**
   * Turn a finished task's NEXT_TASK lines into queued tasks, bounded by depth and
   * total. In issue mode the findings become forge issues instead — the shared
   * backlog other workers can claim — under the same growth bounds.
   */
  async function scanForNextTasks(taskId: string, depth: number): Promise<FindingDispatch> {
    const findings = actionableFindings(finalMessageFile(paths, taskId))
    const destinations: string[] = []
    if (findings.length === 0) return { findings, destinations, reconciled: true }
    const isReview = isReviewTaskId(taskId)
    const findingOrigin = isReview ? 'fix' : 'auto'

    const newDepth = depth + 1
    if (newDepth > config.maxGrowthDepth) {
      event('WARN', `growth depth limit ${config.maxGrowthDepth} ignored findings from ${shortTaskId(taskId)}`)
      return { findings, destinations, reconciled: true }
    }
    // A documentation fix written while the cycle's code is still changing describes code
    // that is about to move, and parallel ones conflict on the same files. Hold them for
    // one combined task once the cycle's other work has merged. A review's findings keep
    // their own combined task, and a worker has no cycle gate to release them at.
    const holdsDocumentation = !isReview && !config.workerMode
    if (holdsDocumentation && findings.some(isDocumentationFinding)) {
      const held = await holdDocumentationFindings(
        taskId, findings.filter(isDocumentationFinding), newDepth,
      )
      if (!held.reconciled) return { findings, destinations, ...held }
    }
    const dispatchedFindings = holdsDocumentation
      ? findings.filter((finding) => !isDocumentationFinding(finding))
      : findings
    if (dispatchedFindings.length === 0) return { findings, destinations, reconciled: true }
    if (config.issueQueueEnabled) {
      let pendingFindings = dispatchedFindings
      if (isReview) {
        let filtered: Awaited<ReturnType<typeof unresolvedFindings>>
        try {
          filtered = await unresolvedFindings(forge, paths, findings)
          warningLog.recovered(`unresolved-findings-${taskId}`)
        } catch (error) {
          if (!(error instanceof ForgeRateLimitError)) {
            warning(
              `unresolved-findings-${taskId}`,
              `checking review findings from ${shortTaskId(taskId)}`,
              `could not check review findings from ${shortTaskId(taskId)}: ${errorSummary(error)}`,
            )
          }
          const failure = error instanceof ForgeRateLimitError
            ? undefined
            : `could not check review findings from ${shortTaskId(taskId)}: ${errorSummary(error)}`
          return { findings, destinations, reconciled: false, failure }
        }
        pendingFindings = filtered.unresolved
        for (const duplicate of filtered.duplicates) {
          destinations.push(`#${duplicate.issueNumber}`)
        }
      }
      if (pendingFindings.length === 0) return { findings, destinations, reconciled: true }
      const combinesReviewFindings = isReview && pendingFindings.length > 1
      const descriptions = combinesReviewFindings
        ? [pendingFindings.map((finding, index) => `${index + 1}. ${finding}`).join('\n')]
        : pendingFindings
      let reconciled = true
      let publishFailure: string | undefined
      for (const desc of descriptions) {
        if (!hasTaskCapacity(taskId)) continue
        const effort = isReview ? 'high' : undefined
        const title = combinesReviewFindings ? `Review round fixes (${taskId})` : undefined
        try {
          const result = await publishFinding(
            forge, paths, desc, taskId, effort, title,
            combinesReviewFindings ? pendingFindings : undefined,
            newDepth,
          )
          destinations.push(`#${result.issueNumber}`)
          if (result.outcome === 'created') {
            recordPublishedTask()
            event('Filed', `#${result.issueNumber}`, `by ${shortTaskId(taskId)}`)
          }
        } catch (error) {
          reconciled = false
          if (!(error instanceof ForgeRateLimitError)) {
            publishFailure ??= `could not file finding from ${shortTaskId(taskId)}: ${errorSummary(error)}`
          }
        }
      }
      // One report per scan attempt, so an outage that rejects several findings counts
      // once; a rejection that survives the retry stops the loop instead of holding the
      // completion scan open forever. A worker counts it against its publication limit.
      if (publishFailure !== undefined && !config.workerMode) {
        reportGateFailure(publishFailure, `completion-scan-${taskId}`)
      }
      return { findings, destinations, reconciled, failure: publishFailure }
    }

    const pendingFindings = isReview
      ? [...new Set(dispatchedFindings)].filter((finding) => {
        const existing = outstandingFindingTask(finding, findingOrigin)
        if (existing === undefined) return true
        destinations.push(shortTaskId(existing))
        return false
      })
      : dispatchedFindings
    if (pendingFindings.length === 0) return { findings, destinations, reconciled: true }
    const combinesReviewFindings = isReview && pendingFindings.length > 1
    const descriptions = combinesReviewFindings
      ? [pendingFindings.map((finding, index) => `${index + 1}. ${finding}`).join('\n')]
      : pendingFindings
    let reconciled = true
    let enqueueFailure: string | undefined
    for (const desc of descriptions) {
      if (!hasTaskCapacity(taskId)) continue
      const queued = queueFindingTask(
        desc, taskId, newDepth, findingOrigin,
        combinesReviewFindings ? pendingFindings : undefined,
      )
      destinations.push(shortTaskId(queued.taskId))
      if (queued.failure !== undefined) {
        reconciled = false
        enqueueFailure ??= queued.failure
      }
    }
    // One report per scan attempt, as on the issue path: a queue that rejects several
    // findings counts once, so the stop file waits for the failure to survive a retry.
    if (enqueueFailure !== undefined) {
      reportGateFailure(enqueueFailure, `completion-scan-${taskId}`)
    }
    return { findings, destinations, reconciled }
  }

  function existingFindingTask(description: string, origin: 'auto' | 'fix'): string | undefined {
    return existingTaskIdForDesc(paths, origin, description)
      ?? existingTaskIdForDesc(paths, origin === 'fix' ? 'auto' : 'fix', description)
  }

  /** The task already carrying a finding, when a new one for it would only be dropped. */
  function outstandingFindingTask(finding: string, origin: 'auto' | 'fix'): string | undefined {
    const existing = existingFindingTask(finding, origin)
    if (existing === undefined) return undefined
    // A failed task is never retried automatically: it keeps its worktree until
    // the operator's cleanup, and startTask refuses that worktree, so re-queueing
    // it would only be dropped at startup. Cleanup removes the status, after which
    // the same finding re-admits the task; suppressing on the bare existence of
    // the spec blocked that retry path.
    const status = readTaskState(paths, existing)
    const queued = existsSync(queueFile)
      && readFileSync(queueFile, 'utf8').split(/\r?\n/)
        .some((line) => line.startsWith(`${existing}:`))
    const mergedAdvisory = (status === 'merged' || status === 'no-change')
      && fingerprintOf(finding).startsWith('advisory:')
    return queued || status === 'running' || status === 'completed' || status === 'failed'
      || mergedAdvisory
      ? existing
      : undefined
  }

  /**
   * Queue one finding description as a local task. Combined findings arrive as the
   * numbered list in `desc`, and each is recorded against the one task carrying them.
   * An enqueue failure is returned rather than reported, so a caller queueing several
   * findings in one attempt reports it once.
   */
  function queueFindingTask(
    desc: string,
    parentId: string,
    depth: number,
    origin: 'auto' | 'fix',
    combinedFindings: readonly string[] | undefined,
    pitfallKey = desc,
  ): { taskId: string; failure?: string } {
    const existing = existingFindingTask(desc, origin)
    const needsFreshTask = existing !== undefined
      && ['merged', 'no-change'].includes(readTaskState(paths, existing) ?? '')
      && !fingerprintOf(desc).startsWith('advisory:')
    const newId = needsFreshTask
      ? newTaskId(paths, `${origin}-${descSlug(desc)}`)
      : existing ?? taskIdForDesc(paths, origin, desc)
    if (needsFreshTask) recordTaskIdForDesc(paths, origin, desc, newId)
    if (!existsSync(specFile(paths, newId))) {
      // The template carries the Commit and TASK_COMPLETE instructions — a spec
      // without them produces work whose completion is indistinguishable from a
      // crash, recorded failed with the commits sitting in the worktree.
      newTaskSpec(paths, newId)
      if (combinedFindings !== undefined) {
        const file = specFile(paths, newId)
        const spec = readFileSync(file, 'utf8').replace(
          '## Requirement\n-\n',
          `## Requirement\n\n${desc}\n`,
        )
        writeFileSync(file, spec)
        appendSharedRequirements(newId, parentId, desc, false, pitfallKey)
      } else {
        appendSharedRequirements(newId, parentId, desc, true, pitfallKey)
      }
    }
    if (combinedFindings !== undefined) {
      for (const finding of combinedFindings) {
        recordTaskIdForDesc(paths, origin, finding, newId)
      }
    }
    // A fix born from a review is repairing something subtle enough to have escaped
    // the implementer once, so review-spawned tasks run at high effort.
    const effortFile = join(paths.queueDir, 'effort', newId)
    if (origin === 'fix' && !existsSync(effortFile)) {
      mkdirSync(join(paths.queueDir, 'effort'), { recursive: true })
      writeFileSync(effortFile, 'high\n')
    }
    try {
      const enqueue = enqueueTaskImpl(paths, newId, depth)
      if (enqueue.outcome === 'enqueued') recordPublishedTask()
    } catch (error) {
      return {
        taskId: newId,
        failure: `could not enqueue finding from ${shortTaskId(parentId)}: ${errorSummary(error)}`,
      }
    }
    return { taskId: newId }
  }

  /**
   * Hold a finished task's documentation findings until the cycle's other work has
   * merged. A finding already held, already carried by a task, or already open as an
   * issue is skipped exactly as the dispatch paths would skip it.
   */
  async function holdDocumentationFindings(
    taskId: string,
    documentation: readonly string[],
    depth: number,
  ): Promise<{ reconciled: boolean; failure?: string }> {
    const heldFingerprints = new Set(readHeldFindings(paths).map(({ finding }) => fingerprintOf(finding)))
    let candidates = documentation.filter((finding) => {
      const fingerprint = fingerprintOf(finding)
      if (heldFingerprints.has(fingerprint)) return false
      heldFingerprints.add(fingerprint)
      return true
    })
    if (candidates.length === 0) return { reconciled: true }
    if (config.issueQueueEnabled) {
      try {
        candidates = (await unresolvedFindings(forge, paths, candidates)).unresolved
        warningLog.recovered(`unresolved-findings-${taskId}`)
      } catch (error) {
        if (error instanceof ForgeRateLimitError) return { reconciled: false }
        const failure = `could not check documentation findings from ${shortTaskId(taskId)}: ${errorSummary(error)}`
        warning(
          `unresolved-findings-${taskId}`,
          `checking documentation findings from ${shortTaskId(taskId)}`,
          failure,
        )
        return { reconciled: false, failure }
      }
    } else {
      candidates = candidates.filter((finding) => outstandingFindingTask(finding, 'auto') === undefined)
    }
    if (candidates.length === 0) return { reconciled: true }
    writeHeldFindings(paths, [
      ...readHeldFindings(paths),
      ...candidates.map((finding) => ({ depth, parentTaskId: taskId, finding })),
    ])
    event(
      'Deferred',
      shortTaskId(taskId),
      `${candidates.length} documentation finding(s) until the cycle's other tasks finish`,
    )
    return { reconciled: true }
  }

  /**
   * Release the held documentation findings as one task through the ordinary path for a
   * finding of their greatest depth. Returns true while the gate must wait: the combined
   * task now exists, or filing it failed and a later poll retries. The holding file is
   * truncated only once the task or issue exists, or when the growth bounds drop it.
   *
   * Filing can fail after the issue already exists, which keeps the holding file. A held
   * finding an open trusted issue covers (or, locally, an outstanding task carries) is
   * therefore dropped first, so a retry never files the same findings a second time,
   * while a finding observed again after an earlier fix merged is still filed.
   */
  async function releaseHeldDocumentation(
    openFindings: readonly ForgeIssue[] | undefined,
  ): Promise<boolean> {
    let held = readHeldFindings(paths)
    if (held.length === 0) return false
    const heldParents = new Set(held.map(({ parentTaskId }) => parentTaskId))
    const survivors = held.filter(({ finding }) => config.issueQueueEnabled
      ? !openFindingCoversHeld(paths, openFindings ?? [], fingerprintOf(finding), heldParents)
      : outstandingFindingTask(finding, 'auto') === undefined)
    if (survivors.length < held.length) {
      event(
        'Deduplicated',
        'docs',
        `${held.length - survivors.length} held documentation finding(s) already carried by an open ${config.issueQueueEnabled ? 'issue' : 'task'}`,
      )
      if (survivors.length === 0) {
        clearHeldFindings(paths)
        previousGateFailures.delete('release-documentation')
        return false
      }
      writeHeldFindings(paths, survivors)
      held = survivors
    }
    const first = held[0]
    if (first === undefined) return false
    const findings = held.map(({ finding }) => finding)
    const depth = Math.max(...held.map((record) => record.depth))
    const parentId = first.parentTaskId
    const combined = findings.length > 1
    const desc = combined
      ? findings.map((finding, index) => `${index + 1}. ${finding}`).join('\n')
      : first.finding
    if (depth > config.maxGrowthDepth) {
      event('WARN', `growth depth limit ${config.maxGrowthDepth} ignored findings from ${shortTaskId(parentId)}`)
      writeHeldFindings(paths, [])
      return false
    }
    if (!hasTaskCapacity(parentId)) {
      writeHeldFindings(paths, [])
      return false
    }
    if (config.issueQueueEnabled) {
      try {
        const result = await publishFinding(
          forge, paths, desc, parentId, undefined,
          combined ? `Documentation fixes (cycle ${readCount(scanCountFile)})` : undefined,
          combined ? findings : undefined,
          depth,
        )
        if (result.outcome === 'created') {
          recordPublishedTask()
          event('Filed', `#${result.issueNumber}`, `by ${shortTaskId(parentId)}`)
        }
      } catch (error) {
        if (!(error instanceof ForgeRateLimitError)) {
          reportGateFailure(
            `could not file held documentation findings: ${errorSummary(error)}`,
            'release-documentation',
          )
        }
        gateWaitTarget = 'documentation release'
        return true
      }
    } else {
      const { failure } = queueFindingTask(
        desc, parentId, depth, 'auto', combined ? findings : undefined, first.finding,
      )
      if (failure !== undefined) {
        reportGateFailure(failure, `completion-scan-${parentId}`)
        gateWaitTarget = 'documentation release'
        return true
      }
    }
    previousGateFailures.delete('release-documentation')
    writeHeldFindings(paths, [])
    event('Released', 'docs', `${held.length} documentation finding(s) as one task`)
    return true
  }

  // A scan writes its findings in prose, so the same advisory comes back worded
  // differently every cycle. Only the GHSA/CVE identifiers survive the rewording,
  // which is what makes them worth matching on.
  function decisionIdentifiers(text: string): string[] {
    const matches = text.toUpperCase().match(/GHSA(-[0-9A-Z]{4}){3}|CVE-\d{4}-\d{4,}/g)
    return [...new Set(matches ?? [])]
  }

  function decisionAlreadyRecorded(text: string): boolean {
    if (!existsSync(decisionsFile)) return false
    const recordedText = readFileSync(decisionsFile, 'utf8')
    const identifiers = decisionIdentifiers(text)
    if (identifiers.length === 0) {
      return recordedText.split(/\r?\n/).includes(text)
    }
    const recorded = new Set(decisionIdentifiers(recordedText))
    return identifiers.some((id) => recorded.has(id))
  }

  /**
   * DECISION_REQUIRED findings are reported, never queued: a major version upgrade is a
   * migration whose breaking changes are the user's call, and an agent that performs it
   * silently has made that call for them.
   */
  function collectDecisions(taskId: string): void {
    const finalFile = finalMessageFile(paths, taskId)
    if (!existsSync(finalFile)) return
    for (const line of readFileSync(finalFile, 'utf8').split(/\r?\n/)) {
      if (!line.startsWith('DECISION_REQUIRED:')) continue
      const text = line.replace(/^DECISION_REQUIRED:\s*/, '').trim()
      if (text === '') continue
      if (hasFormatPlaceholder(text)) {
        continue
      }
      if (decisionAlreadyRecorded(text)) continue
      appendFileSync(decisionsFile, `${text}\n`)
      event('Decision', shortTaskId(taskId), text)
    }
  }

  /** What the merge log says about the environment, or '' when it blames nothing there. */
  function infrastructureDiagnosis(mergeLog: string): string {
    if (!existsSync(mergeLog)) return ''
    const text = readFileSync(mergeLog, 'utf8')
    const infrastructureFailure = project.classifyInfrastructureFailure?.(text)
    if (infrastructureFailure !== undefined) return infrastructureFailure.diagnosis
    if (/Could not resolve host|Connection refused/.test(text)) {
      return 'the network or a package registry is unreachable'
    }
    return ''
  }

  /**
   * Count a merge failure and stop once failures stop looking like one task's work. A
   * failure that reaches this count is either the environment — the gate could not run —
   * or a task whose own content failed verification and has used its handbacks
   * (handBackFailedGate): retrying the same commits cannot change either. Any successful
   * merge resets the count, so one genuine test failure does not accumulate alongside
   * unrelated ones.
   */
  function noteMergeFailure(mergeLog: string): boolean {
    const failures = readCount(mergeFailureFile) + 1
    writeFileSync(mergeFailureFile, `${failures}\n`)

    const diagnosis = infrastructureDiagnosis(mergeLog)
    if (diagnosis !== '') event('WARN', diagnosis)

    if (failures >= config.maxConsecutiveMergeFailures) {
      event('ERROR', `${failures} consecutive merge failures; stopping the loop`)
      writeFileSync(stopFile, '')
      return true
    }
    return false
  }

  /**
   * A completed task's merge failed: decide whether its runner gets the failure back.
   * Retrying unchanged commits cannot pass a gate that fails on the task's own content —
   * two tasks once needed an operator to repair them by hand in their worktrees, one for a
   * new file under a coverage threshold and one for an expected value a parallel merge had
   * changed. The first verification failure is still retried unchanged, since load can
   * fail a suite once; a second in a row is handed back while attempts remain. Anything
   * that is not a verification command failing on the task's content — a refusal, an
   * infrastructure diagnosis, a pending stop — is counted as before. Returns true when the
   * failure was handed back rather than counted.
   */
  async function handBackFailedGate(
    taskId: string,
    error: unknown,
    mergeLog: string,
  ): Promise<boolean> {
    // Only an implementation task is handed back: a scan or review commits nothing a
    // follow-up asking it to correct its change was written for.
    if (config.maxGateFixAttempts === 0 || isInspectionTaskId(paths, taskId)) return false
    const state = readGateFixState(paths, taskId)
    const contentFailure = error instanceof VerificationFailedError
      && !existsSync(stopFile) && infrastructureDiagnosis(mergeLog) === ''
    if (!contentFailure) {
      if (state?.verificationFailed === true) {
        writeGateFixState(paths, taskId, { ...state, verificationFailed: false })
      }
      return false
    }
    if (state === undefined || !state.verificationFailed) {
      writeGateFixState(paths, taskId, {
        attempts: state?.attempts ?? 0, verificationFailed: true, pending: false,
      })
      return false
    }
    if (state.attempts >= config.maxGateFixAttempts) return false
    // Reserved before the runner starts, so a restart in between resumes this attempt
    // instead of losing it or granting another. Both happen under the task's merge guard:
    // a manual merge holding it is merging this worktree, and this poll leaves it alone.
    await withMergeGuard(paths, taskId, async () => {
      writeGateFixState(paths, taskId, {
        attempts: state.attempts + 1, verificationFailed: false, pending: true,
      })
      await startHandbackWithGuardHeld(taskId)
    })
    return true
  }

  /**
   * Start a reserved handback's runner once a parallel slot is free and no merge of the
   * task holds its merge guard. While it waits, the task stays completed and each poll
   * comes back here instead of running the gate again.
   */
  async function startHandback(taskId: string): Promise<void> {
    await withMergeGuard(paths, taskId, () => startHandbackWithGuardHeld(taskId))
  }

  async function startHandbackWithGuardHeld(taskId: string): Promise<void> {
    const state = readGateFixState(paths, taskId)
    if (state?.pending !== true) return
    // A merge that finished before the guard was taken leaves nothing to hand back.
    if (readTaskState(paths, taskId) !== 'completed') return
    if (existsSync(stopFile) || countRunningTasks() >= config.maxParallel) return
    const mergeLog = join(paths.logsDir, `${taskId}.merge.log`)
    const followUpSpec = gateFixSpecFile(paths, taskId)
    writeFileSync(followUpSpec, gateFixSpecification({
      taskId,
      branch: branchName(taskId),
      runBranch: optionalGit(['branch', '--show-current']).trim(),
      attempt: state.attempts,
      maxAttempts: config.maxGateFixAttempts,
      specification: readFileSync(specFile(paths, taskId), 'utf8'),
      mergeLogTail: existsSync(mergeLog) ? mergeLogTail(readFileSync(mergeLog)) : '',
      issueNumbers: issueNumbersForTask(paths, taskId),
    }))
    const effortFile = join(paths.queueDir, 'effort', taskId)
    const effort = existsSync(effortFile)
      ? readFileSync(effortFile, 'utf8').replace(/[\s\r\n]/g, '')
      : config.taskEffort
    // The completed run's final message is kept, and the handback marked active before the
    // runner starts, so a fix run that ends without completing, even across a restart,
    // returns the task to completed as it was.
    const finalMessage = finalMessageFile(paths, taskId)
    if (existsSync(finalMessage)) copyFileSync(finalMessage, gateFixFinalMessageFile(paths, taskId))
    markGateFixRunActive(paths, taskId, true)
    try {
      await resumeTaskImpl(paths, runner, taskId, followUpSpec, {
        effort: effort as 'medium',
        model: config.taskModel === '' ? undefined : config.taskModel,
      })
    } catch (error) {
      if (error instanceof StartupOwnershipUnknownError
        || error instanceof StartupProcessRetainedError) {
        event('ERROR', shortTaskId(taskId),
          `handback runner could not be accounted for; task retained and loop stopped: ${errorSummary(error)}`)
        writeFileSync(stopFile, '')
        return
      }
      // The attempt is spent, and the failure it was meant to fix is counted after all.
      writeGateFixState(paths, taskId, { ...state, pending: false })
      markGateFixRunActive(paths, taskId, false)
      event('WARN', `${shortTaskId(taskId)} handback could not start: ${errorSummary(error)}`)
      noteMergeFailure(mergeLog)
      return
    }
    writeGateFixState(paths, taskId, { ...state, pending: false })
    event('Handback', shortTaskId(taskId),
      `attempt ${state.attempts}/${config.maxGateFixAttempts}  verification failed twice; runner restarted`)
  }

  /**
   * Settle a handed-back runner that has left running. One that completed is merged as
   * any completed task is. One that failed, hit the task deadline, was stopped, or died
   * with the daemon leaves the task as the handback found it: completed with its commits
   * and earlier final message, the attempt spent, and its issue still claimed, so its next
   * merge failure is counted as before rather than the task being reported failed.
   * Changes the fix run left uncommitted stay in the worktree, as for any stopped run.
   */
  async function settleHandback(taskId: string, status: TaskState): Promise<TaskState> {
    if (config.maxGateFixAttempts === 0 || (status !== 'completed' && status !== 'failed')) {
      return status
    }
    if (!gateFixRunActive(paths, taskId)) return status
    const state = readGateFixState(paths, taskId)
    if (state === undefined) return status
    if (status === 'completed') {
      // A reservation not yet started is still waiting for its slot.
      if (!state.pending) markGateFixRunActive(paths, taskId, false)
      return status
    }
    const savedFinalMessage = gateFixFinalMessageFile(paths, taskId)
    if (existsSync(savedFinalMessage)) {
      copyFileSync(savedFinalMessage, finalMessageFile(paths, taskId))
    }
    if (!await transitionStatus(paths, taskId, 'failed', 'completed')) {
      return readTaskState(paths, taskId) ?? status
    }
    writeGateFixState(paths, taskId, { ...state, verificationFailed: false, pending: false })
    markGateFixRunActive(paths, taskId, false)
    appendFileSync(logFile(paths, taskId),
      '\nMerge gate handback ended without completing; task returned to completed.\n')
    event('Handback', shortTaskId(taskId),
      `attempt ${state.attempts}/${config.maxGateFixAttempts}  fix run ended without completing; task returned to completed`)
    return 'completed'
  }

  function noteIssueReleaseFailure(error: IssueReleaseReconciliationError): void {
    const failures = readCount(issueReleaseFailureFile) + 1
    writeFileSync(issueReleaseFailureFile, `${failures}\n`)
    const issues = error.failures.map(({ issueNumber }) => `#${issueNumber}`).join(' ')
    const detail = error.failures
      .map(({ issueNumber, error: cause }) => `#${issueNumber}: ${errorSummary(cause)}`)
      .join('; ')
    if (failures >= MAX_CONSECUTIVE_ISSUE_RELEASE_FAILURES) {
      event('ERROR', `${failures} consecutive issue release failures for ${issues}; stopping the loop (${detail})`)
      writeFileSync(stopFile, '')
      return
    }
    warning(
      'issue-release-reconciliation',
      'reconciling persisted issue releases',
      `could not reconcile persisted issue releases (${detail}); attempt ${failures}/${MAX_CONSECUTIVE_ISSUE_RELEASE_FAILURES}`,
    )
  }

  function isScanRunning(): boolean {
    return listTaskIds(paths).some((taskId) =>
      isScanTaskId(taskId) && readTaskState(paths, taskId) === 'running')
  }

  /**
   * Record a finished scan's yield for its cycle. The empty-scan verdict needs every
   * scan's answer, so completions only record here and the gate folds the records in
   * once the cycle is over.
   */
  function recordScanYield(taskId: string): void {
    if (!isScanTaskId(taskId)) return
    const cycleNow = readCount(scanCountFile)
    const yieldFile = join(paths.queueDir, `scan-yield-${cycleNow}`)
    const value = actionableFindings(finalMessageFile(paths, taskId)).length > 0
      ? 'found'
      : 'empty'
    appendFileSync(yieldFile, `${taskId}\t${value}\n`)
  }

  /**
   * The failed scans of a cycle. Their ids come from the cycle's failure record, which
   * the status sweep appends to and operator-stop recovery prunes, so a scan the
   * operator interrupted is never read back here as one that failed.
   */
  function failedScanIds(cycle: number): string[] {
    const failedFile = join(paths.queueDir, `failed-${cycle}`)
    if (!existsSync(failedFile)) return []
    return [...new Set(readFileSync(failedFile, 'utf8').split(/\r?\n/)
      .filter((taskId) => taskId !== '' && isScanTaskId(taskId)))]
  }

  function completeScanYields(cycle: number): string[] | undefined {
    const expectedFile = join(paths.queueDir, `scan-expected-${cycle}`)
    const yieldFile = join(paths.queueDir, `scan-yield-${cycle}`)
    if (!existsSync(expectedFile)) return undefined
    const expected = readCount(expectedFile)
    const keyedYields = new Map<string, string>()
    const legacyYields: string[] = []
    if (existsSync(yieldFile)) {
      for (const line of readFileSync(yieldFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
        if (line === 'found' || line === 'empty') {
          legacyYields.push(line)
          continue
        }
        const match = /^(\S+)\t(found|empty)$/.exec(line)
        if (match === null) return undefined
        keyedYields.set(match[1]!, match[2]!)
      }
    }
    // A failed scan never wrote a yield and never will, so waiting for one holds a
    // cycle whose every other task is done. Count it as delivered but silent: it lets
    // the cycle close without saying anything about the sections it was given.
    const failed = failedScanIds(cycle).filter((taskId) => !keyedYields.has(taskId))
    const yields = [...legacyYields, ...keyedYields.values(), ...failed.map(() => 'failed')]
    if (expected === 0 || yields.length !== expected) {
      return undefined
    }
    return yields
  }

  /**
   * Fold the finished cycle's scan records into the empty-scan counter: reset on any
   * finding, increment exactly once when every expected scan came back empty, and leave
   * it untouched when a scan did not finish or failed. A failed scan is no evidence
   * that its sections are clean, so it closes the cycle without making it an empty one.
   */
  function foldScanYields(cycle: number): void {
    const yields = completeScanYields(cycle)
    if (yields === undefined) return
    const expectedFile = join(paths.queueDir, `scan-expected-${cycle}`)
    const yieldFile = join(paths.queueDir, `scan-yield-${cycle}`)
    if (yields.includes('found')) {
      writeFileSync(emptyScanFile, '0\n')
    } else if (!yields.includes('failed')) {
      const total = readCount(emptyScanFile) + 1
      writeFileSync(emptyScanFile, `${total}\n`)
    }
    rmSync(yieldFile, { force: true })
    rmSync(expectedFile, { force: true })
  }

  function renderTemplate(templateName: string, replacements: Record<string, string>): string {
    let text = readTemplate(paths, templateName)
    for (const [key, value] of Object.entries(replacements)) {
      text = text.replaceAll(`{{${key}}}`, value)
    }
    return text
  }

  function acceptedLimitsSection(): string {
    const acceptedLimitsFile = join(paths.projectRoot, 'accepted-limits.md')
    const acceptedLimits = existsSync(acceptedLimitsFile)
      ? readFileSync(acceptedLimitsFile, 'utf8').trim() || '(none)'
      : '(none)'
    return frameUntrustedText(acceptedLimits)
  }

  function scanSpecification(
    scanId: string,
    scope: string,
    acceptedLimits: string = acceptedLimitsSection(),
  ): string {
    const hasPlaceholder = readTemplate(paths, 'scan-template.md').includes('{{ACCEPTED_LIMITS}}')
    let specification = renderTemplate('scan-template.md', {
      SCAN_ID: scanId,
      SCAN_SCOPE: scope,
      ACCEPTED_LIMITS: acceptedLimits,
    })
    // A consumer's own scan template may predate the placeholder. The appended heading
    // is unnumbered, so it never changes the sections that SCAN_PARALLEL splits.
    if (!hasPlaceholder) specification = appendAcceptedLimits(specification, acceptedLimits)
    return repositoryInspectionPreamble() + specification
  }

  function appendAcceptedLimits(specification: string, acceptedLimits: string): string {
    return `${specification.trimEnd()}\n\n## Accepted limits\n\n`
      + 'These are accepted limits by decision. Do not report them or propose narrower variants\n'
      + 'of them as findings. A finding qualitatively beyond an entry is still reportable.\n\n'
      + `${acceptedLimits}\n`
  }

  function numberedScanSections(specification: string): number[] {
    const sections: number[] = []
    let fence: { marker: '`' | '~'; length: number } | undefined
    for (const line of specification.split(/\r?\n/)) {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (fence !== undefined) {
        if (fenceMatch !== null
          && fenceMatch[1]![0] === fence.marker
          && fenceMatch[1]!.length >= fence.length
          && fenceMatch[2]!.trim() === '') {
          fence = undefined
        }
        continue
      }
      if (fenceMatch !== null) {
        fence = {
          marker: fenceMatch[1]![0] as '`' | '~',
          length: fenceMatch[1]!.length,
        }
        continue
      }
      const heading = /^ {0,3}#{1,6}[\t ]+(\d+)\.(?:[\t ]|$)/.exec(line)
      if (heading !== null) sections.push(Number(heading[1]))
    }
    if (new Set(sections).size !== sections.length) {
      throw new Error('numbered sections must be unique')
    }
    return sections
  }

  function partitionScanSections(sections: readonly number[], groupCount: number): number[][] {
    const groups = Array.from({ length: groupCount }, () => [] as number[])
    sections.forEach((section, index) => groups[index % groupCount]!.push(section))
    return groups
  }

  function generateReviewTask(reviewId: string, cycle: number, prUrl: string): boolean {
    let remote: string
    try {
      remote = currentBranchTrackingRemote(paths.repoRoot)
    } catch (error) {
      event('WARN', `could not resolve review base: ${errorSummary(error)}`)
      return false
    }

    const remotePrefix = `${remote}/`
    let baseBranch = optionalGit([
      'symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`,
    ]).trim()
    if (!baseBranch.startsWith(remotePrefix)
      || optionalGit(['rev-parse', '--verify', `${baseBranch}^{commit}`]).trim() === '') {
      const advertised = optionalGit(['ls-remote', '--symref', remote, 'HEAD'])
      const branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(advertised)?.[1] ?? ''
      baseBranch = branch === '' ? '' : `${remote}/${branch}`
    }
    if (baseBranch.startsWith(remotePrefix)) {
      const branch = baseBranch.slice(remotePrefix.length)
      try {
        gitIn(paths.repoRoot, ['fetch', '--quiet', remote,
          `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`])
      } catch (error) {
        event('WARN', `could not refresh review base ${baseBranch}: ${errorSummary(error)}`)
        return false
      }
    }
    if (!baseBranch.startsWith(remotePrefix)
      || optionalGit(['rev-parse', '--verify', `${baseBranch}^{commit}`]).trim() === '') {
      event('WARN', `could not resolve a valid default branch for ${remote}`)
      return false
    }
    const acceptedLimits = acceptedLimitsSection()
    const hasPlaceholder = readTemplate(paths, 'review-template.md').includes('{{ACCEPTED_LIMITS}}')
    let review = renderTemplate('review-template.md', {
      REVIEW_ID: reviewId,
      CYCLE: String(cycle),
      PR_URL: prUrl === '' ? '(PR URL unknown)' : prUrl,
      BASE_BRANCH: baseBranch,
      ACCEPTED_LIMITS: acceptedLimits,
      ...reviewScopeTemplateValues(
        paths.repoRoot,
        config.integrationBranch === '' || paths.fleet !== undefined
          ? PACKAGE_ROOT
          : join(paths.repoRoot, relative(dirname(paths.root), PACKAGE_ROOT)),
      ),
    })
    // A consumer's own review template may predate the placeholder.
    if (!hasPlaceholder) review = appendAcceptedLimits(review, acceptedLimits)
    writeFileSync(specFile(paths, reviewId), repositoryInspectionPreamble() + review)
    return true
  }

  /**
   * The final cycle is the scan-limit cycle, one whose scans all came back empty when
   * one more empty cycle reaches MAX_EMPTY_SCANS, or any cycle while scanning is
   * disabled, whose drained gate no scan can follow — the run ends after it in every
   * case, so it is the last chance for a review to read the branch.
   */
  function cycleIsFinal(cycle: number): boolean {
    if (!config.scanEnabled) return true
    if (cycle >= config.maxScanCycles) return true
    const yields = completeScanYields(cycle)
    if (yields !== undefined && !yields.includes('found') && !yields.includes('failed')) {
      return readCount(emptyScanFile) + 1 >= config.maxEmptyScans
    }
    return false
  }

  /**
   * The automatic review half of the cycle gate. Returns true when the cycle has passed
   * review and may resume; false when a review is in flight, its findings were queued,
   * or the final review refused to converge and the loop is stopping.
   */
  function runAutoReview(cycle: number, isFinal: boolean): boolean {
    const roundFile = join(paths.queueDir, `review-round-${cycle}`)
    const idFile = join(paths.queueDir, `review-id-${cycle}`)
    const pendingIdFile = join(paths.queueDir, `review-pending-id-${cycle}`)

    if (!isFinal && cycle % config.reviewEveryNCycles !== 0) {
      return true
    }

    const maxRounds = isFinal ? config.maxFinalReviewRounds : config.maxReviewRounds
    const rounds = readCount(roundFile)
    const lastId = existsSync(idFile) ? readFileSync(idFile, 'utf8').replace(/[\s\r\n]/g, '') : ''
    let missingVerdict = false

    if (lastId !== '') {
      const status = readTaskState(paths, lastId)
      if (status !== 'completed' && status !== 'merged' && status !== 'no-change') {
        event('WARN', `review ${shortTaskId(lastId)} ended ${status ?? 'unknown'} without a verdict`)
        missingVerdict = true
        // A crashed review says nothing about the diff, regardless of whether this is
        // the final cycle. Fall through to retry within the applicable round bound.
      } else if (actionableFindings(finalMessageFile(paths, lastId)).length === 0) {
        return true
      }
    }

    if (rounds >= maxRounds) {
      if (isFinal || missingVerdict) {
        // Promoting here would ship findings nobody resolved or trust a review that
        // never produced a verdict. Rounds this persistent signal something
        // structural, which is a person's call, so the loop stops instead of promoting.
        // Ending at the cap is the run's normal handoff to a person, not a malfunction,
        // so it closes the log as a first-class event rather than a bare ERROR.
        event('Stopped', 'Loop', `review-cap rounds ${rounds}/${maxRounds}`)
        writeFileSync(stopFile, '')
        return false
      }
      event('WARN', `review still has findings after ${rounds} rounds; resuming`)
      return true
    }

    const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
    const pendingId = existsSync(pendingIdFile)
      ? readFileSync(pendingIdFile, 'utf8').replace(/[\s\r\n]/g, '')
      : ''
    const reviewId = pendingId || newTaskId(paths, `review-c${cycle}`, now())
    if (pendingId === '') writeFileSync(pendingIdFile, `${reviewId}\n`)
    if (!generateReviewTask(reviewId, cycle, prUrl)) {
      event('Stopped', 'Loop', 'review base unavailable')
      writeFileSync(stopFile, '')
      return false
    }
    const effortDir = join(paths.queueDir, 'effort')
    mkdirSync(effortDir, { recursive: true })
    writeFileSync(join(effortDir, reviewId), `${config.reviewEffort}\n`)
    try {
      enqueueTaskImpl(paths, reviewId, 0)
    } catch (error) {
      // The pending ID makes the next poll retry the same review, but a queue that never
      // accepts it would leave the loop idling at the gate with nothing dispatched, so a
      // repeated failure stops the loop as the CI-fix enqueue does.
      reportGateFailure(
        `could not enqueue review: ${errorSummary(error)}`,
        'review-enqueue',
      )
      return false
    }
    previousGateFailures.delete('review-enqueue')
    // The round and id are the durable receipt for a dispatched review. Publishing
    // them before the backlog mutation succeeds consumes a round without any worker
    // being able to perform it, so keep them behind the enqueue boundary.
    writeFileSync(roundFile, `${rounds + 1}\n`)
    writeFileSync(idFile, `${reviewId}\n`)
    rmSync(pendingIdFile, { force: true })
    return false
  }

  function cleanupSessionState(preserveTaskMarkers = false): void {
    for (const name of readdirSync(paths.queueDir)) {
      if (/^(cycle-complete-|cycle-suite-tip-|cycle-resume-|ci-fix-emitted-|ci-fix-pending-id-|review-round-|review-id-|review-pending-id-|failed-|scan-yield-|scan-expected-)/.test(name)
        || name === 'decisions.txt' || name === 'pr-url.txt'
        || name === 'empty-scan-count.txt' || name === 'merge-failure-count.txt'
        || name === heldFindingsFileName) {
        rmSync(join(paths.queueDir, name), { force: true })
      }
    }
    if (!preserveTaskMarkers) {
      // Every failure the run observed has been announced by now; its status outlives
      // the flag removed below, so the next run is told which failures are not its own.
      const failedTaskIds = listTaskIds(paths).filter((taskId) => {
        try {
          return readTaskState(paths, taskId) === 'failed'
        } catch {
          return false
        }
      })
      writeFileSync(announcedFailuresFile, failedTaskIds.map((taskId) => `${taskId}\n`).join(''))
      rmSync(scannedDir, { recursive: true, force: true })
      mkdirSync(scannedDir, { recursive: true })
    }
    writeFileSync(scanCountFile, '0\n')
    writeFileSync(totalTaskCountFile, '0\n')
    if (!preserveTaskMarkers && config.integrationBranch !== '') {
      for (const name of ['daemon-branch.txt', 'daemon-head.txt', 'integration-branch.txt']) {
        rmSync(join(paths.queueDir, name), { force: true })
      }
    }
  }

  /**
   * An operator stop is not evidence that a scan failed. Discard every scan that was
   * live when stop was requested and rewind the incomplete cycle so its full scan set
   * is dispatched again. The marker stays in place until cleanup is complete, making a
   * partial recovery safe to retry after another daemon start.
   */
  function recoverInterruptedScans(): boolean {
    const marker = join(paths.queueDir, interruptedScansFileName)
    if (!existsSync(marker)) return true

    try {
      const entries = readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
        const match = /^([1-9][0-9]*)\t([^\t]+)$/.exec(line)
        const cycle = match === null ? Number.NaN : Number(match[1])
        const taskId = match?.[2] ?? ''
        if (!Number.isSafeInteger(cycle) || !isScanTaskId(taskId)) {
          throw new Error(`invalid stopped-scan recovery entry: ${line}`)
        }
        return { cycle, taskId }
      })
      if (entries.length === 0) {
        rmSync(marker, { force: true })
        return true
      }

      const cycles = new Set(entries.map((entry) => entry.cycle))
      const currentCycle = readCount(scanCountFile)
      // The counter is rewound only after every other recovery step, so a marker one
      // cycle ahead of it means a previous start finished recovery but could not remove
      // the marker. A new run branch also resets the counter, so a stop during a live
      // first-cycle scan lands here with its scans untouched; cleanup is idempotent, so
      // the named scans are discarded before the marker goes, or the new run would count
      // them as its own failures.
      if (cycles.size === 1 && cycles.has(currentCycle + 1)) {
        for (const taskId of new Set(entries.map((entry) => entry.taskId))) {
          cleanupTask(paths, taskId, undefined, false, log)
        }
        rmSync(marker, { force: true })
        event('Recovered', 'scan cycle', `${currentCycle + 1} after operator stop`)
        return true
      }
      if (cycles.size !== 1 || !cycles.has(currentCycle)) {
        event('ERROR', `stopped-scan recovery does not match current cycle ${currentCycle}; stopping the loop`)
        writeFileSync(stopFile, '')
        return false
      }

      const taskIds = [...new Set(entries.map((entry) => entry.taskId))]
      for (const taskId of taskIds) cleanupTask(paths, taskId, undefined, false, log)

      const failedFile = join(paths.queueDir, `failed-${currentCycle}`)
      if (existsSync(failedFile)) {
        const interrupted = new Set(taskIds)
        const retained = readFileSync(failedFile, 'utf8').split(/\r?\n/)
          .filter((taskId) => taskId !== '' && !interrupted.has(taskId))
        if (retained.length === 0) rmSync(failedFile, { force: true })
        else writeFileSync(failedFile, `${retained.join('\n')}\n`)
      }

      for (const name of [
        `scan-expected-${currentCycle}`,
        `scan-yield-${currentCycle}`,
        `cycle-complete-${currentCycle}`,
        `cycle-suite-tip-${currentCycle}`,
        `cycle-resume-${currentCycle}`,
        `ci-fix-emitted-${currentCycle}`,
        `ci-fix-pending-id-${currentCycle}`,
        `review-round-${currentCycle}`,
        `review-id-${currentCycle}`,
        `review-pending-id-${currentCycle}`,
      ]) rmSync(join(paths.queueDir, name), { force: true })
      writeFileSync(scanCountFile, `${currentCycle - 1}\n`)
      rmSync(marker, { force: true })
      event('Recovered', 'scan cycle', `${currentCycle} after operator stop`)
      return true
    } catch (error) {
      event('ERROR', `could not recover scans interrupted by stop: ${errorSummary(error)}`)
      writeFileSync(stopFile, '')
      return false
    }
  }

  /**
   * A stopped loop deliberately keeps its cycle state so it can resume after an
   * environment repair. That state belongs only to the branch which created it;
   * carrying it onto another branch could skip scans or resume a completed gate.
   */
  function initializeSessionStateForBranch(): void {
    const currentBranch = git(['branch', '--show-current']).trim()
    if (currentBranch === '') {
      // A detached HEAD names no branch: comparing '' with the record would wipe the
      // recorded run's state, and recording '' would let every poll's guard pass.
      event('ERROR', 'current branch cannot be read (detached HEAD); run state kept')
      throw new Error('current branch cannot be read: HEAD is detached')
    }
    const previousBranch = existsSync(runBranchFile)
      ? readFileSync(runBranchFile, 'utf8').replace(/[\r\n]/g, '')
      : undefined
    if (previousBranch === currentBranch) {
      writeFileSync(runBranchFile, `${currentBranch}\n`)
      return
    }
    if (previousBranch !== undefined) {
      // Status files span branches, so their announcement markers must span branches
      // too; explicit task cleanup removes a marker when a retry is wanted.
      cleanupSessionState(true)
    }
    writeFileSync(mergeFailureFile, '0\n')
    writeFileSync(runBranchFile, `${currentBranch}\n`)
  }

  /** Fail startup before work begins when this run can never publish its branch. */
  function validatePushTarget(): boolean {
    if (!config.autoPr && !config.workerMode) return true
    try {
      currentBranchPushRemote(paths.repoRoot)
      return true
    } catch (error) {
      event('ERROR', `current branch cannot be pushed: ${errorSummary(error)}`)
      writeFileSync(stopFile, '')
      return false
    }
  }

  function readDecisions(): string[] {
    if (!existsSync(decisionsFile)) return []
    return readFileSync(decisionsFile, 'utf8').split(/\r?\n/).filter((line) => line !== '')
  }

  /** Push the branch and create or update the draft PR. Returns false when it must retry. */
  async function ensureDraftPr(mode: 'cycle' | 'final'): Promise<boolean> {
    emptyRun = false
    const branch = optionalGit(['branch', '--show-current']).trim()
    if (branch === '') {
      reportGateFailure('could not get branch name; PR skipped')
      return false
    }
    let pushRemote: string
    let baseRemote: string
    try {
      pushRemote = currentBranchPushRemote(paths.repoRoot)
      baseRemote = currentBranchTrackingRemote(paths.repoRoot)
      const hasUpstream = optionalGit([
        'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
      ]).trim() !== ''
      execFileSync('git', [
        'push', '--quiet', ...(hasUpstream ? [] : ['--set-upstream']), pushRemote, branch,
      ], {
        cwd: paths.repoRoot,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      reportGateFailure(`could not push branch: ${errorSummary(error)}`)
      return false
    }

    const baseRef = optionalGit([
      'symbolic-ref', '--quiet', '--short', `refs/remotes/${baseRemote}/HEAD`,
    ]).trim()
    if (!baseRef.startsWith(`${baseRemote}/`)) {
      reportGateFailure(`could not get ${baseRemote} default branch; PR skipped`)
      return false
    }
    const baseBranch = baseRef.slice(baseRemote.length + 1)
    try {
      gitIn(paths.repoRoot, ['fetch', baseRemote, baseBranch, '--quiet'])
    } catch (error) {
      reportGateFailure(`could not fetch ${baseRef}: ${errorSummary(error)}`)
      return false
    }
    const cycle = readCount(scanCountFile)
    const title = prTitle(project, paths.repoRoot, baseRef, mode === 'final' ? 'final' : 'cycle',
      { cycle, maxCycles: config.maxScanCycles })

    let status
    try {
      status = await forge.prStatus({ kind: 'branch', value: branch })
    } catch (error) {
      if (!(error instanceof ForgeRateLimitError)) {
        reportGateFailure(`could not check PR status: ${errorSummary(error)}`)
      }
      return false
    }
    if (status.state === 'open') {
      // A body left as created stops at the first cycle's content, so it is rebuilt
      // every cycle — unless a person edited it, which removes the generated marker.
      let body: string
      try {
        body = await forge.prBody(branch)
      } catch (error) {
        if (!(error instanceof ForgeRateLimitError)) {
          reportGateFailure(`could not read PR body: ${errorSummary(error)}`)
        }
        return false
      }
      const generatedBody = body.split(/\r?\n/, 1)[0] === GENERATED_BODY_MARKER
      try {
        await forge.updatePr(branch, generatedBody
          ? {
              title,
              body: buildPrBody(project, paths.repoRoot, baseRef, readDecisions()),
            }
          : { title })
      } catch (error) {
        if (!(error instanceof ForgeRateLimitError)) {
          reportGateFailure(`could not update PR ${generatedBody ? 'body' : 'title'}: ${errorSummary(error)}`)
        }
        return false
      }
      writeFileSync(prUrlFile, `${status.url}\n`)
      previousGateFailures.delete('draft-pr')
      return true
    }

    // The PR can be completed or closed by a person between the final gate and
    // promotion. Let postLoopPr interpret that terminal state instead of trying to
    // create another PR for the same branch on every poll. A merged PR that lacks
    // commits landed after its merge is not that state: those commits need a PR of
    // their own, exactly as a cycle opens one.
    if (mode === 'final' && status.state === 'merged') {
      let complete: boolean
      try {
        complete = mergedPrHoldsLocalHead(status.headSha)
      } catch (error) {
        reportGateFailure(`could not compare merged PR head with HEAD: ${errorSummary(error)}`)
        return false
      }
      if (complete) {
        if (status.url !== '') writeFileSync(prUrlFile, `${status.url}\n`)
        previousGateFailures.delete('draft-pr')
        return true
      }
    }
    if (mode === 'final' && status.state === 'closed') {
      if (status.url !== '') writeFileSync(prUrlFile, `${status.url}\n`)
      previousGateFailures.delete('draft-pr')
      return true
    }
    // A person closed the run PR mid-run. Its branch still holds every merge of the run,
    // and those issues stay promoted to it, so a second PR would only bypass that person.
    // Stop for them on repetition, as the final gate does.
    if (status.state === 'closed') {
      reportGateFailure('could not update PR because it is closed')
      return false
    }

    try {
      const ahead = gitIn(paths.repoRoot, ['rev-list', '--count', `${baseRef}..HEAD`]).trim()
      if (ahead === '0') {
        // A forge cannot create a PR without a commit between head and base. This is a
        // completed empty run, not a transient forge failure to retry forever.
        emptyRun = true
        rmSync(prUrlFile, { force: true })
        previousGateFailures.delete('draft-pr')
        return true
      }
    } catch (error) {
      reportGateFailure(`could not compare branch with ${baseRef}: ${errorSummary(error)}`)
      return false
    }

    try {
      const url = await forge.createPr({
        branch,
        base: baseBranch,
        title,
        body: buildPrBody(project, paths.repoRoot, baseRef, readDecisions()),
        draft: true,
      })
      writeFileSync(prUrlFile, `${url}\n`)
      previousGateFailures.delete('draft-pr')
      // Commits that missed the merged PR have passed neither CI nor review on any PR,
      // so the cycle gate runs again for the new PR before postLoopPr may promote it.
      if (mode === 'final' && status.state === 'merged' && cycle > 0) {
        rmSync(join(paths.queueDir, `cycle-resume-${cycle}`), { force: true })
        rmSync(join(paths.queueDir, `cycle-complete-${cycle}`), { force: true })
        finalGateReopened = true
      }
      return true
    } catch (error) {
      if (!(error instanceof ForgeRateLimitError)) {
        reportGateFailure(`could not create PR: ${errorSummary(error)}`)
      }
      return false
    }
  }

  /** The CI verdict for the cycle gate: success / failure / pending / unknown. */
  async function checkPrCiStatus(): Promise<'success' | 'failure' | 'pending' | 'unknown'> {
    const previous = previousCiPoll
    previousCiPoll = undefined
    const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
    if (prUrl === '') return 'unknown'
    let status
    try {
      status = await forge.prStatus({ kind: 'url', value: prUrl })
    } catch (error) {
      if (!(error instanceof ForgeRateLimitError)) {
        reportGateFailure(
          `could not check PR CI status: ${errorSummary(error)}`,
          'ci-status',
        )
      }
      return 'unknown'
    }
    previousGateFailures.delete('ci-status')
    if (status.state === 'none') return 'unknown'
    if (status.state === 'merged') return 'success'
    // Right after a push the forge can still report the previous head and its checks.
    // Only a verdict about the commit this checkout holds may open or fail the gate.
    // A closed PR receives no further pushes, so its head can never catch up.
    if (status.state === 'open' && !prHeadIsLocalHead(status.headSha)) return 'pending'
    const checks = newestChecksByName(status.checks)
    if (checks.length === 0) {
      // Silence cannot prove success: workflows may be delayed or misconfigured. Only a
      // project that explicitly declares it expects no CI checks may clear this gate.
      return project.ciChecksExpected === false ? 'success' : 'unknown'
    }
    // A job that waits on another, or an external status, can appear only after the
    // checks already listed have finished, so a verdict needs the same check names on
    // two polls in a row for the same head. The forge lists them in no fixed order, so
    // the polls are compared as sorted copies, keeping each duplicated name's count.
    const names = checks.map((check) => check.name).sort()
    previousCiPoll = { url: prUrl, headSha: status.headSha, names }
    const stable = previous !== undefined
      && previous.url === prUrl
      && previous.headSha === status.headSha
      && previous.names.length === names.length
      && previous.names.every((name, index) => name === names[index])
    if (checks.some((check) => check.conclusion === 'pending')) return 'pending'
    if (!stable) return 'pending'
    if (checks.some((check) => check.conclusion === 'failure')) return 'failure'
    return 'success'
  }

  function prHeadIsLocalHead(headSha: string): boolean {
    const localHead = optionalGit(['rev-parse', 'HEAD']).trim()
    return headSha !== '' && headSha === localHead
  }

  // Someone can merge the draft PR while later tasks still land on the run branch. The
  // run is finished only when the merged head contains every commit the branch holds;
  // throws when containment cannot be determined.
  function mergedPrHoldsLocalHead(headSha: string): boolean {
    const localHead = optionalGit(['rev-parse', 'HEAD']).trim()
    if (headSha === '' || localHead === '') return false
    return promotedCommitContained(localHead, headSha)
  }

  function generateCiFixTask(cycle: number, prUrl: string, failSummary: string): string {
    const pendingIdFile = join(paths.queueDir, `ci-fix-pending-id-${cycle}`)
    const pendingId = existsSync(pendingIdFile)
      ? readFileSync(pendingIdFile, 'utf8').replace(/[\s\r\n]/g, '')
      : ''
    const fixId = pendingId || newTaskId(paths, `ci-fix-c${cycle}`, now())
    if (pendingId === '') writeFileSync(pendingIdFile, `${fixId}\n`)
    const text = repositoryInspectionPreamble() + renderTemplate('ci-fix-template.md', {
      FIX_ID: fixId,
      CYCLE: String(cycle),
      PR_URL: prUrl === '' ? '(PR URL unknown)' : prUrl,
      FAIL_SUMMARY: frameUntrustedText(
        failSummary === '' ? '(check the PR checks for details)' : failSummary,
      ),
    })
    writeFileSync(specFile(paths, fixId), text)
    enqueueTaskImpl(paths, fixId, 0)
    return pendingIdFile
  }

  /** After the final gate: promote the draft PR and print LOOP_DONE. */
  async function postLoopPr(): Promise<boolean> {
    finalGateReopened = false
    if (!(await ensureDraftPr('final'))) return false
    if (finalGateReopened) {
      finalGateReopened = false
      const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
      event('WARN', `PR merged without the newest commits; gating them again in ${prUrl}`)
      return false
    }
    if (emptyRun) {
      marker('LOOP_DONE: no changes')
      event('Completed', 'Loop', 'no changes')
      return true
    }
    const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
    if (prUrl === '') return false
    const branch = optionalGit(['branch', '--show-current']).trim()
    let status
    try {
      status = await forge.prStatus({ kind: 'branch', value: branch })
      previousGateFailures.delete('pr-status-before-promotion')
    } catch (error) {
      if (!(error instanceof ForgeRateLimitError)) {
        reportGateFailure(
          `could not check PR status before promotion: ${errorSummary(error)}`,
          'pr-status-before-promotion',
        )
      }
      return false
    }
    // The CI gate judged the pushed commit; promoting while the forge still reports an
    // earlier head would publish a branch whose newest commit nobody has checked.
    if (status.state === 'open' && !prHeadIsLocalHead(status.headSha)) return false
    if (status.state === 'merged') {
      previousGateFailures.delete('pr-promotion-state')
    } else if (status.state === 'closed') {
      reportGateFailure(
        'could not promote PR because it is closed',
        'pr-promotion-state',
      )
      return false
    }
    if (status.state === 'open' && status.isDraft) {
      try {
        await forge.markPrReady(branch)
        previousGateFailures.delete('pr-promotion')
      } catch (error) {
        if (!(error instanceof ForgeRateLimitError)) {
          reportGateFailure(
            `could not promote PR: ${errorSummary(error)}`,
            'pr-promotion',
          )
        }
        return false
      }
      try {
        status = await forge.prStatus({ kind: 'branch', value: branch })
        previousGateFailures.delete('pr-status-after-promotion')
      } catch (error) {
        if (!(error instanceof ForgeRateLimitError)) {
          reportGateFailure(
            `could not confirm PR status after promotion: ${errorSummary(error)}`,
            'pr-status-after-promotion',
          )
        }
        return false
      }
    }
    if (status.state === 'closed') {
      reportGateFailure(
        'could not promote PR because it is closed',
        'pr-promotion-state',
      )
      return false
    }
    if (status.state === 'open' && status.isDraft) {
      reportGateFailure(
        'could not confirm PR promotion; PR is still draft',
        'pr-promotion-state',
      )
      return false
    }
    if (status.state !== 'open' && status.state !== 'merged') return false
    if (status.state === 'merged') {
      // A merge observed after ensureDraftPr may predate the newest commits; the next
      // poll's ensureDraftPr then opens a PR for them.
      try {
        if (!mergedPrHoldsLocalHead(status.headSha)) return false
      } catch (error) {
        reportGateFailure(
          `could not compare merged PR head with HEAD: ${errorSummary(error)}`,
          'pr-promotion-state',
        )
        return false
      }
    }
    previousGateFailures.delete('pr-promotion-state')
    const gateEnvironment = os.verificationEnvironmentLabel()
    event(
      'Status', 'Environments',
      `run verification exercised ${gateEnvironment}; promoted branch was not run in any other environment`,
    )
    for (const check of project.manualEnvironmentChecks ?? []) {
      event(
        'Status', `${check.environment} check`,
        `not run for this branch; run ${check.command}`,
      )
    }
    // The body reflects branch history, so it also lists intermediate changes that were
    // later reverted — the need to rewrite it must be impossible to overlook.
    marker(`LOOP_DONE: ${prUrl}`)
    event(
      'Status', 'PR body',
      'still reflects history and must be rewritten as a final summary.',
    )
    event('Completed', 'Loop', `PR ${prUrl}`)
    previousGateFailures.delete('pr-status-before-promotion')
    previousGateFailures.delete('pr-promotion')
    previousGateFailures.delete('pr-status-after-promotion')
    previousGateFailures.delete('pr-promotion-state')
    return true
  }

  function cycleSuiteStepsForTaskGate(): SuiteStep[] {
    return project.cycleSuite().filter((step) =>
      config.taskGate === 'light' || step.runAtEveryTaskGate === true)
  }

  function cycleSuiteEnabledForTaskGate(): boolean {
    return config.taskGate === 'light'
      || cycleSuiteStepsForTaskGate().length > 0
  }

  /** Run the applicable suites once per gate entry against the cycle's resulting tip. */
  function runCycleSuite(cycle: number): boolean {
    const configuredSteps = cycleSuiteStepsForTaskGate()
    if (config.taskGate !== 'light' && configuredSteps.length === 0) return true
    event('Started', 'Suite', `cycle ${cycle}`)
    const suiteLog = join(paths.logsDir, `cycle-suite-${cycle}.log`)
    writeFileSync(suiteLog, '')

    /** Run one command into the suite log; answers 0, its exit status, or null if killed. */
    const runStep = (cwd: string, command: string, timeout?: number): number | null => {
      try {
        const out = execShellSync(command, {
          cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true, timeout,
        })
        appendFileSync(suiteLog, out)
        return 0
      } catch (error) {
        const failed = error as { status?: unknown; stdout?: string; stderr?: string }
        appendFileSync(suiteLog, `${failed.stdout ?? ''}${failed.stderr ?? ''}`)
        return typeof failed.status === 'number' && failed.status !== 0 ? failed.status : null
      }
    }

    const steps = configuredSteps.filter((step) =>
      step.requires === undefined || existsSync(join(paths.repoRoot, step.requires)))
    if (steps.some((step) => step.needsDocker)) {
      const probe = project.cycleSuiteDockerProbe
      if (probe === undefined) {
        event('ERROR', 'cycle suite infrastructure probe is not configured')
        writeFileSync(stopFile, '')
        return false
      }
      if (runStep(paths.repoRoot, probe.command, probe.timeoutMs) !== 0) {
        event('ERROR', probe.remediation)
        writeFileSync(stopFile, '')
        return false
      }
    }

    let ok = true
    for (const step of steps) {
      // A toolchain that broke in a way reinstalling fixes is the environment, not the
      // branch; the repair keeps the suite's verdict about the code.
      const repair = step.repairWhenMissing
      if (repair !== undefined && !existsSync(join(paths.repoRoot, repair.path))) {
        if (runStep(join(paths.repoRoot, step.cwd), repair.command) !== 0) {
          event('ERROR', repair.message)
          writeFileSync(stopFile, '')
          return false
        }
      }
      const status = runStep(join(paths.repoRoot, step.cwd), step.command)
      // The suite never ran: other worktrees held the repository test lock past its wait
      // limit. Nothing is known about the tip, so the gate waits and a later poll runs the
      // suite again, rather than stopping the loop and blaming the branch for a long queue.
      if (status === TEST_LOCK_BUSY_EXIT_CODE) {
        event('WARN', `cycle suite deferred: the repository test lock stayed busy (log: ${shortLogPath(suiteLog)})`)
        gateWaitTarget = 'test lock'
        return false
      }
      ok = status === 0
      if (!ok) break
    }

    if (!ok) {
      const logText = existsSync(suiteLog) ? readFileSync(suiteLog, 'utf8') : ''
      const infrastructureFailure = project.classifyInfrastructureFailure?.(logText)
      if (infrastructureFailure !== undefined) {
        event('ERROR', `${infrastructureFailure.remediation} (log: ${shortLogPath(suiteLog)})`)
      } else if (/is not recognized|command not found|ENOENT/i.test(logText)) {
        event('ERROR', `cycle suite tool missing (log: ${shortLogPath(suiteLog)})`)
      } else {
        event('ERROR', `cycle suite failed (log: ${shortLogPath(suiteLog)})`)
      }
      writeFileSync(stopFile, '')
      return false
    }
    return true
  }

  /** The inter-cycle gate and idle scan dispatch. */
  async function triggerScanIfIdle(
    knownOpenFindings?: readonly ForgeIssue[] | null,
  ): Promise<'continue' | 'done' | 'restart'> {
    gateWaitTarget = undefined
    if (countRunning() > 0 || queueLength() > 0) return 'continue'
    if (isScanRunning()) return 'continue'
    if (listTaskIds(paths).some((taskId) => readTaskState(paths, taskId) === 'completed'
      && !existsSync(join(scannedDir, taskId)))) {
      gateWaitTarget = 'completion scan'
      return 'continue'
    }
    let gateOpenFindings: readonly ForgeIssue[] | undefined
    if (config.issueQueueEnabled) {
      if (knownOpenFindings === null) {
        gateWaitTarget = 'finding status'
        return 'continue'
      }
      try {
        const openFindings = knownOpenFindings ?? await forge.listOpenIssues(LABEL_FINDING)
        gateOpenFindings = openFindings
        const openIssues = openFindings.filter((issue) =>
          !issue.labels.includes(LABEL_UNTRUSTED_AUTHOR)
            && issue.labels.some((label) => [
              LABEL_READY, LABEL_IN_PROGRESS, LABEL_MERGE_READY, LABEL_MERGE_FAILED,
            ].includes(label)))
        const pendingIssueNumbers: number[] = []
        const inspectedIssueNumbers = new Set<number>()
        for (const issue of openIssues) {
          if (issuePromotionForIssue(paths, issue.number) !== undefined) continue
          try {
            const comments = await commentsForIssue(issue)
            if (!comments.some((comment) => comment.author.permissionLookupFailed === true)) {
              inspectedIssueNumbers.add(issue.number)
            }
            const mergeSha = standingMergeMarkers(comments)
              .map((comment) => /^MERGED: [^\r\n]+\r?\nMerged as ([0-9a-f]{40,64}) into run branch /i.exec(comment.body)?.[1])
              .find((sha) => sha !== undefined
                && optionalGit(['merge-base', '--is-ancestor', sha, 'HEAD'], 'ancestor') === 'ancestor')
            if (mergeSha !== undefined) continue
          } catch (error) {
            if (error instanceof ForgeRateLimitError) return 'continue'
            event('WARN', `could not inspect issue #${issue.number}: ${errorSummary(error)}`)
          }
          pendingIssueNumbers.push(issue.number)
        }
        pendingIssueNumbers.sort((a, b) => a - b)
        const remoteCount = pendingIssueNumbers.length
        warningLog.recovered('count-remote-issue-work')
        // A merge-failed issue with no active lifecycle label waits for a person: nothing
        // in the loop adopts, reaps, or retries it. When such issues are all that remains,
        // waiting would hold the gate forever, so stop with the repair instead of promoting.
        // A merge-ready label left beside merge-failed is a failure relabel that did not
        // finish; adoption skips an issue with two lifecycle labels, so it waits the same.
        // An issue whose comments could not be judged may already be merged elsewhere, so
        // it keeps the loop waiting for a later poll to ask again.
        const awaitsRepair = (issueNumber: number): boolean => {
          if (!inspectedIssueNumbers.has(issueNumber)) return false
          const labels = openIssues.find((issue) => issue.number === issueNumber)?.labels ?? []
          return labels.includes(LABEL_MERGE_FAILED)
            && ![LABEL_READY, LABEL_IN_PROGRESS].some((label) => labels.includes(label))
        }
        if (remoteCount > 0 && pendingIssueNumbers.every(awaitsRepair)) {
          const issues = pendingIssueNumbers.map((issueNumber) => `#${issueNumber}`).join(' ')
          const reason = `Issues ${issues} are labelled ${LABEL_MERGE_FAILED} and are the only remaining work. Repair each adoption named in its comment, remove ${LABEL_MERGE_FAILED} and any ${LABEL_MERGE_READY}, add ${LABEL_READY}, and restart the loop.`
          if (!decisionAlreadyRecorded(reason)) appendFileSync(decisionsFile, `${reason}\n`)
          event('ERROR', reason)
          writeFileSync(stopFile, '')
          return 'continue'
        }
        if (remoteCount > 0) {
          gateWaitTarget = 'open finding'
          const pending = pendingIssueNumbers.join(' ')
          const currentTime = now().getTime()
          if (remoteWaitState?.pending !== pending
            || currentTime - remoteWaitState.loggedAt >= 10 * 60 * 1000) {
            event(
              'Waiting',
              'remote',
              `issues ${pendingIssueNumbers.slice(0, 5).map((issueNumber) => `#${issueNumber}`).join(' ')}`,
            )
            remoteWaitState = { pending, loggedAt: currentTime }
          }
          return 'continue'
        }
        remoteWaitState = undefined
      } catch (error) {
        if (!(error instanceof ForgeRateLimitError)) {
          warning('count-remote-issue-work', 'counting remote issue work',
            `could not count remote issue work: ${errorSummary(error)}`)
        }
        gateWaitTarget = 'finding status'
        return 'continue'
      }
    }
    // A scanned task whose merge failed or was deferred stays completed for the next
    // poll to retry. Passing the gate over it would promote without its work and let
    // session cleanup erase the merge-failure count that should stop the loop.
    if (config.autoMerge && !config.workerMode) {
      const unmerged = listTaskIds(paths).find((taskId) => !isInspectionTaskId(paths, taskId)
        && readTaskState(paths, taskId) === 'completed')
      if (unmerged !== undefined) {
        gateWaitTarget = `merge of ${shortTaskId(unmerged)}`
        return 'continue'
      }
    }
    // Every other task of the cycle is terminal, so the documentation held meanwhile
    // describes the code it will ship with. Its one task closes the cycle instead.
    if (await releaseHeldDocumentation(gateOpenFindings)) return 'continue'

    const currentScans = readCount(scanCountFile)
    const expectedScanFile = join(paths.queueDir, `scan-expected-${currentScans}`)
    if (currentScans > 0 && existsSync(expectedScanFile)
      && completeScanYields(currentScans) === undefined) {
      event('ERROR', `cycle ${currentScans} did not receive every expected scan yield; stopping the loop`)
      writeFileSync(stopFile, '')
      return 'continue'
    }

    if (currentScans > 0 && (config.autoPr || config.reviewEnabled)) {
      const resumeFlag = join(paths.queueDir, `cycle-resume-${currentScans}`)
      const completeFlag = join(paths.queueDir, `cycle-complete-${currentScans}`)
      const suiteTipFile = join(paths.queueDir, `cycle-suite-tip-${currentScans}`)
      const ciFixFlag = join(paths.queueDir, `ci-fix-emitted-${currentScans}`)

      if (!existsSync(resumeFlag)) {
        if (!existsSync(completeFlag)) {
          if (config.issueQueueEnabled && !reconciledCycleGates.has(currentScans)) {
            try {
              await reconcileClosedIssueLifecycleLabels(forge)
              warningLog.recovered('reconcile-closed-issue-labels')
              reconciledCycleGates.add(currentScans)
            } catch (error) {
              if (error instanceof ForgeRateLimitError) return 'continue'
              warning('reconcile-closed-issue-labels', 'reconciling closed issue labels',
                `could not reconcile closed issue labels: ${errorSummary(error)}`)
              return 'continue'
            }
          }
          // A cycle that lost tasks did not do what it set out to do, and the PR cannot
          // show it: work that never ran leaves no diff to notice it by.
          const failedFile = join(paths.queueDir, `failed-${currentScans}`)
          if (existsSync(failedFile)) {
            const failed = readFileSync(failedFile, 'utf8').split(/\r?\n/).filter((line) => line !== '')
            if (failed.length > 0) {
              const lossNote = `Cycle ${currentScans} lost ${failed.length} task(s) to failure, so their findings are not in this branch: ${failed.join(' ')}`
              if (!decisionAlreadyRecorded(lossNote)) {
                appendFileSync(decisionsFile, `${lossNote}\n`)
              }
            }
          }

          const currentTip = optionalGit(['rev-parse', 'HEAD']).trim()
          const cycleSuiteEnabled = cycleSuiteEnabledForTaskGate()
          const suitePassedForTip = cycleSuiteEnabled
            && currentTip !== ''
            && existsSync(suiteTipFile)
            && readFileSync(suiteTipFile, 'utf8').trim() === currentTip
          if (!suitePassedForTip) {
            if (!runCycleSuite(currentScans)) return 'continue'
            if (cycleSuiteEnabled && currentTip !== '') {
              writeFileSync(suiteTipFile, `${currentTip}\n`)
            }
          }

          if (config.autoPr && !(await ensureDraftPr('cycle'))) {
            gateWaitTarget = 'pull request update'
            return 'continue'
          }
          const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
          marker(`CYCLE_COMPLETE: ${currentScans}/${config.maxScanCycles}${prUrl === '' ? '' : ` PR:${prUrl}`}`)
          event('Completed', 'Cycle', prUrl === '' ? '' : `PR ${prUrl}`)
          writeFileSync(completeFlag, '')
        }

        const cyclePrUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
        const emptyPrGate = config.autoPr && cyclePrUrl === ''
        const ciStatus = config.ciGateEnabled && !emptyPrGate
          ? await checkPrCiStatus()
          : 'success'
        if (ciStatus === 'pending' || ciStatus === 'unknown') {
          gateWaitTarget = 'CI checks'
          return 'continue'
        }
        if (ciStatus === 'failure') {
          const attempts = readCount(ciFixFlag)
          if (attempts < config.maxCiFixAttempts) {
            const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
            let failSummary = ''
            try {
              const status = await forge.prStatus({ kind: 'url', value: prUrl })
              failSummary = status.checks.map((check) => `${check.name}: ${check.conclusion}`).join('\n')
            } catch {
              failSummary = ''
            }
            let pendingIdFile: string
            try {
              pendingIdFile = generateCiFixTask(currentScans, prUrl, failSummary)
            } catch (error) {
              // An attempt that never reached the queue must not be charged against the
              // cap, or a fix the loop never dispatched would exhaust it. The gate counter
              // carries the repetition instead, so an enqueue that keeps failing stops the
              // loop rather than leaving it to poll a failing PR with nothing queued.
              reportGateFailure(
                `could not enqueue CI fix: ${errorSummary(error)}`,
                'ci-fix-enqueue',
              )
              return 'continue'
            }
            previousGateFailures.delete('ci-fix-enqueue')
            writeFileSync(ciFixFlag, `${attempts + 1}\n`)
            rmSync(pendingIdFile, { force: true })
            rmSync(completeFlag, { force: true })
          } else {
            event('ERROR', `CI still failing after ${attempts} fixes; stopping the loop`)
            writeFileSync(stopFile, '')
          }
          return 'continue'
        }
        // A passing gate ends the failing episode, so an enqueue failure in a later one
        // starts its own count instead of inheriting this one's.
        previousGateFailures.delete('ci-fix-enqueue')
        if (emptyPrGate) {
          writeFileSync(resumeFlag, '')
        } else if (config.reviewEnabled && config.autoReview) {
          if (!runAutoReview(currentScans, cycleIsFinal(currentScans))) return 'continue'
          writeFileSync(resumeFlag, '')
        } else if (config.reviewEnabled) {
          // There is no manual-review command that can release this gate. Preserve the
          // poll boundary, but make the transition reachable without operator state.
          writeFileSync(resumeFlag, '')
          return 'continue'
        } else {
          writeFileSync(resumeFlag, '')
        }
      }
    }

    foldScanYields(currentScans)

    // Reaching this point proves that local work is empty and, in issue mode, that the
    // shared finding snapshot is both available and exhausted. If scanning cannot
    // produce another cycle, no source of work remains: close this cycle through the
    // same promotion and cleanup path as an exhausted scan cap.
    if (!config.scanEnabled) {
      if (config.autoPr && !(await postLoopPr())) {
        gateWaitTarget = 'pull request promotion'
        return 'continue'
      }
      cleanupSessionState()
      return 'done'
    }

    if (currentScans >= config.maxScanCycles) {
      if (config.autoPr && !(await postLoopPr())) {
        gateWaitTarget = 'pull request promotion'
        return 'continue'
      }
      cleanupSessionState()
      return 'done'
    }

    const emptyScans = readCount(emptyScanFile)
    if (emptyScans >= config.maxEmptyScans) {
      if (config.autoPr && !(await postLoopPr())) {
        gateWaitTarget = 'pull request promotion'
        return 'continue'
      }
      cleanupSessionState()
      return 'done'
    }

    const nextCycle = currentScans + 1
    // This is the only safe restart boundary: the previous gate is closed, no task is
    // running, and the next cycle has not yet consumed its number or started a scan.
    // Restarting the whole daemon here is safer than hot-swapping the project adapter:
    // every closure and adapter consumer changes atomically before any new work exists.
    if (projectAdapterChanged()) {
      restartSubject = 'adapter'
      event('Restarting', 'adapter', `for cycle ${nextCycle}`)
      return 'restart'
    }
    restartSubject = 'core'
    if (await updateCore(nextCycle) === 'restart') return 'restart'
    if (config.integrationBranch !== '') {
      absorbDefaultBranch(paths, (name, subject, detail = '') => event(name, subject, detail))
      // The default branch may carry a new adapter into the integration worktree. Check
      // again before using the loaded adapter to prepare or start the next cycle.
      if (projectAdapterChanged()) {
        restartSubject = 'adapter'
        event('Restarting', 'adapter', `for cycle ${nextCycle}`)
        return 'restart'
      }
      prepareIntegration()
    }
    const requestedScans = config.scanParallel
    let nScans = requestedScans
    let sectionGroups: number[][] = []
    if (nScans > 1) {
      let sections: number[]
      try {
        // The owner's limits are prose, not sections; leave them out so a numbered
        // heading inside them cannot change how the scans are split.
        sections = numberedScanSections(scanSpecification('scan', '', ''))
      } catch (error) {
        event('ERROR', `scan-template.md is unusable: it must contain unique numbered Markdown headings outside fenced code blocks (${errorSummary(error)})`)
        writeFileSync(stopFile, '')
        return 'continue'
      }
      if (sections.length === 0) {
        event('WARN', `scan-template.md has no numbered sections; requested ${requestedScans} parallel scans, running one full scan`)
        nScans = 1
      } else {
        if (requestedScans > sections.length) {
          nScans = sections.length
          event('WARN', `requested ${requestedScans} parallel scans but scan-template.md has ${sections.length} numbered sections; running ${nScans} scans`)
        }
        sectionGroups = partitionScanSections(sections, nScans)
      }
    }
    // Round-robin groups cover every discovered section exactly once while keeping
    // group sizes within one, without assuming what any section asks the scan to do.
    let launchFailed = false
    let retainedScan: string | undefined
    const attemptedScans: string[] = []
    for (let i = 1; i <= nScans; i++) {
      const scanId = newTaskId(paths, 'scan', now())
      const scope = nScans === 1
        ? 'Perform the full scan described below.'
        : `This scan runs alongside ${nScans - 1} partner scan(s). Perform only sections ${sectionGroups[i - 1]!.join(', ')}; the partners cover the rest. Stay inside them — overlapping findings merge away, duplicated reading does not.`
      writeFileSync(specFile(paths, scanId), scanSpecification(scanId, scope))
      attemptedScans.push(scanId)
      try {
        await startTaskImpl(paths, runner, scanId, {
          effort: config.scanEffort as 'high',
          model: config.scanModel === '' ? undefined : config.scanModel,
          setup: project.scanWorktreeSetup,
        })
        event('Started', shortTaskId(scanId), `scan ${i}/${nScans}`)
      } catch (error) {
        // A runner the loop could not identify, or could not stop, may still be writing
        // to this scan's worktree, so the scan is left for the owner rather than removed.
        if (error instanceof StartupOwnershipUnknownError) {
          event(
            'ERROR', shortTaskId(scanId),
            'runner returned an invalid PID; task ownership is unknown, task retained and loop stopped',
          )
          retainedScan = scanId
        } else if (error instanceof StartupProcessRetainedError) {
          event(
            'ERROR', shortTaskId(scanId),
            `startup process tree PID ${error.pid} survived; task retained and loop stopped`,
          )
          retainedScan = scanId
        } else {
          event('ERROR', `scan startup failed: ${errorSummary(error)} (log: ${shortLogPath(logFile(paths, scanId))}); stopping the loop`)
        }
        launchFailed = true
        break
      }
    }
    if (launchFailed) {
      // The cycle neither consumed its number nor recorded an expectation, so the next
      // start dispatches it again from the beginning. Discard what this attempt
      // materialized: left behind, each scan would be swept into the relaunched cycle's
      // failure list and counted against an expectation it was never part of, and the
      // gate would then stop every later start over a scan yield that cannot arrive.
      for (const scanId of attemptedScans) {
        if (scanId === retainedScan) continue
        try {
          cleanupTask(paths, scanId, undefined, false, log)
        } catch (error) {
          event('WARN', `${shortTaskId(scanId)} scan startup cleanup failed: ${errorSummary(error)}`)
        }
      }
      writeFileSync(stopFile, '')
      return 'continue'
    }
    writeFileSync(join(paths.queueDir, `scan-expected-${nextCycle}`), `${nScans}\n`)
    writeFileSync(scanCountFile, `${nextCycle}\n`)
    return 'continue'
  }

  /** One poll iteration. Returns 'stopped' | 'done' | 'continue' | 'restart'. */
  async function poll(): Promise<'stopped' | 'done' | 'continue' | 'restart'> {
    gateWaitTarget = undefined
    const daemonProblem = branchGuard()
    if (daemonProblem !== undefined) {
      event('ERROR', daemonProblem)
      writeFileSync(stopFile, '')
      return 'stopped'
    }
    const currentBranch = optionalGit(['branch', '--show-current']).trim()
    const recordedBranch = existsSync(runBranchFile)
      ? readFileSync(runBranchFile, 'utf8').replace(/[\r\n]/g, '')
      : ''
    if (currentBranch !== recordedBranch) {
      event('ERROR', `checkout ${currentBranch} does not match run branch ${recordedBranch}`)
      writeFileSync(stopFile, '')
      return 'stopped'
    }

    if (existsSync(stopFile)) {
      rmSync(stopFile, { force: true })
      return 'stopped'
    }

    if (!recoverInterruptedScans()) return 'stopped'

    // Label setup is a remote prerequisite, not a prerequisite for observing and
    // advancing local work. If it is unavailable, keep this poll local-only and
    // retry initialization on the next poll.
    const remoteOperationsAvailable = await initializeIssueQueue()

    let burstFailures = 0
    const mergeAttempts = new Set<string>()
    const locallyRunningIssues = new Set<number>()
    let issueReconciliationPending = false
    const issueReleaseOptions = {
      maxIssueRetries: config.maxIssueRetries,
      onPark: (issueNumber: number, failures: number) => {
        event('Parked', `#${issueNumber}`, `${failures} consecutive task failures`)
        writeFileSync(stopFile, '')
      },
      // Sibling merges, not a broken loop, exhaust a conflict chain, so the loop goes on.
      onConflictPark: (issueNumber: number, attempts: number) => {
        event('Parked', `#${issueNumber}`, `${attempts} conflicting rebases; commits kept`)
      },
      onClaimedElsewhere: (issueNumber: number) => {
        event('Released', `#${issueNumber}`, 'claimed by another account since; left as it is')
      },
    }

    const reconcileMergedIssues = async (
      taskId: string,
      linkedIssues: number[],
      mergeCommit: string,
      runBranch: string,
    ): Promise<boolean> => {
      try {
        recordIssuePromotions(paths, taskId, mergeCommit, runBranch)
        let deferred = false
        for (const linkedIssue of linkedIssues) {
          const promotion = issuePromotionForIssue(paths, linkedIssue)
          if (promotion === undefined) throw new Error('promotion record was not persisted')
          if (!remoteOperationsAvailable || promotion.commentConfirmed === true) continue

          const expectedComment = issueMergeComment(taskId, mergeCommit, runBranch)
          let present = trustedCommentPresent(
            await forge.listIssueComments(linkedIssue), expectedComment)
          if (present === false) {
            await commentOnIssueMerge(forge, linkedIssue, taskId, mergeCommit, runBranch)
            present = trustedCommentPresent(
              await forge.listIssueComments(linkedIssue), expectedComment)
          }
          // A marker whose author's permission could not be read is neither confirmed
          // nor reposted; the promotion record keeps it pending for a later poll.
          if (present === undefined) {
            deferred = true
            continue
          }
          if (!present) {
            throw new Error('merge comment is not visible after publishing it')
          }
          confirmIssuePromotion(paths, linkedIssue)
        }
        if (deferred) {
          issueReconciliationPending = true
          return false
        }
        previousGateFailures.delete(`issue-reconciliation-${taskId}`)
        return true
      } catch (error) {
        // Counted per task, so an issue that can never be reconciled, such as a deleted
        // one, stops the loop with its reason instead of holding the gate every poll.
        if (!(error instanceof ForgeRateLimitError)) {
          const subject = linkedIssues.length === 1
            ? `issue #${linkedIssues[0]}`
            : `issues ${linkedIssues.map((number) => `#${number}`).join(' ')}`
          reportGateFailure(
            `could not reconcile ${subject} after merging ${shortTaskId(taskId)}: ${errorSummary(error)}`,
            `issue-reconciliation-${taskId}`,
          )
        }
        // The promotion record is the retry state. Keep this poll local-only so the
        // cycle gate cannot advance before a later poll confirms the forge marker.
        issueReconciliationPending = true
        return false
      }
    }

    const mergeCompletedTask = async (taskId: string): Promise<void> => {
      if (!config.autoMerge || mergeAttempts.has(taskId)
        || !existsSync(join(scannedDir, taskId))) return
      clearIssueFailureCounts(paths, taskId)
      mergeAttempts.add(taskId)
      // A reserved handback replaces the merge: these commits already failed the gate twice.
      if (config.maxGateFixAttempts > 0 && readGateFixState(paths, taskId)?.pending === true) {
        await startHandback(taskId)
        return
      }
      const mergeLog = join(paths.logsDir, `${taskId}.merge.log`)
      const linkedIssues = issueNumbersForTask(paths, taskId)
      if (linkedIssues.length > 0) {
        // Re-read every claim right before the merge closes it. An issue already closed is
        // closed again harmlessly; an open issue that left loop:in-progress was reaped, and
        // may since have been handed to another claimant whose issue this merge must not
        // close. A claim that cannot be read defers the merge rather than risk that.
        const lost: number[] = []
        try {
          for (const issueNumber of linkedIssues) {
            let issue: ForgeIssue
            try {
              issue = await forge.getIssue(issueNumber)
            } catch (error) {
              // A deleted issue cannot be closed, and nothing remains open to close.
              if (error instanceof ForgeIssueNotFoundError) continue
              throw error
            }
            if (issue.state === 'open' && (!issue.labels.includes(LABEL_IN_PROGRESS)
              || issue.labels.includes(LABEL_READY))) lost.push(issueNumber)
          }
          warningLog.recovered(`merge-claim-${taskId}`)
        } catch (error) {
          if (!(error instanceof ForgeRateLimitError)) {
            warning(`merge-claim-${taskId}`, `merging ${shortTaskId(taskId)}`,
              `${shortTaskId(taskId)} merge deferred: its issue claims could not be read: `
              + errorSummary(error))
          }
          return
        }
        if (lost.length > 0) {
          // A lost claim is not this task's to close or release: unlink those issues
          // first, so failing the task cannot return another claimant's issue to ready.
          // Failed, the next poll counts it and releases or parks the issues it still holds.
          const reason = `${lost.map((number) => `#${number}`).join(', ')} no longer claimed by this task`
          recordIssuesForTask(paths, taskId,
            linkedIssues.filter((issueNumber) => !lost.includes(issueNumber)))
          if (await transitionStatus(paths, taskId, 'completed', 'failed')) {
            appendFileSync(mergeLog, `Merge refused: ${reason}\n`)
            event('WARN', `${shortTaskId(taskId)} cannot be merged: ${reason}`)
          }
          return
        }
      }
      try {
        const missingMarkers = missingRequirementCompletionMarkers(paths, taskId)
        if (missingMarkers.length > 0) {
          throw new MergeError(`Grouped task is missing requirement completion markers for ${missingMarkers.map((number) => `#${number}`).join(', ')}.`)
        }
        const mergeResult = await mergeTask(paths, taskId, {
          taskGate: config.taskGate,
          testCmd: config.testCmd === '' ? undefined : config.testCmd,
          skipAutoTest: config.skipAutoTest,
          project,
          closesIssues: linkedIssues,
          closesSourceIssues: paths.fleet === undefined
            ? undefined
            : sourceIssueNumbers(issueSourcesForTask(paths, taskId), paths.fleet.repository),
          forge: rawForge,
          outputFile: mergeLog,
          orchestrationDepsRuntime,
          onOrchestrationDepsEvent: orchestrationDepsEvent,
          beforeOrchestrationDepsInstall: stopTaskProcessesBeforeDependencyInstall,
          onMergeStart: () => event('Merging', shortTaskId(taskId)),
          // A task delegated while the gate was waiting merges commits the gate has
          // already pushed past; clearing the flags makes the gate push and verify again
          // with the new commits included. The resume flag goes too, or a merge after the
          // gate passed would reach promotion without suite, CI, or review. This runs
          // before the merged status is written, since a restart that finds the task
          // merged never comes back to it.
          beforeMergeRecorded: () => {
            if (isInspectionTaskId(paths, taskId)) return
            const cycle = readCount(scanCountFile)
            if (cycle > 0) {
              rmSync(join(paths.queueDir, `cycle-complete-${cycle}`), { force: true })
              rmSync(join(paths.queueDir, `cycle-resume-${cycle}`), { force: true })
            }
          },
          // Runs before the dependency sync: an install failure there stops the loop,
          // and a restart that finds the task merged never comes back to this point.
          onMerged: () => {
            writeFileSync(mergeFailureFile, '0\n')
            retireConflictedAttempts(taskId, linkedIssues)
            removeGateFixState(paths, taskId)
          },
          onMergeSkipped: (reason) => event(
            'Skipped', shortTaskId(taskId),
            reason === 'active' ? 'merge already in progress' : 'merge already succeeded',
          ),
          onNoChange: async () => {
            if (linkedIssues.length > 0) {
              await Promise.all(linkedIssues.map(async (issueNumber) => {
                try {
                  await closeIssueAndRemoveLifecycleLabels(forge, issueNumber,
                    `Task ${taskId} completed without changes because no change was warranted.`)
                } catch (error) {
                  // A deleted issue cannot be closed, and nothing remains open to close.
                  if (!(error instanceof ForgeIssueNotFoundError)) throw error
                }
              }))
            }
            recordIssueCompletions(paths, taskId, 'no-change')
          },
        })
        // Reaching an outcome at all means the runner no longer blocks the merge.
        warningLog.recovered(`unverified-runner-${taskId}`)
        if (mergeResult.outcome === 'no-change') {
          previousGateFailures.delete(`no-change-reconciliation-${taskId}`)
          event('No-change', shortTaskId(taskId), 'no change warranted')
          retireConflictedAttempts(taskId, linkedIssues)
          removeGateFixState(paths, taskId)
          if (!isInspectionTaskId(paths, taskId)) {
            const cycle = readCount(scanCountFile)
            if (cycle > 0) {
              rmSync(join(paths.queueDir, `cycle-complete-${cycle}`), { force: true })
            }
          }
          return
        }
        if (mergeResult.outcome === 'skipped') return
        const mergeCommit = mergeResult.mergeCommit
        event('Merged', shortTaskId(taskId), `commit ${mergeCommit.slice(0, 8)}`)
        // Issue reconciliation needs the forge, so it waits for the merge to finish; a
        // restart that finds the task merged reconciles from the promotion record.
        if (linkedIssues.length > 0) {
          // The merged status holds the branch the merge checked and landed on; asking
          // the checkout again could answer nothing and record a malformed promotion.
          const runBranch = readStatus(paths, taskId)?.run_branch ?? ''
          await reconcileMergedIssues(taskId, linkedIssues, mergeCommit, runBranch)
        }
      } catch (error) {
        if (error instanceof NoChangeReconciliationError) {
          // Counted per task, like merged-issue reconciliation, so a close that can
          // never succeed stops the loop with its reason instead of idling it forever.
          if (!(error.cause instanceof ForgeRateLimitError)) {
            reportGateFailure(
              `could not reconcile no-change task ${shortTaskId(taskId)}: ${error.message}`,
              `no-change-reconciliation-${taskId}`,
            )
          }
          issueReconciliationPending = true
          return
        }
        // Not a failure: the task completed and its runner tree is merely still visible
        // without the identity that makes stopping it safe. The entry clears on its own
        // and a later poll merges, so counting these would stop the loop over nothing —
        // which is how three polls once killed four running tasks.
        if (error instanceof UnverifiedRunnerError) {
          warning(`unverified-runner-${taskId}`, `merging ${shortTaskId(taskId)}`,
            `${shortTaskId(taskId)} merge deferred: completed runner ${error.pid} `
            + 'cannot be verified yet')
          return
        }
        // Not a failure either: the gate's tests never ran because other worktrees held
        // the repository test lock past its wait limit. The task stays completed, so the
        // next poll runs the gate again.
        if (error instanceof TestLockBusyError) {
          appendFileSync(mergeLog, `${error.message}\n`)
          event('WARN', `${shortTaskId(taskId)} merge gate deferred: the repository test lock stayed busy`)
          return
        }
        appendFileSync(mergeLog, `${errorSummary(error)}\n`)
        if (error instanceof OrchestrationDepsInstallError || error instanceof MergeRecoveryError) {
          throw error
        }
        event('Failed', shortTaskId(taskId), `log ${shortLogPath(mergeLog)}`)
        if (error instanceof RebaseConflictError) {
          noteMergeFailure(mergeLog)
          // Cleanup removes the status the poll sweep reports failures from, so an
          // abandonment that queues no retry records its loss here instead: the cycle's
          // loss note names it, and the gate verifies the branch again before promotion.
          const recordAbandonedConflict = (): void => {
            const cycle = readCount(scanCountFile)
            appendFileSync(join(paths.queueDir, `failed-${cycle}`), `${taskId}\n`)
            if (cycle > 0) rmSync(join(paths.queueDir, `cycle-complete-${cycle}`), { force: true })
          }
          let terminalized = false
          let retryId: string | undefined
          let lossRecorded = false
          try {
            terminalized = await transitionStatus(paths, taskId, 'completed', 'failed')
            if (!terminalized) {
              throw new Error('task status changed before rebase-conflict abandonment')
            }
            // The task passed its own work; only the run branch moved under it. Keep its
            // commits before cleanup deletes the task branch, and read what a retry needs
            // before cleanup and dematerialization remove it. A failure here throws before
            // cleanup, so the task branch and worktree survive for a person instead.
            const kept = keepConflictedAttempt(taskId, error)
            const specification = readFileSync(specFile(paths, taskId), 'utf8')
            const effortFile = join(paths.queueDir, 'effort', taskId)
            const effort = existsSync(effortFile) ? readFileSync(effortFile, 'utf8') : undefined
            const depthFile = join(scannedDir, `${taskId}.depth`)
            const depth = existsSync(depthFile) ? readCount(depthFile) : 0
            if (linkedIssues.length > 0) {
              if (kept.attempts !== undefined) {
                for (const issueNumber of linkedIssues) {
                  writeConflictedAttempts(paths, issueConflictKey(issueNumber), kept.attempts)
                }
              }
              prepareIssueReleaseIntent(paths, taskId, linkedIssues)
            }
            cleanupTask(paths, taskId, undefined, false, log)
            if (linkedIssues.length === 0) {
              dropClaimedTaskMaterialization(paths, taskId)
            } else {
              completeIssueReleaseIntent(paths, taskId)
              dropClaimedTaskMaterialization(paths, taskId, true)
            }
            retryId = linkedIssues.length > 0 || kept.attempts === undefined
              ? undefined
              : requeueConflictedTask(taskId, kept.attempts, specification, effort, depth)
            removeConflictedAttempts(paths, taskId)
            if (retryId === undefined) {
              recordAbandonedConflict()
              lossRecorded = true
            }
            if (linkedIssues.length > 0 && remoteOperationsAvailable) {
              const failures = await reconcileIssueReleaseIntent(
                forge, paths, taskId, issueReleaseOptions,
              )
              if (failures.length > 0) {
                throw new IssueReleaseReconciliationError(failures)
              }
            }
            if (retryId !== undefined) {
              event('Requeued', shortTaskId(taskId),
                `rebase conflict; ${shortTaskId(retryId)} starts from ${kept.branch}`)
            } else if (linkedIssues.length === 0) {
              event('Abandoned', shortTaskId(taskId), `rebase conflict; commits kept on ${kept.branch}`)
            } else if (kept.attempts !== undefined && conflictRetriesExhausted(kept.attempts)) {
              // Release reconciliation parks issues whose chain has used its retries.
              event('Abandoned', shortTaskId(taskId),
                `rebase conflict retries exhausted; ${remoteOperationsAvailable ? '' : 'issue release pending; '}`
                + `commits kept on ${kept.branch}`)
            } else if (remoteOperationsAvailable) {
              event('Released', shortTaskId(taskId),
                `rebase conflict abandoned; commits kept on ${kept.branch}`)
            } else {
              event('Abandoned', shortTaskId(taskId),
                `rebase conflict; issue release pending; commits kept on ${kept.branch}`)
            }
          } catch (abandonmentError) {
            // A preparation left behind by a failed cleanup would be published by a later
            // operator cleanup and release whichever task claims the issue next. After a
            // completed cleanup it has already become the intent, so this removes nothing.
            if (linkedIssues.length > 0) {
              try {
                removeIssueReleasePreparation(paths, taskId)
              } catch (rollbackError) {
                event('WARN', `${shortTaskId(taskId)} issue release preparation rollback failed: ${errorSummary(rollbackError)}`)
              }
            }
            if (!(abandonmentError instanceof ForgeRateLimitError)) {
              event('WARN', `${shortTaskId(taskId)} rebase conflict was abandoned but cleanup or issue release failed: ${errorSummary(abandonmentError)}`)
            }
            // A status that survived a failed cleanup still reaches the poll sweep, which
            // records the loss itself. One that cleanup already removed reaches nobody.
            if (terminalized && retryId === undefined && !lossRecorded
              && readTaskState(paths, taskId) === undefined) {
              try {
                removeConflictedAttempts(paths, taskId)
                recordAbandonedConflict()
              } catch (recordError) {
                event('WARN', `${shortTaskId(taskId)} abandoned rebase conflict could not be recorded as lost: ${errorSummary(recordError)}`)
              }
            }
          }
          return
        }
        if (await handBackFailedGate(taskId, error, mergeLog)) return
        const abandoned = noteMergeFailure(mergeLog)
        if (abandoned && linkedIssues.length > 1 && remoteOperationsAvailable) {
          try {
            const terminalized = await transitionStatus(paths, taskId, 'completed', 'failed')
            if (!terminalized) {
              throw new Error(`task status changed before grouped merge abandonment`)
            }
            // A claim that lapsed while the merge gate ran may since belong to another
            // account, whose live work releasing this task's issues must not strip.
            if (cachedUser === undefined) cachedUser = await forge.currentUser()
            const claimant = cachedUser
            await Promise.all(linkedIssues.map(async (issueNumber) => {
              if (!await returnIssueToReady(forge, issueNumber, true, claimant)) {
                issueReleaseOptions.onClaimedElsewhere(issueNumber)
              }
            }))
            dropClaimedTaskMaterialization(paths, taskId)
            event('Released', shortTaskId(taskId), 'grouped merge abandoned')
          } catch (releaseError) {
            if (!(releaseError instanceof ForgeRateLimitError)) {
              event('WARN', `${shortTaskId(taskId)} grouped merge failed and its issues could not all be released: ${errorSummary(releaseError)}`)
            }
          }
        }
      }
    }

    for (const taskId of listTaskIds(paths)) {
      // Only a running task needs its process; refreshTask makes that one full read.
      const before = readTaskState(paths, taskId)
      if (before === undefined) continue
      const refreshed = before === 'running'
        ? (await refreshTask(paths, taskId, {
          taskDeadlineHours: config.taskDeadlineHours,
          now: () => now().getTime(),
          onDeadline: reportTaskDeadline,
        }))?.status
        : before
      if (refreshed === undefined) continue
      const status = await settleHandback(taskId, refreshed)
      const wasDeadAtStartup = tasksDeadAtStartup.delete(taskId)
      const wasFailedAtStartup = tasksFailedAtStartup.delete(taskId)
      // A task can finish between the stop and this refresh; only once it leaves
      // running is the stop's verdict known, so the mark is kept until then.
      const wasStoppedByLoop = status !== 'running'
        && tasksStoppedForDependencyInstall.delete(taskId)

      if (status === 'merged' && config.issueQueueEnabled) {
        const mergedStatus = readStatus(paths, taskId)
        const linkedIssues = issueNumbersForTask(paths, taskId)
        if (linkedIssues.length > 0
          && mergedStatus?.merge_commit !== undefined
          && mergedStatus.run_branch !== undefined) {
          // A failure leaves the promotion record for a later poll; the tasks listed
          // after this one still need their completions, failures, and runners handled.
          const reconciled = await reconcileMergedIssues(
            taskId, linkedIssues, mergedStatus.merge_commit, mergedStatus.run_branch,
          )
          if (!reconciled) continue
        }
      }

      // A completed task still holds its claim until it is published or merged. Without a
      // heartbeat, a publication or merge that keeps being deferred would let the lease
      // lapse and the issue be reaped back to ready while this task still means to close
      // or report on it. Outside worker mode the status itself leaves completed once the
      // task is merged or found to need no change.
      const holdsClaim = status === 'running' || (status === 'completed'
        && (!config.workerMode || !existsSync(join(scannedDir, taskId))))
      const linkedIssues = holdsClaim ? issueNumbersForTask(paths, taskId) : []
      if (linkedIssues.length > 0 && remoteOperationsAvailable) {
        linkedIssues.forEach((issueNumber) => locallyRunningIssues.add(issueNumber))
        try {
          await heartbeatIssueForTask(forge, paths, taskId, now())
          warningLog.recovered(`heartbeat-${taskId}`)
        } catch (error) {
          if (!(error instanceof ForgeRateLimitError)) {
            warning(`heartbeat-${taskId}`, `heartbeat for ${shortTaskId(taskId)}`,
              `heartbeat failed for ${shortTaskId(taskId)}: ${errorSummary(error)}`)
          }
        }
      }

      // A task whose process is gone without the completion marker is reported once
      // per task, and the count is kept for the gate to report.
      const failedFlag = join(scannedDir, `${taskId}.failed`)
      const failedIssues = status === 'failed' ? issueNumbersForTask(paths, taskId) : []
      const failedBeforeStartup = tasksFailedBeforeStartup.has(taskId)
      if (status === 'failed' && !existsSync(failedFlag) && !wasStoppedByLoop
        && !failedBeforeStartup) {
        recordIssueFailure(paths, taskId)
      }
      if (failedIssues.length > 0 && remoteOperationsAvailable) {
        // A pending intent lists only the issues an earlier attempt could not release;
        // recording the whole set again would release the others a second time.
        if (issueReleaseIntentForTask(paths, taskId).length === 0) {
          recordIssueReleaseIntent(paths, taskId, failedIssues, true)
        }
        const failures = await reconcileIssueReleaseIntent(
          forge, paths, taskId, issueReleaseOptions,
        )
        if (failures.length === 0) {
          event('Released', shortTaskId(taskId), 'grouped task failed')
        } else {
          issueReconciliationPending = true
          noteIssueReleaseFailure(new IssueReleaseReconciliationError(failures))
        }
      }
      if (status === 'failed' && !existsSync(failedFlag) && !failedBeforeStartup) {
        const cycleNow = readCount(scanCountFile)
        marker(`FAILED: ${taskId} — log: ${logFile(paths, taskId)}`)
        event('Failed', shortTaskId(taskId), `log ${shortTaskId(taskId)}.log`)
        appendFileSync(join(paths.queueDir, `failed-${cycleNow}`), `${taskId}\n`)
        // Failures can arrive while the cycle gate is waiting on CI or review. The
        // completed marker predates this loss, so force the gate to report it and
        // verify the branch again before promotion.
        if (cycleNow > 0) {
          rmSync(join(paths.queueDir, `cycle-complete-${cycleNow}`), { force: true })
        }
        writeFileSync(failedFlag, '')
        if (!wasDeadAtStartup && !wasFailedAtStartup && !wasStoppedByLoop) {
          burstFailures += 1
        }
      }

      const scannedFlag = join(scannedDir, taskId)
      // A worker's completion ends the failure streak only once it is published, or
      // output that can never be published would reset the count it is meant to raise.
      if (status === 'completed' && !config.workerMode) clearIssueFailureCounts(paths, taskId)
      if (status === 'completed' && !existsSync(scannedFlag)
        && (!config.issueQueueEnabled || remoteOperationsAvailable)) {
        const depthFile = join(scannedDir, `${taskId}.depth`)
        const depth = existsSync(depthFile) ? readCount(depthFile) : 0

        if (config.workerMode) {
          event('Completed', shortTaskId(taskId))
          const linkedIssues = issueNumbersForTask(paths, taskId)
          if (linkedIssues.length === 0) {
            // A worker publishes completions only through an issue, so a local task
            // (a delegation that fell back after a forge error) can never be merged
            // here. Fail it with the reason in its log instead of skipping it forever.
            const reason = `a worker checkout merges only issue-linked tasks; `
              + `${taskId} has no linked issue, so its commits stay on ${branchName(taskId)}`
            if (await transitionStatus(paths, taskId, 'completed', 'failed')) {
              appendFileSync(logFile(paths, taskId), `\nWorker merge refused: ${reason}\n`)
              event('WARN', `worker task ${shortTaskId(taskId)} has no linked issue; marked failed`)
            }
            continue
          }
          const publicationFailuresFile = join(scannedDir, `${taskId}.publish-failures`)
          const findingsFiledFile = join(scannedDir, `${taskId}.findings-filed`)
          try {
            // Findings are filed before the completion is published: publishing an
            // inspection closes its issue, and nothing revisits the final message after.
            if (!existsSync(findingsFiledFile)) {
              const dispatch = await scanForNextTasks(taskId, depth)
              if (!dispatch.reconciled) {
                // A rate limit is a wait, not a failed attempt.
                if (dispatch.failure === undefined) continue
                throw new Error(dispatch.failure)
              }
              writeFileSync(findingsFiledFile, '')
            }
            await publishWorkerCompletion(taskId, linkedIssues)
            clearIssueFailureCounts(paths, taskId)
            writeFileSync(scannedFlag, '')
            rmSync(publicationFailuresFile, { force: true })
            rmSync(findingsFiledFile, { force: true })
          } catch (error) {
            if (error instanceof UnpublishableWorkerTaskError) {
              // A lost claim is not this task's to release or count: unlink those issues
              // first, so failing the task cannot return another claimant's issue to ready.
              if (error instanceof LostWorkerClaimError) {
                recordIssuesForTask(paths, taskId,
                  linkedIssues.filter((issueNumber) => !error.lostIssues.includes(issueNumber)))
              }
              // Left completed, the claim would lapse, be reaped back to ready, and be
              // claimed into this same task again without ever counting as a failure.
              // Failed, the next poll counts it and releases or parks its issues.
              if (await transitionStatus(paths, taskId, 'completed', 'failed')) {
                appendFileSync(logFile(paths, taskId), `\nWorker publication refused: ${errorSummary(error)}\n`)
                rmSync(findingsFiledFile, { force: true })
                event('WARN', `${shortTaskId(taskId)} cannot be published: ${errorSummary(error)}`)
              }
            } else if (!(error instanceof ForgeRateLimitError)) {
              const failures = readCount(publicationFailuresFile) + 1
              if (failures < MAX_WORKER_PUBLICATION_FAILURES) {
                writeFileSync(publicationFailuresFile, `${failures}\n`)
                event('WARN', `could not publish ${shortTaskId(taskId)} `
                  + `(attempt ${failures}/${MAX_WORKER_PUBLICATION_FAILURES}): ${errorSummary(error)}`)
              } else if (await transitionStatus(paths, taskId, 'completed', 'failed')) {
                appendFileSync(logFile(paths, taskId),
                  `\nWorker publication failed ${failures} times: ${errorSummary(error)}\n`)
                rmSync(findingsFiledFile, { force: true })
                event('WARN', `${shortTaskId(taskId)} failed after ${failures} publication attempts: `
                  + errorSummary(error))
              }
            }
          }
          continue
        }

        const dispatch = await scanForNextTasks(taskId, depth)
        if (!dispatch.reconciled) continue
        if (isScanTaskId(taskId)) {
          const findings = dispatch.destinations.length > 0
            ? dispatch.destinations.join(' ')
            : dispatch.findings.length === 0 ? 'none' : String(dispatch.findings.length)
          event('Completed', shortTaskId(taskId), `findings ${findings}`)
        } else {
          event('Completed', shortTaskId(taskId))
        }
        collectDecisions(taskId)

        recordScanYield(taskId)

        writeFileSync(scannedFlag, '')
      }

      // Completion processing above is one-shot, but a merge is not: transient test,
      // Docker, registry, or network failures leave the status completed so the next
      // poll retries instead of wedging the cycle gate forever.
      if (status === 'completed' && !config.workerMode) {
        await mergeCompletedTask(taskId)
        if (existsSync(stopFile)) break
      }
    }

    // Several tasks failing at once is the environment, not the work. Eleven tasks once
    // died together because DNS stopped resolving the Codex endpoint; the loop carried
    // on starting more, and each burned its tokens reaching the same wall.
    if (burstFailures >= config.maxBurstFailures) {
      event('ERROR', `${burstFailures} tasks failed in one poll; stopping for environment repair`)
      writeFileSync(stopFile, '')
    }

    let openFindings: ForgeIssue[] | null = null
    if (config.issueQueueEnabled && remoteOperationsAvailable && !existsSync(stopFile)
      && !issueReconciliationPending) {
      try {
        openFindings = await forge.listOpenIssues(LABEL_FINDING)
        warningLog.recovered('list-loop-issues')
      } catch (error) {
        if (!(error instanceof ForgeRateLimitError)) {
          warning('list-loop-issues', 'listing loop issues',
            `could not list loop issues: ${errorSummary(error)}`)
        }
      }
    }

    if (!config.workerMode && openFindings !== null && !existsSync(stopFile)) {
      await adoptRemoteTasks(openFindings)
    }

    let running = countRunningTasks() + countReservedHandbacks()

    // Nothing new starts while a stop is pending: without this the burst detector above
    // would fill the parallel slots with the very outage it just stopped for.
    if (!existsSync(stopFile)) {
      if (config.issueQueueEnabled && openFindings !== null) {
        // The shared backlog: reap quiet leases, then claim ready issues into the
        // local queue up to capacity. A forge outage degrades to local-only work for
        // this poll rather than stopping anything.
        try {
          await reconcileFindingFingerprints(forge, paths, openFindings)
          await reapStaleLeases(
            forge,
            paths,
            config.issueLeaseHours,
            now(),
            locallyRunningIssues,
            openFindings,
            issueHasMergeMarker,
            issueReleaseOptions,
          )
          if (!config.workerMode) {
            // Closing promoted issues is bookkeeping a later poll can finish; it must not
            // cost this poll its claims. A queue in the project's own repository is closed
            // by the merge commit, but an abandoned run still has to return its issues.
            try {
              // An unknown held branch would make the run this checkout still holds look
              // abandoned and return its merged issues, so a failed lookup skips the step.
              const heldBranch = git(['branch', '--show-current']).trim()
              if (heldBranch === '') throw new Error('the checkout is not on a branch')
              let strandedReported = false
              const { closed, returned } = await closePromotedIssues(
                forge, paths, promotedCommitContained, heldBranch,
                issueQueueIsSeparate(paths),
                runBranchProbe((runBranch, issueNumbers) => {
                  strandedReported = true
                  warning('stranded-promotions', 'settling run branches without a pull request',
                    `run branch ${runBranch} has no pull request; issues `
                    + `${issueNumbers.map((issueNumber) => `#${issueNumber}`).join(' ')} stay claimed`)
                }),
              )
              if (!strandedReported) warningLog.recovered('stranded-promotions')
              for (const issueNumber of closed) {
                event('Promoted', `#${issueNumber}`, 'closed after its run pull request merged')
              }
              for (const issueNumber of returned) {
                event('Released', `#${issueNumber}`, 'run pull request closed without merging')
              }
              warningLog.recovered('promoted-issues')
            } catch (error) {
              if (error instanceof ForgeRateLimitError) throw error
              warning('promoted-issues', 'closing promoted issues',
                `could not close promoted issues: ${errorSummary(error)}`)
            }
          }
          if (readCount(issueReleaseFailureFile) > 0) {
            writeFileSync(issueReleaseFailureFile, '0\n')
            warningLog.recovered('issue-release-reconciliation')
          }
          let capacity = config.maxParallel - running - queueLength()
          if (capacity > 0) {
            if (cachedUser === undefined) cachedUser = await forge.currentUser()
            const readyIssues = openFindings.filter((candidate) =>
              issueHasExactlyLifecycleLabel(candidate, LABEL_READY)
                && !candidate.labels.includes(LABEL_UNTRUSTED_AUTHOR)
                && candidate.assignees.length === 0
                && issuePromotionForIssue(paths, candidate.number) === undefined)
            let permissionUnknown = false
            for (const issues of groupReadyFindings(readyIssues)) {
              if (capacity <= 0) break
              const result = await claimIssueGroup(
                forge, paths, issues, cachedUser, appendClaimedRequirementsWithConflicts,
                config.workerMode,
              )
              if (result.outcome === 'claimed') {
                event('Claimed', shortTaskId(result.taskId),
                  result.issueNumbers.map((issueNumber) => `#${issueNumber}`).join(' '))
                if (result.pendingMerge && !config.workerMode) await mergeCompletedTask(result.taskId)
                capacity -= 1
              } else if (result.outcome === 'already-processed') {
                event('Deduplicated',
                  result.issueNumbers.map((issueNumber) => `#${issueNumber}`).join(' '),
                  `against ${shortTaskId(result.taskId)}`)
              } else if (result.outcome === 'untrusted-author') {
                // The poll's shared listing predates the label mutation. Reflect it
                // locally so this quarantined issue cannot hold today's idle gate open.
                const untrusted = issues.find((issue) => issue.number === result.issueNumber)
                if (untrusted !== undefined
                  && !untrusted.labels.includes(LABEL_UNTRUSTED_AUTHOR)) {
                  untrusted.labels.push(LABEL_UNTRUSTED_AUTHOR)
                }
                event(
                  'WARN',
                  `issue #${result.issueNumber} by @${result.author} is not trusted for execution; labeled ${LABEL_UNTRUSTED_AUTHOR}`,
                )
              } else if (result.outcome === 'permission-unknown') {
                permissionUnknown = true
                warning('issue-author-permission', 'checking issue author permission',
                  `skipped issue #${result.issueNumber} this poll: write access of @${result.author} could not be determined`)
              } else if (result.outcome === 'unparseable') {
                if (!decisionAlreadyRecorded(result.reason)) {
                  appendFileSync(decisionsFile, `${result.reason}\n`)
                }
                event('ERROR', result.reason)
                writeFileSync(stopFile, '')
                break
              }
            }
            if (!permissionUnknown) warningLog.recovered('issue-author-permission')
          }
          warningLog.recovered('issue-queue-sync')
        } catch (error) {
          if (error instanceof IssueReleaseReconciliationError) {
            issueReconciliationPending = true
            noteIssueReleaseFailure(error)
          } else if (!(error instanceof ForgeRateLimitError)) {
            warning('issue-queue-sync', 'syncing the issue queue',
              `issue queue unreachable: ${errorSummary(error)}`)
          }
        }
      }

      for (; !existsSync(stopFile);) {
        if (running >= config.maxParallel) break
        const entry = dequeueNext(remoteOperationsAvailable)
        if (entry === undefined) break
        writeFileSync(join(scannedDir, `${entry.taskId}.depth`), `${entry.depth}\n`)

        const effortFile = join(paths.queueDir, 'effort', entry.taskId)
        const effort = existsSync(effortFile)
          ? readFileSync(effortFile, 'utf8').replace(/[\s\r\n]/g, '')
          : config.taskEffort
        // A retry of a failure the previous run announced is a new attempt; its own
        // outcome is reported and counted like any other task's.
        tasksFailedBeforeStartup.delete(entry.taskId)
        try {
          await startTaskImpl(paths, runner, entry.taskId, {
            effort: effort as 'medium',
            model: config.taskModel === '' ? undefined : config.taskModel,
          })
          if (isReviewTaskId(entry.taskId)) {
            const cycle = Number(/_review-c(\d+)/.exec(entry.taskId)?.[1] ?? 0)
            const round = readCount(join(paths.queueDir, `review-round-${cycle}`))
            const final = cycleIsFinal(cycle)
            const maxRounds = final ? config.maxFinalReviewRounds : config.maxReviewRounds
            event('Started', shortTaskId(entry.taskId), `round ${round}/${maxRounds}${final ? '  phase final' : ''}`)
          } else {
            event('Started', shortTaskId(entry.taskId), `effort ${effort}`)
          }
          previousGateFailures.delete(`task-startup-${entry.taskId}`)
          running += 1
        } catch (error) {
          if (error instanceof StartupOwnershipUnknownError) {
            event(
              'ERROR', shortTaskId(entry.taskId),
              'runner returned an invalid PID; task ownership is unknown, task retained and loop stopped',
            )
            writeFileSync(stopFile, '')
            break
          }
          if (error instanceof StartupProcessRetainedError) {
            event(
              'ERROR', shortTaskId(entry.taskId),
              `startup process tree PID ${error.pid} survived; task retained and loop stopped`,
            )
            writeFileSync(stopFile, '')
            break
          }
          const issueNumbers = issueNumbersForTask(paths, entry.taskId)
          if (config.issueQueueEnabled && issueNumbers.length > 0) {
            recordIssueFailure(paths, entry.taskId)
            // The status sweep counts a failed task that has no flag. A release that fails
            // here leaves the task behind for later polls, so mark the failure as counted.
            writeFileSync(join(scannedDir, `${entry.taskId}.failed`), '')
            let released = false
            if (remoteOperationsAvailable) {
              recordIssueReleaseIntent(paths, entry.taskId, issueNumbers, true)
              const failures = await reconcileIssueReleaseIntent(
                forge, paths, entry.taskId, issueReleaseOptions,
              )
              if (failures.length === 0) {
                released = true
                event('Released', shortTaskId(entry.taskId), 'startup failed')
              } else {
                issueReconciliationPending = true
                noteIssueReleaseFailure(new IssueReleaseReconciliationError(failures))
              }
            }
            if (released) {
              try {
                cleanupTask(paths, entry.taskId, undefined, false, log)
                dropClaimedTaskMaterialization(paths, entry.taskId)
              } catch (cleanupError) {
                event('WARN', `${shortTaskId(entry.taskId)} startup cleanup failed: ${errorSummary(cleanupError)}`)
              }
            } else {
              // The durable release intent owns the retry. Keep the task mapping linked
              // until reconciliation succeeds, but do not restart work for that claim.
              break
            }
          } else {
            if (readTaskState(paths, entry.taskId) === undefined) {
              requeueAfterStartupFailure(entry.taskId, entry.depth, error)
              // A deterministic preflight error would otherwise be dequeued again in
              // this poll. Preserve it for a later poll after the input is repaired.
              break
            }
            event('WARN', `${shortTaskId(entry.taskId)} startup failed: ${errorSummary(error)}`)
          }
        }
      }

      if (!config.workerMode && !issueReconciliationPending) {
        const outcome = await triggerScanIfIdle(
          config.issueQueueEnabled ? openFindings : undefined,
        )
        if (outcome === 'done') return 'done'
        if (outcome === 'restart') return 'restart'
      }
    }

    const scans = config.workerMode ? 0 : listTaskIds(paths)
      .filter((taskId) => isScanTaskId(taskId) && readTaskState(paths, taskId) === 'running')
      .length
    // A finding left ready because every slot was taken is queued work too. Counting
    // only the local file printed Queue=0 beside a backlog the loop could already see.
    const readyFindings = !config.workerMode && config.issueQueueEnabled && openFindings !== null
      ? openFindings.filter(isReadyToClaim).length
      : 0
    const queue = queueLength() + readyFindings
    const counters = [
      ...(scans > 0 ? [`Scan=${scans}`] : []),
      `Task=${running}`,
      `Queue=${queue}`,
    ]
    const waitingFor: string[] = []
    if (scans === 0 && running === 0 && queue === 0) {
      if (gateWaitTarget !== undefined) waitingFor.push(gateWaitTarget)
      else if (config.workerMode) waitingFor.push('open finding')
      else if (config.issueQueueEnabled && openFindings === null) waitingFor.push('finding status')
      else if (config.issueQueueEnabled && (openFindings?.length ?? 0) > 0) {
        waitingFor.push('open finding')
      } else if (config.scanEnabled) waitingFor.push('next scan')
      else if (config.autoPr) waitingFor.push('pull request promotion')
    }
    const statusParts = [
      ...counters,
      ...(waitingFor.length > 0 ? [`Waiting=${waitingFor.join(', ')}`] : []),
    ]
    const idle = scans === 0 && running === 0 && queue === 0
    if (!idle) {
      idleLogState = undefined
      event('Running', 'Status', statusParts.join('  '))
      return 'continue'
    }

    const currentTime = now().getTime()
    if (idleLogState === undefined || currentTime < idleLogState.startedAt) {
      idleLogState = {
        startedAt: currentTime,
        nextLogAge: nextIdleLogAge(0),
        detail: statusParts.join('  '),
      }
      statusParts.splice(counters.length, 0, '0s')
      event('Idle', 'Status', statusParts.join('  '))
      return 'continue'
    }

    const idleAge = currentTime - idleLogState.startedAt
    const detail = statusParts.join('  ')
    if (detail !== idleLogState.detail || idleAge >= idleLogState.nextLogAge) {
      idleLogState.detail = detail
      idleLogState.nextLogAge = nextIdleLogAge(idleAge)
      statusParts.splice(counters.length, 0, formatIdleDuration(idleAge))
      event('Idle', 'Status', statusParts.join('  '))
    }
    return 'continue'
  }

  async function guardedPoll(): Promise<'stopped' | 'done' | 'continue' | 'restart'> {
    try {
      return await poll()
    } catch (error) {
      // Even a reset far beyond the ordinary poll window is an external wait, not a
      // branch failure. The proxy suppresses all further forge calls until it expires.
      if (error instanceof ForgeRateLimitError) return 'continue'
      if (error instanceof InvalidPersistedCounterError) return 'stopped'
      throw error
    }
  }

  return {
    // exported for the daemon
    poll: guardedPoll,
    initializeIssueQueue,
    validatePushTarget,
    initializeSessionStateForBranch,
    restartSubject: () => restartSubject,
    // exported for tests
    actionableFindings,
    recordScanYield,
    foldScanYields,
    scanForNextTasks,
    collectDecisions,
    noteMergeFailure,
    adoptRemoteTasks,
    cycleIsFinal,
    runAutoReview,
    runCycleSuite,
    triggerScanIfIdle,
    checkPrCiStatus,
    ensureDraftPr,
    postLoopPr,
    countAllTasks,
  }
}

export type Loop = ReturnType<typeof createLoop>
