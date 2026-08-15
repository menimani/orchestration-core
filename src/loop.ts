import { execFileSync } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  ForgeRateLimitError, type Forge, type ForgeIssue, type ForgeIssueComment,
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
  completeTaskWithoutChanges, mergeRemoteTask, mergeTask, MergeError,
  NoChangeReconciliationError, RebaseConflictError,
  OrchestrationDepsInstallError,
  type OrchestrationDepsRuntime,
} from './merge.ts'
import {
  finalMessageFile, isInspectionTaskId, isReviewTaskId, isScanTaskId, logFile,
  branchName, PACKAGE_ROOT, worktreeDir, type OrchPaths,
} from './paths.ts'
import { buildPrBody, GENERATED_BODY_MARKER, prTitle } from './prbody.ts'
import { refreshTask, listTaskIds, noChangeMarkerPresent } from './refresh.ts'
import { readStatus, transitionStatus } from './status.ts'
import { startTask } from './start.ts'
import { enqueueTask, newTaskSpec, specFile } from './tasks.ts'
import {
  frameUntrustedText, frameVerifiedRequirement, readTemplate, repositoryInspectionPreamble,
  reviewScopeTemplateValues,
} from './templates.ts'
import { pitfallsFileForDesc } from './gates.ts'
import { currentBranchPushRemote, currentBranchTrackingRemote } from './gitRemote.ts'
import { LoopWarningLog } from './loopLog.ts'
import { newestChecksByName } from './ciWait.ts'
import { execShellSync } from './shell.ts'
import {
  updateCoreBeforeCycle, type CoreUpdateOutcome,
} from './coreUpdate.ts'
import { absorbDefaultBranch } from './branchTopology.ts'
import {
  claimIssueGroup, closeIssueAndRemoveLifecycleLabels, commentOnIssueMerge,
  confirmIssuePromotion, dropClaimedTaskMaterialization, groupReadyFindings,
  heartbeatIssueForTask, fingerprintOf, issueMergeComment,
  issueHasExactlyLifecycleLabel, issueNumberForTask, issueNumbersForTask, issuePromotionForIssue,
  missingRequirementCompletionMarkers, publishFinding, reapStaleLeases,
  completeIssueReleaseIntent, prepareIssueReleaseIntent, reconcileIssueReleaseIntent,
  recordIssueCompletions, recordIssuesForTask, recordIssuePromotions, releaseIssueClaim,
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
  enqueueTask?: typeof enqueueTask
  updateCoreBeforeCycle?: (cycle: number) => Promise<CoreUpdateOutcome>
  projectAdapterChanged?: () => boolean
  branchGuard?: (() => string | undefined) | undefined
  prepareIntegrationWorktree?: (() => void) | undefined
}

interface QueueEntry {
  taskId: string
  depth: number
}

interface FindingDispatch {
  findings: string[]
  destinations: string[]
  reconciled: boolean
}

const IDLE_LOG_MAX_INTERVAL_MS = 5 * 60 * 1000
const MAX_CONSECUTIVE_ISSUE_RELEASE_FAILURES = 3

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
    enqueueTask: enqueueTaskImpl = enqueueTask,
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
  let emptyRun = false

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

  // Resolved once per process; the login cannot change under a running loop.
  let cachedUser: string | undefined
  const warningLog = new LoopWarningLog(paths, log, now)
  let remoteWaitState: { pending: string; loggedAt: number } | undefined
  let forgeRateLimitUntil = 0
  let loggedForgeRateLimitUntil = 0
  const issueCommentCache = new Map<number, {
    updatedAt: string
    comments: ForgeIssueComment[]
    hasMergeMarker: boolean
  }>()
  const reconciledCycleGates = new Set<number>()
  let issueQueueInitialized = !config.issueQueueEnabled
  const previousGateFailures = new Map<string, { message: string; count: number }>()
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
    issueCommentCache.set(issue.number, {
      updatedAt: issue.updatedAt,
      comments,
      hasMergeMarker: comments.some((comment) =>
        comment.author.hasWriteAccess && /^MERGED: /.test(comment.body)),
    })
    return comments
  }

  async function issueHasMergeMarker(issue: ForgeIssue): Promise<boolean> {
    await commentsForIssue(issue)
    return issueCommentCache.get(issue.number)?.hasMergeMarker ?? false
  }

  async function initializeIssueQueue(): Promise<boolean> {
    if (!config.issueQueueEnabled) return true
    if (issueQueueInitialized) return true
    try {
      await ensureQueueLabels(forge)
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

  function orchestrationDepsEvent(name: 'Installed' | 'WARN', subject: string): void {
    if (name === 'Installed') event(name, 'orchestration deps', subject)
    else event(name, subject)
  }

  function warning(callSite: string, operation: string, subject: string): void {
    warningLog.warn(callSite, operation, subject)
  }

  function shortLogPath(file: string): string {
    return relative(paths.root, file).replaceAll('\\', '/')
  }

  function errorSummary(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    return message.trim() || 'unknown error'
  }

  function reportGateFailure(
    message: string,
    stopWhenRepeated = false,
    gate = 'draft-pr',
  ): void {
    const previous = previousGateFailures.get(gate)
    const count = previous?.message === message
      ? previous.count + 1
      : 1
    previousGateFailures.set(gate, { message, count })
    const detail = count === 1 ? message : `${message} (repeated ${count} times)`
    if (stopWhenRepeated && count > 1) {
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
    reportGateFailure(failure, true, `task-startup-${taskId}`)
  }

  function readCount(file: string): number {
    if (!existsSync(file)) return 0
    const raw = readFileSync(file, 'utf8').replace(/[\s\r\n]/g, '')
    return /^\d+$/.test(raw) ? Number(raw) : 0
  }

  function git(args: string[], quietSuccess = ''): string {
    try {
      const output = execFileSync('git', args, {
        cwd: paths.repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      return output === '' ? quietSuccess : output
    } catch {
      return ''
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
      throw new Error(`missing requirement completion markers for ${missingMarkers.map((number) => `#${number}`).join(', ')}`)
    }
    const worktree = worktreeDir(paths, taskId)
    // The comparison base is the checkout's HEAD SHA, not its branch name: a detached
    // worker checkout has an empty branch name, which read as zero commits and left
    // completed work permanently unpublished.
    const baseSha = git(['rev-parse', 'HEAD']).trim()
    if (gitIn(worktree, ['status', '--porcelain']).trim() !== '') {
      throw new Error(`${taskId} has uncommitted changes`)
    }
    const commits = gitIn(worktree, ['log', `${baseSha}..HEAD`, '--format=%H'])
      .trim().split(/\r?\n/).filter((line) => line !== '')
    if (commits.length === 0) {
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
      throw new Error(`${taskId} has no commits and is not an inspection task`)
    }

    const branch = branchName(taskId)
    const remote = currentBranchPushRemote(paths.repoRoot)
    gitIn(worktree, ['push', '--quiet', '--set-upstream', remote, branch])
    const head = gitIn(worktree, ['rev-parse', 'HEAD']).trim()
    const issueList = issueNumbers.map((issueNumber) => `#${issueNumber}`).join(' ')
    await Promise.all(issueNumbers.map(async (issueNumber) => {
      await forge.commentIssue(issueNumber,
        `Worker completed the task.\nBranch: ${branch}\nHead commit: ${head}\nIssues: ${issueList}`)
      await forge.addLabel(issueNumber, LABEL_MERGE_READY)
      await forge.removeLabel(issueNumber, LABEL_IN_PROGRESS)
    }))
  }

  function workerBranchReport(
    comments: ForgeIssueComment[],
  ): { branch: string; head: string; issueNumbers?: number[] } | undefined {
    for (const comment of [...comments].reverse()) {
      if (!comment.author.hasWriteAccess) continue
      const branch = /^Branch: (task\/[A-Za-z0-9][A-Za-z0-9._-]*)$/m.exec(comment.body)?.[1]
      const head = /^Head commit: ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/m.exec(comment.body)?.[1]
      if (branch !== undefined && head !== undefined) {
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
    if (!(await commentsForIssue(issue)).some((candidate) =>
      candidate.author.hasWriteAccess && candidate.body === comment)) {
      await commentOnIssueMerge(forge, issue.number, taskId, mergeCommit, runBranch)
    }
    await forge.removeLabel(issue.number, LABEL_MERGE_READY)
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
        const report = workerBranchReport(await commentsForIssue(issue))
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
        for (const candidate of adoptionIssues) {
          const candidateReport = workerBranchReport(await commentsForIssue(candidate))
          if (candidateReport?.branch !== report.branch || candidateReport.head !== report.head) {
            throw new MergeError(`Grouped issue #${candidate.number} does not report the same worker branch.`)
          }
        }
        adoptionIssues.forEach((candidate) => processedIssues.add(candidate.number))
        const taskId = report.branch.slice('task/'.length)
        adoptionTaskId = taskId
        event('Merging', shortTaskId(taskId))
        try {
          execFileSync('git', [
            'fetch', '--quiet', remote,
            `+refs/heads/${report.branch}:refs/remotes/${remote}/${report.branch}`,
          ], {
            cwd: paths.repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
        } catch {
          throw new MergeError(`Could not fetch ${report.branch} from ${remote}.`)
        }

        const runBranch = git(['branch', '--show-current']).trim()
        const mergeCommit = await mergeRemoteTask(
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
            closesIssues: adoptionIssues.map((candidate) => candidate.number),
            onMerged: (mergedCommit) => {
              writeFileSync(mergeFailureFile, '0\n')
              recordIssuesForTask(
                paths, taskId, adoptionIssues.map((candidate) => candidate.number),
              )
              recordIssuePromotions(paths, taskId, mergedCommit, runBranch)
              const cycle = readCount(scanCountFile)
              if (cycle > 0) {
                rmSync(join(paths.queueDir, `cycle-complete-${cycle}`), { force: true })
              }
            },
          },
        )
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
        if (error instanceof OrchestrationDepsInstallError) throw error
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
            await forge.addLabel(issue.number, LABEL_MERGE_FAILED)
            await forge.removeLabel(issue.number, LABEL_MERGE_READY)
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
      .filter((taskId) => readStatus(paths, taskId)?.status === 'running').length
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
      const status = readStatus(paths, taskId)?.status
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

  function dequeueNext(remoteOperationsAvailable = true): QueueEntry | undefined {
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
    const ideographicFullStop = String.fromCodePoint(0x3002)
    const normalized = trimmed.replace(/[.!]+$/, '')
      .replace(new RegExp(`${ideographicFullStop}+$`), '').toLowerCase()
    if (['none', 'n/a', 'nothing', 'no findings', 'no finding', 'nothing to report', 'nothing found']
      .includes(normalized)) return true
    const noFindingPhrases = [
      [0x6307, 0x6458, 0x306a, 0x3057],
      [0x554f, 0x984c, 0x306a, 0x3057],
      [0x8a72, 0x5f53, 0x306a, 0x3057],
      [0x7279, 0x306b, 0x306a, 0x3057],
      [0x306a, 0x3057],
    ].map((points) => String.fromCodePoint(...points))
    if (noFindingPhrases.includes(normalized)) return true
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
  ): void {
    const parts = [`\n## Auto-generated task (parent: ${parentId})\n`]
    if (includeDescription) parts.push(`\n${desc}\n`)
    parts.push(`\n${readTemplate(paths, 'task-requirements.md')}`)
    const pitfalls = pitfallsFileForDesc(paths, desc)
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
    const otherFindingOrigin = isReview ? 'auto' : 'fix'
    const existingFindingTask = (description: string): string | undefined =>
      existingTaskIdForDesc(paths, findingOrigin, description)
        ?? existingTaskIdForDesc(paths, otherFindingOrigin, description)

    const newDepth = depth + 1
    if (newDepth > config.maxGrowthDepth) {
      event('WARN', `growth depth limit ${config.maxGrowthDepth} ignored findings from ${shortTaskId(taskId)}`)
      return { findings, destinations, reconciled: true }
    }
    if (config.issueQueueEnabled) {
      let pendingFindings = findings
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
          return { findings, destinations, reconciled: false }
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
            event('WARN', `could not file finding: ${errorSummary(error)}`)
          }
        }
      }
      return { findings, destinations, reconciled }
    }

    const pendingFindings = isReview
      ? [...new Set(findings)].filter((finding) => {
        const existing = existingFindingTask(finding)
        if (existing !== undefined) {
          // A failed task is retryable by design — enqueueTask re-admits it — so only
          // queued, active or landed work suppresses the finding. Suppressing on the
          // bare existence of the spec blocked that supported retry path.
          const status = readStatus(paths, existing)?.status
          const queued = existsSync(queueFile)
            && readFileSync(queueFile, 'utf8').split(/\r?\n/)
              .some((line) => line.startsWith(`${existing}:`))
          const mergedAdvisory = (status === 'merged' || status === 'no-change')
            && fingerprintOf(finding).startsWith('advisory:')
          if (queued || status === 'running' || status === 'completed' || mergedAdvisory) {
            destinations.push(shortTaskId(existing))
            return false
          }
        }
        return true
      })
      : findings
    if (pendingFindings.length === 0) return { findings, destinations, reconciled: true }
    const combinesReviewFindings = isReview && pendingFindings.length > 1
    const descriptions = combinesReviewFindings
      ? [pendingFindings.map((finding, index) => `${index + 1}. ${finding}`).join('\n')]
      : pendingFindings
    let reconciled = true
    for (const desc of descriptions) {
      if (!hasTaskCapacity(taskId)) continue
      const existing = existingFindingTask(desc)
      const needsFreshTask = existing !== undefined
        && ['merged', 'no-change'].includes(readStatus(paths, existing)?.status ?? '')
        && !fingerprintOf(desc).startsWith('advisory:')
      const newId = needsFreshTask
        ? newTaskId(paths, `${findingOrigin}-${descSlug(desc)}`)
        : existing ?? taskIdForDesc(paths, findingOrigin, desc)
      if (needsFreshTask) recordTaskIdForDesc(paths, findingOrigin, desc, newId)
      destinations.push(shortTaskId(newId))
      if (!existsSync(specFile(paths, newId))) {
        // The template carries the Commit and TASK_COMPLETE instructions — a spec
        // without them produces work whose completion is indistinguishable from a
        // crash, recorded failed with the commits sitting in the worktree.
        newTaskSpec(paths, newId)
        if (combinesReviewFindings) {
          const file = specFile(paths, newId)
          const spec = readFileSync(file, 'utf8').replace(
            '## Requirements\n-\n',
            `## Requirement\n\n${desc}\n`,
          )
          writeFileSync(file, spec)
          appendSharedRequirements(newId, taskId, desc, false)
        } else {
          appendSharedRequirements(newId, taskId, desc)
        }
      }
      if (combinesReviewFindings) {
        for (const finding of pendingFindings) {
          recordTaskIdForDesc(paths, findingOrigin, finding, newId)
        }
      }
      // A fix born from a review is repairing something subtle enough to have escaped
      // the implementer once, so review-spawned tasks run at high effort.
      const effortFile = join(paths.queueDir, 'effort', newId)
      if (isReview && !existsSync(effortFile)) {
        mkdirSync(join(paths.queueDir, 'effort'), { recursive: true })
        writeFileSync(effortFile, 'high\n')
      }
      try {
        const enqueue = enqueueTaskImpl(paths, newId, newDepth)
        if (enqueue.outcome === 'enqueued') recordPublishedTask()
      } catch (error) {
        reconciled = false
        reportGateFailure(
          `could not enqueue finding from ${shortTaskId(taskId)}: ${errorSummary(error)}`,
          true,
          `completion-scan-${taskId}`,
        )
      }
    }
    return { findings, destinations, reconciled }
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

  /**
   * Count a merge failure and stop once they stop looking like the work: the task
   * completed and the gate that verifies it could not run. Any successful merge resets
   * the count, so one genuine test failure does not accumulate alongside unrelated ones.
   */
  function noteMergeFailure(mergeLog: string): boolean {
    const failures = readCount(mergeFailureFile) + 1
    writeFileSync(mergeFailureFile, `${failures}\n`)

    let diagnosis = ''
    if (existsSync(mergeLog)) {
      const text = readFileSync(mergeLog, 'utf8')
      const infrastructureFailure = project.classifyInfrastructureFailure?.(text)
      if (infrastructureFailure !== undefined) {
        diagnosis = infrastructureFailure.diagnosis
      } else if (/Could not resolve host|Connection refused/.test(text)) {
        diagnosis = 'the network or a package registry is unreachable'
      }
    }
    if (diagnosis !== '') event('WARN', diagnosis)

    if (failures >= config.maxConsecutiveMergeFailures) {
      event('ERROR', `${failures} consecutive merge failures; stopping the loop`)
      writeFileSync(stopFile, '')
      return true
    }
    return false
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
      isScanTaskId(taskId) && readStatus(paths, taskId)?.status === 'running')
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

  function completeScanYields(cycle: number): string[] | undefined {
    const expectedFile = join(paths.queueDir, `scan-expected-${cycle}`)
    const yieldFile = join(paths.queueDir, `scan-yield-${cycle}`)
    if (!existsSync(expectedFile) || !existsSync(yieldFile)) return undefined
    const expected = readCount(expectedFile)
    const keyedYields = new Map<string, string>()
    const legacyYields: string[] = []
    for (const line of readFileSync(yieldFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
      if (line === 'found' || line === 'empty') {
        legacyYields.push(line)
        continue
      }
      const match = /^(\S+)\t(found|empty)$/.exec(line)
      if (match === null) return undefined
      keyedYields.set(match[1]!, match[2]!)
    }
    const yields = [...legacyYields, ...keyedYields.values()]
    if (expected === 0 || yields.length !== expected) {
      return undefined
    }
    return yields
  }

  /**
   * Fold the finished cycle's scan records into the empty-scan counter: reset on any
   * finding, increment exactly once when every expected scan came back empty, and leave
   * it untouched when any scan failed or did not finish.
   */
  function foldScanYields(cycle: number): void {
    const yields = completeScanYields(cycle)
    if (yields === undefined) return
    const expectedFile = join(paths.queueDir, `scan-expected-${cycle}`)
    const yieldFile = join(paths.queueDir, `scan-yield-${cycle}`)
    if (yields.includes('found')) {
      writeFileSync(emptyScanFile, '0\n')
    } else {
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

  function scanSpecification(scanId: string, scope: string): string {
    return repositoryInspectionPreamble()
      + renderTemplate('scan-template.md', { SCAN_ID: scanId, SCAN_SCOPE: scope })
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
    let baseBranch = git([
      'symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`,
    ]).trim()
    if (!baseBranch.startsWith(remotePrefix)
      || git(['rev-parse', '--verify', `${baseBranch}^{commit}`]).trim() === '') {
      const advertised = git(['ls-remote', '--symref', remote, 'HEAD'])
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
      || git(['rev-parse', '--verify', `${baseBranch}^{commit}`]).trim() === '') {
      event('WARN', `could not resolve a valid default branch for ${remote}`)
      return false
    }
    const acceptedLimitsFile = join(paths.root, 'accepted-limits.md')
    const acceptedLimits = existsSync(acceptedLimitsFile)
      ? readFileSync(acceptedLimitsFile, 'utf8').trim() || '(none)'
      : '(none)'
    const text = repositoryInspectionPreamble() + renderTemplate('review-template.md', {
      REVIEW_ID: reviewId,
      CYCLE: String(cycle),
      PR_URL: prUrl === '' ? '(PR URL unknown)' : prUrl,
      BASE_BRANCH: baseBranch,
      ACCEPTED_LIMITS: frameUntrustedText(acceptedLimits),
      ...reviewScopeTemplateValues(
        paths.repoRoot,
        config.integrationBranch === ''
          ? PACKAGE_ROOT
          : join(paths.repoRoot, relative(dirname(paths.root), PACKAGE_ROOT)),
      ),
    })
    writeFileSync(specFile(paths, reviewId), text)
    return true
  }

  /**
   * The final cycle is the scan-limit cycle, or one whose scans all came back empty
   * when one more empty cycle reaches MAX_EMPTY_SCANS — the run ends after it either
   * way, so it is the last chance for a review to read the branch.
   */
  function cycleIsFinal(cycle: number): boolean {
    if (cycle >= config.maxScanCycles) return true
    const yields = completeScanYields(cycle)
    if (yields !== undefined && !yields.includes('found')) {
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

    if (!isFinal && cycle % config.reviewEveryNCycles !== 0) {
      return true
    }

    const maxRounds = isFinal ? config.maxFinalReviewRounds : config.maxReviewRounds
    const rounds = readCount(roundFile)
    const lastId = existsSync(idFile) ? readFileSync(idFile, 'utf8').replace(/[\s\r\n]/g, '') : ''
    let missingVerdict = false

    if (lastId !== '') {
      const status = readStatus(paths, lastId)?.status
      if (status !== 'completed' && status !== 'merged') {
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
        // Promoting here would ship findings nobody resolved — the failure the round
        // cap used to allow — or trust a review that never produced a verdict. Rounds
        // this persistent signal something structural, which is a person's call, so
        // the loop stops instead of promoting.
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
    const reviewId = newTaskId(paths, `review-c${cycle}`, now())
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
      event('WARN', `could not enqueue review: ${errorSummary(error)}`)
      return false
    }
    // The round and id are the durable receipt for a dispatched review. Publishing
    // them before the backlog mutation succeeds consumes a round without any worker
    // being able to perform it, so keep them behind the enqueue boundary.
    writeFileSync(roundFile, `${rounds + 1}\n`)
    writeFileSync(idFile, `${reviewId}\n`)
    return false
  }

  function cleanupSessionState(preserveTaskMarkers = false): void {
    for (const name of readdirSync(paths.queueDir)) {
      if (/^(cycle-complete-|cycle-suite-tip-|cycle-resume-|ci-fix-emitted-|review-round-|review-id-|failed-|scan-yield-|scan-expected-)/.test(name)
        || name === 'decisions.txt' || name === 'pr-url.txt'
        || name === 'empty-scan-count.txt' || name === 'merge-failure-count.txt') {
        rmSync(join(paths.queueDir, name), { force: true })
      }
    }
    if (!preserveTaskMarkers) {
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
   * A stopped loop deliberately keeps its cycle state so it can resume after an
   * environment repair. That state belongs only to the branch which created it;
   * carrying it onto another branch could skip scans or resume a completed gate.
   */
  function initializeSessionStateForBranch(): void {
    const currentBranch = git(['branch', '--show-current']).trim()
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
    const branch = git(['branch', '--show-current']).trim()
    if (branch === '') {
      reportGateFailure('could not get branch name; PR skipped', true)
      return false
    }
    let pushRemote: string
    let baseRemote: string
    try {
      pushRemote = currentBranchPushRemote(paths.repoRoot)
      baseRemote = currentBranchTrackingRemote(paths.repoRoot)
      const hasUpstream = git([
        'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
      ]).trim() !== ''
      execFileSync('git', [
        'push', '--quiet', ...(hasUpstream ? [] : ['--set-upstream']), pushRemote, branch,
      ], {
        cwd: paths.repoRoot,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      reportGateFailure(`could not push branch: ${errorSummary(error)}`, true)
      return false
    }

    const baseRef = git([
      'symbolic-ref', '--quiet', '--short', `refs/remotes/${baseRemote}/HEAD`,
    ]).trim()
    if (!baseRef.startsWith(`${baseRemote}/`)) {
      reportGateFailure(`could not get ${baseRemote} default branch; PR skipped`, true)
      return false
    }
    const baseBranch = baseRef.slice(baseRemote.length + 1)
    try {
      gitIn(paths.repoRoot, ['fetch', baseRemote, baseBranch, '--quiet'])
    } catch (error) {
      reportGateFailure(`could not fetch ${baseRef}: ${errorSummary(error)}`, true)
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
        reportGateFailure(`could not check PR status: ${errorSummary(error)}`, true)
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
          reportGateFailure(`could not read PR body: ${errorSummary(error)}`, true)
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
          reportGateFailure(`could not update PR ${generatedBody ? 'body' : 'title'}: ${errorSummary(error)}`, true)
        }
        return false
      }
      writeFileSync(prUrlFile, `${status.url}\n`)
      previousGateFailures.delete('draft-pr')
      return true
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
      reportGateFailure(`could not compare branch with ${baseRef}: ${errorSummary(error)}`, true)
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
      return true
    } catch (error) {
      if (!(error instanceof ForgeRateLimitError)) {
        reportGateFailure(`could not create PR: ${errorSummary(error)}`, true)
      }
      return false
    }
  }

  /** The CI verdict for the cycle gate: success / failure / pending / unknown. */
  async function checkPrCiStatus(): Promise<'success' | 'failure' | 'pending' | 'unknown'> {
    const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
    if (prUrl === '') return 'unknown'
    let status
    try {
      status = await forge.prStatus({ kind: 'url', value: prUrl })
    } catch (error) {
      if (!(error instanceof ForgeRateLimitError)) {
        reportGateFailure(
          `could not check PR CI status: ${errorSummary(error)}`,
          true,
          'ci-status',
        )
      }
      return 'unknown'
    }
    previousGateFailures.delete('ci-status')
    if (status.state === 'none') return 'unknown'
    if (status.state === 'merged') return 'success'
    const checks = newestChecksByName(status.checks)
    if (checks.length === 0) {
      // Silence cannot prove success: workflows may be delayed or misconfigured. Only a
      // project that explicitly declares it expects no CI checks may clear this gate.
      return project.ciChecksExpected === false ? 'success' : 'unknown'
    }
    if (checks.some((check) => check.conclusion === 'pending')) return 'pending'
    if (checks.some((check) => check.conclusion === 'failure')) return 'failure'
    return 'success'
  }

  function generateCiFixTask(cycle: number, prUrl: string, failSummary: string): void {
    const fixId = newTaskId(paths, `ci-fix-c${cycle}`, now())
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
  }

  /** After the final gate: promote the draft PR and print LOOP_DONE. */
  async function postLoopPr(): Promise<boolean> {
    if (!(await ensureDraftPr('final'))) return false
    if (emptyRun) {
      marker('LOOP_DONE: no changes')
      event('Completed', 'Loop', 'no changes')
      return true
    }
    const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
    if (prUrl === '') return false
    const branch = git(['branch', '--show-current']).trim()
    let status
    try {
      status = await forge.prStatus({ kind: 'branch', value: branch })
      previousGateFailures.delete('pr-status-before-promotion')
    } catch (error) {
      if (!(error instanceof ForgeRateLimitError)) {
        reportGateFailure(
          `could not check PR status before promotion: ${errorSummary(error)}`,
          true,
          'pr-status-before-promotion',
        )
      }
      return false
    }
    if (status.isDraft) {
      try {
        await forge.markPrReady(branch)
        previousGateFailures.delete('pr-promotion')
      } catch (error) {
        if (!(error instanceof ForgeRateLimitError)) {
          reportGateFailure(
            `could not promote PR: ${errorSummary(error)}`,
            true,
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
            true,
            'pr-status-after-promotion',
          )
        }
        return false
      }
    }
    if (status.state !== 'open' || status.isDraft) return false
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

    const runStep = (cwd: string, command: string, timeout?: number): boolean => {
      try {
        const out = execShellSync(command, {
          cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true, timeout,
        })
        appendFileSync(suiteLog, out)
        return true
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string }
        appendFileSync(suiteLog, `${failed.stdout ?? ''}${failed.stderr ?? ''}`)
        return false
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
      if (!runStep(paths.repoRoot, probe.command, probe.timeoutMs)) {
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
        if (!runStep(join(paths.repoRoot, step.cwd), repair.command)) {
          event('WARN', 'repair command could not restore the toolchain')
        }
      }
      ok = runStep(join(paths.repoRoot, step.cwd), step.command)
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
    if (listTaskIds(paths).some((taskId) => readStatus(paths, taskId)?.status === 'completed'
      && !existsSync(join(scannedDir, taskId)))) {
      gateWaitTarget = 'completion scan'
      return 'continue'
    }
    if (config.issueQueueEnabled) {
      if (knownOpenFindings === null) {
        gateWaitTarget = 'finding status'
        return 'continue'
      }
      try {
        const openFindings = knownOpenFindings ?? await forge.listOpenIssues(LABEL_FINDING)
        const openIssues = openFindings.filter((issue) =>
          !issue.labels.includes(LABEL_UNTRUSTED_AUTHOR)
            && issue.labels.some((label) => [
              LABEL_READY, LABEL_IN_PROGRESS, LABEL_MERGE_READY, LABEL_MERGE_FAILED,
            ].includes(label)))
        const pendingIssueNumbers: number[] = []
        for (const issue of openIssues) {
          if (issuePromotionForIssue(paths, issue.number) !== undefined) continue
          try {
            const comments = await commentsForIssue(issue)
            const mergeSha = comments
              .filter((comment) => comment.author.hasWriteAccess)
              .map((comment) => /^MERGED: [^\r\n]+\r?\nMerged as ([0-9a-f]{40,64}) into run branch /i.exec(comment.body)?.[1])
              .find((sha) => sha !== undefined
                && git(['merge-base', '--is-ancestor', sha, 'HEAD'], 'ancestor') === 'ancestor')
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

    const currentScans = readCount(scanCountFile)

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

          const currentTip = git(['rev-parse', 'HEAD']).trim()
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
            try {
              generateCiFixTask(currentScans, prUrl, failSummary)
            } catch (error) {
              event('WARN', `could not enqueue CI fix: ${errorSummary(error)}`)
              return 'continue'
            }
            writeFileSync(ciFixFlag, `${attempts + 1}\n`)
            rmSync(completeFlag, { force: true })
          } else {
            event('ERROR', `CI still failing after ${attempts} fixes; stopping the loop`)
            writeFileSync(stopFile, '')
          }
          return 'continue'
        }
        if (emptyPrGate) {
          writeFileSync(resumeFlag, '')
        } else if (config.autoReview) {
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
    const requestedScans = [1, 2, 3, 4].includes(config.scanParallel) ? config.scanParallel : 2
    let nScans = requestedScans
    let sectionGroups: number[][] = []
    if (nScans > 1) {
      let sections: number[]
      try {
        sections = numberedScanSections(scanSpecification('scan', ''))
      } catch (error) {
        event('ERROR', `scan-template.md is unusable: it must contain unique numbered Markdown headings outside fenced code blocks (${errorSummary(error)})`)
        writeFileSync(stopFile, '')
        return 'continue'
      }
      if (sections.length === 0) {
        event('WARN', `scan-template.md has no numbered sections; requested ${requestedScans} parallel scans, running one full scan`)
        nScans = 1
      } else {
        sectionGroups = partitionScanSections(sections, nScans)
      }
    }
    writeFileSync(join(paths.queueDir, `scan-expected-${nextCycle}`), `${nScans}\n`)
    writeFileSync(scanCountFile, `${nextCycle}\n`)

    // Round-robin groups cover every discovered section exactly once while keeping
    // group sizes within one, without assuming what any section asks the scan to do.
    for (let i = 1; i <= nScans; i++) {
      const scanId = newTaskId(paths, 'scan', now())
      const scope = nScans === 1
        ? 'Perform the full scan described below.'
        : `This scan runs alongside ${nScans - 1} partner scan(s). Perform only sections ${sectionGroups[i - 1]!.join(', ')}; the partners cover the rest. Stay inside them — overlapping findings merge away, duplicated reading does not.`
      writeFileSync(specFile(paths, scanId), scanSpecification(scanId, scope))
      try {
        await startTask(paths, runner, scanId, {
          effort: config.scanEffort as 'high',
          model: config.scanModel === '' ? undefined : config.scanModel,
          setup: project.scanWorktreeSetup,
        })
        event('Started', shortTaskId(scanId), `scan ${i}/${nScans}`)
      } catch (error) {
        event('WARN', `scan startup failed: ${errorSummary(error)} (log: ${shortLogPath(logFile(paths, scanId))})`)
      }
    }
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
    const currentBranch = git(['branch', '--show-current']).trim()
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

    // Label setup is a remote prerequisite, not a prerequisite for observing and
    // advancing local work. If it is unavailable, keep this poll local-only and
    // retry initialization on the next poll.
    const remoteOperationsAvailable = await initializeIssueQueue()

    let burstFailures = 0
    const mergeAttempts = new Set<string>()
    const locallyRunningIssues = new Set<number>()
    let issueReconciliationPending = false

    const reconcileMergedIssues = async (
      taskId: string,
      linkedIssues: number[],
      mergeCommit: string,
      runBranch: string,
    ): Promise<boolean> => {
      try {
        recordIssuePromotions(paths, taskId, mergeCommit, runBranch)
        for (const linkedIssue of linkedIssues) {
          const promotion = issuePromotionForIssue(paths, linkedIssue)
          if (promotion === undefined) throw new Error('promotion record was not persisted')
          if (!remoteOperationsAvailable || promotion.commentConfirmed === true) continue

          const expectedComment = issueMergeComment(taskId, mergeCommit, runBranch)
          let comments = await forge.listIssueComments(linkedIssue)
          if (!comments.some((comment) =>
            comment.author.hasWriteAccess && comment.body === expectedComment)) {
            await commentOnIssueMerge(forge, linkedIssue, taskId, mergeCommit, runBranch)
            comments = await forge.listIssueComments(linkedIssue)
          }
          if (!comments.some((comment) =>
            comment.author.hasWriteAccess && comment.body === expectedComment)) {
            throw new Error('merge comment is not visible after publishing it')
          }
          confirmIssuePromotion(paths, linkedIssue)
        }
        return true
      } catch (error) {
        if (!(error instanceof ForgeRateLimitError)) {
          const subject = linkedIssues.length === 1
            ? `issue #${linkedIssues[0]}`
            : `issues ${linkedIssues.map((number) => `#${number}`).join(' ')}`
          event('WARN', `could not reconcile ${subject} after merging ${shortTaskId(taskId)}: ${errorSummary(error)}`)
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
      mergeAttempts.add(taskId)
      const mergeLog = join(paths.logsDir, `${taskId}.merge.log`)
      const linkedIssues = issueNumbersForTask(paths, taskId)
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
          forge: rawForge,
          outputFile: mergeLog,
          orchestrationDepsRuntime,
          onOrchestrationDepsEvent: orchestrationDepsEvent,
          onMergeStart: () => event('Merging', shortTaskId(taskId)),
          onMergeSkipped: (reason) => event(
            'Skipped', shortTaskId(taskId),
            reason === 'active' ? 'merge already in progress' : 'merge already succeeded',
          ),
          onNoChange: async () => {
            if (linkedIssues.length > 0) {
              await Promise.all(linkedIssues.map((issueNumber) =>
                closeIssueAndRemoveLifecycleLabels(forge, issueNumber,
                  `Task ${taskId} completed without commits after reporting that no change was warranted.`)))
            }
            recordIssueCompletions(paths, taskId, 'no-change')
          },
        })
        if (mergeResult.outcome === 'no-change') {
          event('No-change', shortTaskId(taskId), 'no change warranted')
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
        writeFileSync(mergeFailureFile, '0\n')
        if (linkedIssues.length > 0) {
          const runBranch = git(['branch', '--show-current']).trim()
          await reconcileMergedIssues(taskId, linkedIssues, mergeCommit, runBranch)
        }
        // A task delegated while the gate was waiting merges commits the gate has
        // already pushed past; clearing the flag makes the gate push and verify
        // again with the new commits included.
        if (!isInspectionTaskId(paths, taskId)) {
          const cycle = readCount(scanCountFile)
          if (cycle > 0) rmSync(join(paths.queueDir, `cycle-complete-${cycle}`), { force: true })
        }
      } catch (error) {
        if (error instanceof NoChangeReconciliationError) {
          event('WARN', `could not reconcile no-change task ${shortTaskId(taskId)}: ${error.message}`)
          issueReconciliationPending = true
          return
        }
        if (error instanceof MergeError) appendFileSync(mergeLog, `${error.message}\n`)
        if (error instanceof OrchestrationDepsInstallError) throw error
        event('Failed', shortTaskId(taskId), `log ${shortLogPath(mergeLog)}`)
        if (error instanceof RebaseConflictError) {
          noteMergeFailure(mergeLog)
          try {
            const terminalized = await transitionStatus(paths, taskId, 'completed', 'failed')
            if (!terminalized) {
              throw new Error('task status changed before rebase-conflict abandonment')
            }
            if (linkedIssues.length > 0) {
              prepareIssueReleaseIntent(paths, taskId, linkedIssues)
            }
            cleanupTask(paths, taskId, undefined, false)
            if (linkedIssues.length === 0) {
              dropClaimedTaskMaterialization(paths, taskId)
            } else {
              completeIssueReleaseIntent(paths, taskId)
              dropClaimedTaskMaterialization(paths, taskId, true)
              if (remoteOperationsAvailable) {
                const failures = await reconcileIssueReleaseIntent(forge, paths, taskId)
                if (failures.length > 0) {
                  throw new IssueReleaseReconciliationError(failures)
                }
              }
            }
            if (linkedIssues.length === 0) {
              event('Abandoned', shortTaskId(taskId), 'rebase conflict')
            } else if (remoteOperationsAvailable) {
              event('Released', shortTaskId(taskId), 'rebase conflict abandoned')
            } else {
              event('Abandoned', shortTaskId(taskId), 'rebase conflict; issue release pending')
            }
          } catch (abandonmentError) {
            if (!(abandonmentError instanceof ForgeRateLimitError)) {
              event('WARN', `${shortTaskId(taskId)} rebase conflict was abandoned but cleanup or issue release failed: ${errorSummary(abandonmentError)}`)
            }
          }
          return
        }
        const abandoned = noteMergeFailure(mergeLog)
        if (abandoned && linkedIssues.length > 1 && remoteOperationsAvailable) {
          try {
            const terminalized = await transitionStatus(paths, taskId, 'completed', 'failed')
            if (!terminalized) {
              throw new Error(`task status changed before grouped merge abandonment`)
            }
            await Promise.all(linkedIssues.map((issueNumber) =>
              returnIssueToReady(forge, issueNumber, true)))
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
      const before = readStatus(paths, taskId)
      if (before === undefined) continue
      const status = before.status === 'running'
        ? (await refreshTask(paths, taskId))?.status
        : before.status
      if (status === undefined) continue
      const wasDeadAtStartup = tasksDeadAtStartup.delete(taskId)

      if (status === 'merged' && config.issueQueueEnabled) {
        const mergedStatus = readStatus(paths, taskId)
        const linkedIssues = issueNumbersForTask(paths, taskId)
        if (linkedIssues.length > 0
          && mergedStatus?.merge_commit !== undefined
          && mergedStatus.run_branch !== undefined) {
          const reconciled = await reconcileMergedIssues(
            taskId, linkedIssues, mergedStatus.merge_commit, mergedStatus.run_branch,
          )
          if (!reconciled) break
        }
      }

      const linkedIssues = status === 'running' ? issueNumbersForTask(paths, taskId) : []
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

      // A task whose process is gone without the completion marker used to pass in
      // silence. Say so, once per task, and keep the count for the gate to report.
      const failedFlag = join(scannedDir, `${taskId}.failed`)
      const failedIssues = status === 'failed' ? issueNumbersForTask(paths, taskId) : []
      if (failedIssues.length > 0 && remoteOperationsAvailable) {
        try {
          await Promise.all(failedIssues.map((issueNumber) =>
            returnIssueToReady(forge, issueNumber, true)))
          dropClaimedTaskMaterialization(paths, taskId)
          event('Released', shortTaskId(taskId), 'grouped task failed')
        } catch (releaseError) {
          if (!(releaseError instanceof ForgeRateLimitError)) {
            event('WARN', `${shortTaskId(taskId)} failed and its grouped issues could not all be released: ${errorSummary(releaseError)}`)
          }
        }
      }
      if (status === 'failed' && !existsSync(failedFlag)) {
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
        if (!wasDeadAtStartup) burstFailures += 1
      }

      const scannedFlag = join(scannedDir, taskId)
      if (status === 'completed' && !existsSync(scannedFlag)
        && (!config.issueQueueEnabled || remoteOperationsAvailable)) {
        const depthFile = join(scannedDir, `${taskId}.depth`)
        const depth = existsSync(depthFile) ? readCount(depthFile) : 0

        if (config.workerMode) {
          event('Completed', shortTaskId(taskId))
          const linkedIssues = issueNumbersForTask(paths, taskId)
          if (linkedIssues.length === 0) {
            event('WARN', `worker task ${shortTaskId(taskId)} has no linked issue`)
            continue
          }
          try {
            await publishWorkerCompletion(taskId, linkedIssues)
            writeFileSync(scannedFlag, '')
          } catch (error) {
            if (!(error instanceof ForgeRateLimitError)) {
              event('WARN', `could not publish ${shortTaskId(taskId)}: ${errorSummary(error)}`)
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
        if (issueReconciliationPending || existsSync(stopFile)) break
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

    let running = countRunning()

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
          )
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
            for (const issues of groupReadyFindings(readyIssues)) {
              if (capacity <= 0) break
              const result = await claimIssueGroup(
                forge, paths, issues, cachedUser, appendClaimedRequirements,
              )
              if (result.outcome === 'claimed') {
                event('Claimed', shortTaskId(result.taskId),
                  result.issueNumbers.map((issueNumber) => `#${issueNumber}`).join(' '))
                if (result.pendingMerge) await mergeCompletedTask(result.taskId)
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
              } else if (result.outcome === 'unparseable') {
                if (!decisionAlreadyRecorded(result.reason)) {
                  appendFileSync(decisionsFile, `${result.reason}\n`)
                }
                event('ERROR', result.reason)
                writeFileSync(stopFile, '')
                break
              }
            }
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
        try {
          await startTask(paths, runner, entry.taskId, {
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
          const issueNumbers = issueNumbersForTask(paths, entry.taskId)
          if (config.issueQueueEnabled && issueNumbers.length > 0) {
            let released = false
            if (remoteOperationsAvailable) {
              try {
                if (cachedUser === undefined) cachedUser = await forge.currentUser()
                if (issueNumbers.length > 1) {
                  await Promise.all(issueNumbers.map((issueNumber) =>
                    returnIssueToReady(forge, issueNumber, true)))
                } else {
                  await releaseIssueClaim(forge, issueNumbers[0]!, cachedUser)
                }
                released = true
                event('Released', shortTaskId(entry.taskId), 'startup failed')
              } catch (releaseError) {
                if (!(releaseError instanceof ForgeRateLimitError)) {
                  event('WARN', `${shortTaskId(entry.taskId)} startup failed and issues ${issueNumbers.map((number) => `#${number}`).join(' ')} could not all be released: ${errorSummary(releaseError)}`)
                }
              }
            }
            if (released) {
              try {
                cleanupTask(paths, entry.taskId, undefined, false)
                dropClaimedTaskMaterialization(paths, entry.taskId)
              } catch (cleanupError) {
                event('WARN', `${shortTaskId(entry.taskId)} startup cleanup failed: ${errorSummary(cleanupError)}`)
              }
            } else {
              requeueAfterStartupFailure(entry.taskId, entry.depth, error)
              // Do not dequeue the same retained materialization again in this poll.
              // The next poll retries the release while keeping the forge claim linked.
              break
            }
          } else {
            if (readStatus(paths, entry.taskId) === undefined) {
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
      .filter((taskId) => isScanTaskId(taskId) && readStatus(paths, taskId)?.status === 'running')
      .length
    const runningTasks = Math.max(0, running - scans)
    const queue = queueLength()
    const counters = [
      ...(scans > 0 ? [`Scan=${scans}`] : []),
      `Task=${runningTasks}`,
      `Queue=${queue}`,
    ]
    const waitingFor: string[] = []
    if (scans === 0 && runningTasks === 0 && queue === 0) {
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
    const idle = scans === 0 && runningTasks === 0 && queue === 0
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
      throw error
    }
  }

  return {
    // exported for the daemon
    poll: guardedPoll,
    initializeIssueQueue,
    validatePushTarget,
    initializeSessionStateForBranch,
    cleanupSessionState,
    restartSubject: () => restartSubject,
    // exported for tests
    actionableFindings,
    recordScanYield,
    foldScanYields,
    scanForNextTasks,
    collectDecisions,
    decisionIdentifiers,
    decisionAlreadyRecorded,
    noteMergeFailure,
    workerBranchReport,
    adoptRemoteTasks,
    cycleIsFinal,
    runAutoReview,
    runCycleSuite,
    triggerScanIfIdle,
    checkPrCiStatus,
    ensureDraftPr,
    postLoopPr,
    countAllTasks,
    dequeueNext,
  }
}

export type Loop = ReturnType<typeof createLoop>
