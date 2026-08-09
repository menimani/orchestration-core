import { execFileSync } from 'node:child_process'
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Forge } from './adapters/forge.ts'
import type { ProjectAdapter } from './adapters/project.ts'
import type { Runner } from './adapters/runner.ts'
import type { LoopConfig } from './config.ts'
import {
  existingTaskIdForDesc, taskIdForDesc, newTaskId, recordTaskIdForDesc,
} from './ids.ts'
import { mergeRemoteTask, mergeTask, MergeError } from './merge.ts'
import {
  finalMessageFile, isInspectionTaskId, isReviewTaskId, isScanTaskId, logFile,
  branchName, worktreeDir, type OrchPaths,
} from './paths.ts'
import { buildPrBody, GENERATED_BODY_MARKER, prTitle } from './prbody.ts'
import { refreshTask, listTaskIds } from './refresh.ts'
import { readStatus } from './status.ts'
import { startTask } from './start.ts'
import { enqueueTask, newTaskSpec, specFile } from './tasks.ts'
import { pitfallsFileForDesc } from './gates.ts'
import {
  claimIssue, commentOnIssueMerge, heartbeatIssueForTask, issueMergeComment,
  issueNumberForTask, issuePromotionForIssue, publishFinding, reapStaleLeases,
  recordIssueForTask, recordIssuePromotion,
  reconcileFindingFingerprints, unresolvedFindings, LABEL_IN_PROGRESS, LABEL_MERGE_FAILED,
  LABEL_MERGE_READY, LABEL_READY,
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
  now: () => Date
}

interface QueueEntry {
  taskId: string
  depth: number
}

export function createLoop(deps: LoopDeps) {
  const { paths, config, forge, runner, project, log, now } = deps
  const queueFile = join(paths.queueDir, 'backlog.txt')
  const stopFile = join(paths.queueDir, 'stop')
  const scannedDir = join(paths.queueDir, 'scanned')
  const scanCountFile = join(paths.queueDir, 'scan-count.txt')
  const emptyScanFile = join(paths.queueDir, 'empty-scan-count.txt')
  const mergeFailureFile = join(paths.queueDir, 'merge-failure-count.txt')
  const runBranchFile = join(paths.queueDir, 'run-branch.txt')
  const decisionsFile = join(paths.queueDir, 'decisions.txt')
  const prUrlFile = join(paths.queueDir, 'pr-url.txt')

  mkdirSync(scannedDir, { recursive: true })
  if (!existsSync(queueFile)) writeFileSync(queueFile, '')

  // Resolved once per process; the login cannot change under a running loop.
  let cachedUser: string | undefined

  function readCount(file: string): number {
    if (!existsSync(file)) return 0
    const raw = readFileSync(file, 'utf8').replace(/[\s\r\n]/g, '')
    return /^\d+$/.test(raw) ? Number(raw) : 0
  }

  function git(args: string[]): string {
    try {
      return execFileSync('git', args, {
        cwd: paths.repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
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

  async function publishWorkerCompletion(taskId: string, issueNumber: number): Promise<void> {
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
      if (!isInspectionTaskId(paths, taskId)) {
        throw new Error(`${taskId} has no commits and is not an inspection task`)
      }
      await forge.closeIssue(issueNumber,
        `Inspection task ${taskId} completed without commits.`)
      log(`[loop] Closed issue #${issueNumber} after inspection ${taskId}`)
      return
    }

    const branch = branchName(taskId)
    gitIn(worktree, ['push', 'origin', branch])
    const head = gitIn(worktree, ['rev-parse', 'HEAD']).trim()
    await forge.commentIssue(issueNumber,
      `Worker completed the task.\nBranch: ${branch}\nHead commit: ${head}`)
    await forge.addLabel(issueNumber, LABEL_MERGE_READY)
    await forge.removeLabel(issueNumber, LABEL_IN_PROGRESS)
    log(`[loop] Published ${branch} at ${head} for issue #${issueNumber}`)
  }

  function workerBranchReport(comments: string[]): { branch: string; head: string } | undefined {
    for (const comment of [...comments].reverse()) {
      const branch = /^Branch: (task\/[A-Za-z0-9][A-Za-z0-9._-]*)$/m.exec(comment)?.[1]
      const head = /^Head commit: ([0-9a-f]{40}(?:[0-9a-f]{24})?)$/m.exec(comment)?.[1]
      if (branch !== undefined && head !== undefined) return { branch, head }
    }
    return undefined
  }

  async function updateAdoptedIssue(
    issueNumber: number,
    taskId: string,
    mergeCommit: string,
    runBranch: string,
  ): Promise<void> {
    const comment = issueMergeComment(taskId, mergeCommit, runBranch)
    if (!(await forge.listIssueComments(issueNumber)).includes(comment)) {
      await commentOnIssueMerge(forge, issueNumber, taskId, mergeCommit, runBranch)
    }
    await forge.removeLabel(issueNumber, LABEL_MERGE_READY)
  }

  async function adoptRemoteTasks(): Promise<void> {
    let issues: Awaited<ReturnType<Forge['listOpenIssues']>>
    try {
      issues = await forge.listOpenIssues(LABEL_MERGE_READY)
    } catch (error) {
      log(`[loop] WARN: could not list merge-ready issues: ${(error as Error).message}`)
      return
    }

    for (const issue of issues) {
      if (existsSync(stopFile)) return
      const mergeLog = join(paths.logsDir, `issue-${issue.number}.merge.log`)
      const adopted = issuePromotionForIssue(paths, issue.number)
      if (adopted !== undefined) {
        try {
          await updateAdoptedIssue(
            issue.number,
            adopted.taskId,
            adopted.mergeCommit,
            adopted.runBranch,
          )
          log(`[loop] Updated issue metadata for adopted remote task #${issue.number}`)
        } catch (error) {
          log(`[loop] WARN: adopted issue #${issue.number}, but could not update it: ${(error as Error).message}`)
        }
        continue
      }
      try {
        const report = workerBranchReport(await forge.listIssueComments(issue.number))
        if (report === undefined) {
          throw new MergeError(`Issue #${issue.number} has no valid worker branch report.`)
        }
        try {
          execFileSync('git', [
            'fetch', 'origin',
            `+refs/heads/${report.branch}:refs/remotes/origin/${report.branch}`,
          ], {
            cwd: paths.repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          })
        } catch {
          throw new MergeError(`Could not fetch ${report.branch} from origin.`)
        }

        const mergeCommit = await mergeRemoteTask(
          paths,
          issue.number,
          report.branch,
          report.head,
          {
            taskGate: config.taskGate,
            testCmd: config.testCmd === '' ? undefined : config.testCmd,
            skipAutoTest: config.skipAutoTest,
            project,
            outputFile: mergeLog,
          },
        )
        writeFileSync(mergeFailureFile, '0\n')
        const taskId = report.branch.slice('task/'.length)
        const runBranch = git(['branch', '--show-current']).trim()
        recordIssueForTask(paths, taskId, issue.number)
        recordIssuePromotion(paths, taskId, mergeCommit, runBranch)
        try {
          await updateAdoptedIssue(issue.number, taskId, mergeCommit, runBranch)
        } catch (error) {
          log(`[loop] WARN: adopted issue #${issue.number}, but could not update it: ${(error as Error).message}`)
        }
        const cycle = readCount(scanCountFile)
        if (cycle > 0) rmSync(join(paths.queueDir, `cycle-complete-${cycle}`), { force: true })
        log(`[loop] Adopted remote task from issue #${issue.number}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        appendFileSync(mergeLog, `${message}\n`)
        log(`[loop] WARN: Remote adoption failure for issue #${issue.number} — Log: ${mergeLog}`)
        try {
          await forge.commentIssue(issue.number, `Remote task adoption failed: ${message}`)
        } catch (commentError) {
          log(`[loop] WARN: could not comment on issue #${issue.number}: ${(commentError as Error).message}`)
        }
        try {
          await forge.addLabel(issue.number, LABEL_MERGE_FAILED)
          await forge.removeLabel(issue.number, LABEL_MERGE_READY)
        } catch (labelError) {
          log(`[loop] WARN: could not relabel issue #${issue.number}: ${(labelError as Error).message}`)
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

  // Merged/failed tasks are finished and do not count, so status files from past
  // sessions cannot consume MAX_TOTAL_TASKS and block new task generation.
  function countAllTasks(): number {
    const active = listTaskIds(paths).filter((taskId) => {
      const status = readStatus(paths, taskId)?.status
      return status === 'running' || status === 'completed'
    }).length
    return queueLength() + active
  }

  function dequeueNext(): QueueEntry | undefined {
    const lines = readFileSync(queueFile, 'utf8').split(/\r?\n/).filter((line) => line !== '')
    const first = lines.shift()
    if (first === undefined) return undefined
    writeFileSync(queueFile, lines.map((line) => `${line}\n`).join(''))
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
    return readFileSync(finalFile, 'utf8').split(/\r?\n/)
      .filter((line) => line.startsWith('NEXT_TASK:'))
      .map((line) => line.replace(/^NEXT_TASK:\s*/, '').trim())
      .filter((desc) => desc !== '' && !hasFormatPlaceholder(desc) && !reportsNothing(desc))
  }

  function appendSharedRequirements(
    newId: string,
    parentId: string,
    desc: string,
    includeDescription = true,
  ): void {
    const parts = [`\n## Auto-generated task (parent: ${parentId})\n`]
    if (includeDescription) parts.push(`\n${desc}\n`)
    const requirements = join(paths.root, 'templates', 'task-requirements.md')
    if (existsSync(requirements)) parts.push(`\n${readFileSync(requirements, 'utf8')}`)
    const pitfalls = pitfallsFileForDesc(paths, desc)
    if (existsSync(pitfalls)) parts.push(`\n${readFileSync(pitfalls, 'utf8')}`)
    appendFileSync(specFile(paths, newId), parts.join(''))
  }

  /**
   * Turn a finished task's NEXT_TASK lines into queued tasks, bounded by depth and
   * total. In issue mode the findings become forge issues instead — the shared
   * backlog other workers can claim — under the same growth bounds.
   */
  async function scanForNextTasks(taskId: string, depth: number): Promise<void> {
    const findings = actionableFindings(finalMessageFile(paths, taskId))
    if (findings.length === 0) return
    const isReview = isReviewTaskId(taskId)

    const newDepth = depth + 1
    if (newDepth > config.maxGrowthDepth) {
      log(`[loop] Growth depth limit reached (${config.maxGrowthDepth}) — ignore NEXT_TASK from ${taskId}`)
      return
    }
    if (countAllTasks() >= config.maxTotalTasks) {
      log(`[loop] Task limit reached (${config.maxTotalTasks}) — NEXT_TASK from ${taskId} will be ignored`)
      return
    }

    if (config.issueQueueEnabled) {
      let pendingFindings = findings
      if (isReview) {
        const filtered = await unresolvedFindings(forge, paths, findings)
        pendingFindings = filtered.unresolved
        for (const duplicate of filtered.duplicates) {
          log(`[loop]   Duplicate finding, existing issue #${duplicate.issueNumber}: ${duplicate.finding}`)
        }
      }
      if (pendingFindings.length === 0) return
      const combinesReviewFindings = isReview && pendingFindings.length > 1
      const descriptions = combinesReviewFindings
        ? [pendingFindings.map((finding, index) => `${index + 1}. ${finding}`).join('\n')]
        : pendingFindings
      for (const desc of descriptions) {
        const effort = isReview ? 'high' : undefined
        const title = combinesReviewFindings ? `Review round fixes (${taskId})` : undefined
        try {
          const result = await publishFinding(
            forge, paths, desc, taskId, effort, title,
            combinesReviewFindings ? pendingFindings : undefined,
          )
          if (result.outcome === 'created') {
            log(`[loop] NEXT_TASK detection: ${desc}`)
            log(`[loop]   → Issue filed: #${result.issueNumber}`)
          } else {
            log(`[loop]   Duplicate finding, existing issue #${result.issueNumber}: ${desc}`)
          }
        } catch (error) {
          log(`[loop] WARN: could not file the finding as an issue: ${(error as Error).message}`)
        }
      }
      return
    }

    const pendingFindings = isReview
      ? [...new Set(findings)].filter((finding) => {
        const existing = existingTaskIdForDesc(paths, 'auto', finding)
        if (existing !== undefined) {
          // A failed task is retryable by design — enqueueTask re-admits it — so only
          // queued, active or landed work suppresses the finding. Suppressing on the
          // bare existence of the spec blocked that supported retry path.
          const status = readStatus(paths, existing)?.status
          const queued = existsSync(queueFile)
            && readFileSync(queueFile, 'utf8').split(/\r?\n/)
              .some((line) => line.startsWith(`${existing}:`))
          if (queued || status === 'running' || status === 'completed' || status === 'merged') {
            log(`[loop]   Duplicate finding, existing task ${existing}: ${finding}`)
            return false
          }
        }
        return true
      })
      : findings
    if (pendingFindings.length === 0) return
    const combinesReviewFindings = isReview && pendingFindings.length > 1
    const descriptions = combinesReviewFindings
      ? [pendingFindings.map((finding, index) => `${index + 1}. ${finding}`).join('\n')]
      : pendingFindings
    for (const desc of descriptions) {
      const newId = taskIdForDesc(paths, 'auto', desc)
      log(`[loop] NEXT_TASK detection: ${desc}`)
      log(`[loop]   → New task: ${newId} (depth=${newDepth})`)
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
      } else {
        log(`[loop]   Reusing existing specification: ${newId}`)
      }
      if (combinesReviewFindings) {
        for (const finding of pendingFindings) {
          recordTaskIdForDesc(paths, 'auto', finding, newId)
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
        const result = enqueueTask(paths, newId, newDepth)
        if (result.outcome === 'enqueued') log(`Enqueued: ${newId} (depth=${newDepth})`)
      } catch {
        // an unenqueueable finding is not worth stopping the poll for
      }
    }
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
        log(`[loop] Ignore DECISION_REQUIRED placeholder: ${text}`)
        continue
      }
      if (decisionAlreadyRecorded(text)) continue
      appendFileSync(decisionsFile, `${text}\n`)
      log(`[loop] DECISION REQUIRED (${taskId}): ${text}`)
    }
  }

  /**
   * Count a merge failure and stop once they stop looking like the work: the task
   * completed and the gate that verifies it could not run. Any successful merge resets
   * the count, so one genuine test failure does not accumulate alongside unrelated ones.
   */
  function noteMergeFailure(mergeLog: string): void {
    const failures = readCount(mergeFailureFile) + 1
    writeFileSync(mergeFailureFile, `${failures}\n`)

    let diagnosis = ''
    if (existsSync(mergeLog)) {
      const text = readFileSync(mergeLog, 'utf8')
      if (text.includes('Could not find a valid Docker environment')) {
        diagnosis = 'Docker is not running, and the integration tests need it'
      } else if (/Could not resolve host|Connection refused|Could not transfer artifact/.test(text)) {
        diagnosis = 'the network or a package registry is unreachable'
      }
    }
    if (diagnosis !== '') log(`[loop]   Looks like ${diagnosis}`)

    if (failures >= config.maxConsecutiveMergeFailures) {
      log(`[loop] ${failures} merges failed in a row (limit ${config.maxConsecutiveMergeFailures}).`)
      log('[loop] Tasks are finishing and their verification is not, so nothing is landing.')
      log('[loop] Stopping: fix what the merge logs name, then merge them by hand and restart.')
      writeFileSync(stopFile, '')
    }
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
    if (actionableFindings(finalMessageFile(paths, taskId)).length > 0) {
      appendFileSync(yieldFile, 'found\n')
    } else {
      appendFileSync(yieldFile, 'empty\n')
      log('[loop]   This scan detected no issues')
    }
  }

  /**
   * Fold the finished cycle's scan records into the empty-scan counter: reset on any
   * finding, increment exactly once when every scan came back empty, untouched when no
   * record exists (no scan finished).
   */
  function foldScanYields(cycle: number): void {
    const yieldFile = join(paths.queueDir, `scan-yield-${cycle}`)
    if (!existsSync(yieldFile)) return
    if (readFileSync(yieldFile, 'utf8').includes('found')) {
      writeFileSync(emptyScanFile, '0\n')
    } else {
      const total = readCount(emptyScanFile) + 1
      writeFileSync(emptyScanFile, `${total}\n`)
      log(`[loop]   Cycle ${cycle} scans found nothing (consecutive ${total}/${config.maxEmptyScans})`)
    }
    rmSync(yieldFile, { force: true })
  }

  function renderTemplate(templateName: string, replacements: Record<string, string>): string | undefined {
    const template = join(paths.root, 'templates', templateName)
    if (!existsSync(template)) {
      log(`[loop] WARN: template not found: ${template}`)
      return undefined
    }
    let text = readFileSync(template, 'utf8')
    for (const [key, value] of Object.entries(replacements)) {
      text = text.replaceAll(`{{${key}}}`, value)
    }
    return text
  }

  function generateScanTask(scanId: string, scope: string): boolean {
    const text = renderTemplate('scan-template.md', { SCAN_ID: scanId, SCAN_SCOPE: scope })
    if (text === undefined) return false
    writeFileSync(specFile(paths, scanId), text)
    return true
  }

  function generateReviewTask(reviewId: string, cycle: number, prUrl: string): boolean {
    const baseBranch = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).trim()
      || 'origin/main'
    const acceptedLimitsFile = join(paths.root, 'accepted-limits.md')
    const acceptedLimits = existsSync(acceptedLimitsFile)
      ? readFileSync(acceptedLimitsFile, 'utf8').trim() || '(none)'
      : '(none)'
    const text = renderTemplate('review-template.md', {
      REVIEW_ID: reviewId,
      CYCLE: String(cycle),
      PR_URL: prUrl === '' ? '(PR URL unknown)' : prUrl,
      BASE_BRANCH: baseBranch,
      ACCEPTED_LIMITS: acceptedLimits,
    })
    if (text === undefined) return false
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
    const yieldFile = join(paths.queueDir, `scan-yield-${cycle}`)
    if (existsSync(yieldFile) && !readFileSync(yieldFile, 'utf8').includes('found')) {
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
      log(`[loop] Review cadence: cycle ${cycle} resumes unreviewed (reviewing every ${config.reviewEveryNCycles} cycles, the final cycle always)`)
      return true
    }

    const maxRounds = isFinal ? config.maxFinalReviewRounds : config.maxReviewRounds
    const rounds = readCount(roundFile)
    const lastId = existsSync(idFile) ? readFileSync(idFile, 'utf8').replace(/[\s\r\n]/g, '') : ''

    if (lastId !== '') {
      const status = readStatus(paths, lastId)?.status
      if (status !== 'completed' && status !== 'merged') {
        // A review that crashed says nothing about the diff. Resuming is the honest
        // outcome: blocking the cycle on it would stall the loop on a broken reviewer.
        log(`[loop] Review ${lastId} ended as '${status ?? 'unknown'}' — resuming without its verdict (cycle=${cycle})`)
        return true
      }
      if (actionableFindings(finalMessageFile(paths, lastId)).length > 0) {
        log(`[loop] Review ${lastId} raised findings — they have been queued as fix tasks (cycle=${cycle})`)
      } else {
        log(`[loop] Review ${lastId} found nothing — cycle ${cycle} passes review`)
        return true
      }
    }

    if (rounds >= maxRounds) {
      if (isFinal) {
        // Promoting here would ship findings nobody resolved — the failure the round
        // cap used to allow. Rounds this persistent signal something structural, which
        // is a person's call, so the loop stops instead of promoting.
        log(`[loop] Final review still raising findings after ${rounds} rounds (cycle=${cycle}).`)
        log('[loop] Stopping rather than promoting a branch its own review keeps rejecting.')
        writeFileSync(stopFile, '')
        return false
      }
      log(`[loop] Review still raising findings after ${rounds} rounds (cycle=${cycle}).`)
      log('[loop] Resuming rather than reviewing the same diff again — a later review reads this work again.')
      return true
    }

    const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
    const reviewId = newTaskId(paths, `review-c${cycle}`, now())
    if (!generateReviewTask(reviewId, cycle, prUrl)) {
      log('[loop] WARN: Could not write the review specification — resuming without review')
      return true
    }
    const effortDir = join(paths.queueDir, 'effort')
    mkdirSync(effortDir, { recursive: true })
    writeFileSync(join(effortDir, reviewId), `${config.reviewEffort}\n`)
    writeFileSync(roundFile, `${rounds + 1}\n`)
    writeFileSync(idFile, `${reviewId}\n`)
    try {
      enqueueTask(paths, reviewId, 0)
      log(`Enqueued: ${reviewId} (depth=0)`)
    } catch {
      // enqueue of a just-written spec cannot fail for a missing spec
    }
    const finalLabel = isFinal ? ' (final)' : ''
    log(`[loop] CI successful — review round ${rounds + 1}/${maxRounds}${finalLabel}: ${reviewId} (cycle=${cycle})`)
    return false
  }

  function cleanupSessionState(preserveTaskMarkers = false): void {
    log('[loop] reset session state')
    for (const name of readdirSync(paths.queueDir)) {
      if (/^(cycle-complete-|cycle-resume-|ci-fix-emitted-|review-round-|review-id-|failed-|scan-yield-)/.test(name)
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
  }

  /**
   * A stopped loop deliberately keeps its cycle state so it can resume after an
   * environment repair. That state belongs only to the branch which created it;
   * carrying it onto another branch could skip scans or resume a completed gate.
   */
  function initializeSessionStateForBranch(): void {
    const currentBranch = git(['branch', '--show-current']).trim()
    if (existsSync(runBranchFile)) {
      const previous = readFileSync(runBranchFile, 'utf8').replace(/[\r\n]/g, '')
      if (previous !== currentBranch) {
        log(`[loop] Branch changed from '${previous}' to '${currentBranch}' — resetting session state`)
        // Status files span branches, so their announcement markers must span branches
        // too; explicit task cleanup removes a marker when a retry is wanted.
        cleanupSessionState(true)
      }
    }
    writeFileSync(runBranchFile, `${currentBranch}\n`)
  }

  function readDecisions(): string[] {
    if (!existsSync(decisionsFile)) return []
    return readFileSync(decisionsFile, 'utf8').split(/\r?\n/).filter((line) => line !== '')
  }

  /** Push the branch and create or update the draft PR. Returns false when no PR exists. */
  async function ensureDraftPr(mode: 'cycle' | 'final'): Promise<boolean> {
    const branch = git(['branch', '--show-current']).trim()
    if (branch === '') {
      log('[loop] WARN: Failed to get branch name, PR skipped')
      return false
    }
    log(`[loop] Pushing branch: ${branch}`)
    try {
      execFileSync('git', ['push', 'origin', branch], {
        cwd: paths.repoRoot,
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      // the gate re-enters and pushes again; a transient push failure is not fatal here
    }

    git(['fetch', 'origin', 'main', '--quiet'])
    const cycle = readCount(scanCountFile)
    const title = prTitle(paths.repoRoot, mode === 'final' ? 'final' : 'cycle',
      { cycle, maxCycles: config.maxScanCycles })

    const status = await forge.prStatus(branch)
    if (status.state === 'open') {
      log(`[loop] Existing PR: ${status.url}`)
      // A body left as created stops at the first cycle's content, so it is rebuilt
      // every cycle — unless a person edited it, which removes the generated marker.
      let body = ''
      try {
        body = await forge.prBody(branch)
      } catch {
        body = ''
      }
      if (body.includes(GENERATED_BODY_MARKER)) {
        try {
          await forge.updatePr(branch, { title, body: buildPrBody(paths.repoRoot, readDecisions()) })
          log('[loop]   Updated PR body')
        } catch {
          log('[loop]   WARN: Failed to update PR body')
        }
      } else {
        log('[loop]   PR body was edited manually; it will not be updated')
      }
      writeFileSync(prUrlFile, `${status.url}\n`)
      return true
    }

    log('[loop] Creating Draft PR...')
    try {
      const url = await forge.createPr({
        branch,
        base: 'main',
        title,
        body: buildPrBody(paths.repoRoot, readDecisions()),
        draft: true,
      })
      log(`[loop] Draft PR created: ${url}`)
      writeFileSync(prUrlFile, `${url}\n`)
      return true
    } catch (error) {
      log(`[loop]   WARN: could not create the PR: ${(error as Error).message}`)
      return false
    }
  }

  /** The CI verdict for the cycle gate: success / failure / pending / unknown. */
  async function checkPrCiStatus(): Promise<'success' | 'failure' | 'pending' | 'unknown'> {
    const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
    if (prUrl === '') return 'unknown'
    let status
    try {
      status = await forge.prStatus(prUrl)
    } catch {
      return 'unknown'
    }
    if (status.state === 'none') return 'unknown'
    if (status.state === 'merged') return 'success'
    if (status.checks.length === 0) {
      // No checks at all: either they have not registered yet, or the push touched only
      // paths no workflow watches. Waiting forever on the second would stall the loop,
      // so silence past the grace window means nothing to verify.
      const pushedAt = git(['log', '-1', '--format=%ct', status.headSha]).trim()
      if (/^\d+$/.test(pushedAt)) {
        const age = Math.floor(now().getTime() / 1000) - Number(pushedAt)
        const grace = Number(process.env['NO_CHECK_GRACE_SECONDS'] ?? '180')
        if (age > grace) return 'success'
      }
      return 'unknown'
    }
    if (status.checks.some((check) => check.conclusion === 'pending')) return 'pending'
    if (status.checks.some((check) => check.conclusion === 'failure')) return 'failure'
    return 'success'
  }

  function generateCiFixTask(cycle: number, prUrl: string, failSummary: string): void {
    const fixId = newTaskId(paths, `ci-fix-c${cycle}`, now())
    const text = renderTemplate('ci-fix-template.md', {
      FIX_ID: fixId,
      CYCLE: String(cycle),
      PR_URL: prUrl === '' ? '(PR URL unknown)' : prUrl,
      FAIL_SUMMARY: failSummary === '' ? '(check the PR checks for details)' : failSummary,
    })
    if (text === undefined) return
    writeFileSync(specFile(paths, fixId), text)
    try {
      enqueueTask(paths, fixId, 0)
    } catch {
      // spec was just written; enqueue cannot miss it
    }
    log(`[loop] CI fix task generation: ${fixId} (cycle=${cycle})`)
  }

  /** After the final gate: promote the draft PR and print LOOP_DONE. */
  async function postLoopPr(): Promise<void> {
    if (!(await ensureDraftPr('final'))) return
    const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
    if (prUrl === '') return
    const branch = git(['branch', '--show-current']).trim()
    const status = await forge.prStatus(branch)
    if (status.isDraft) {
      log(`[loop] Promote Draft PR to ready: ${prUrl}`)
      try {
        await forge.markPrReady(branch)
      } catch {
        // promotion failing is reported by the missing ready state, not a crash
      }
    }
    // The body reflects branch history, so it also lists intermediate changes that were
    // later reverted — the need to rewrite it must be impossible to overlook.
    log(`[loop] LOOP_DONE: ${prUrl} — The body still reflects history and must be rewritten as a final summary.`)
  }

  /**
   * With light task gates each merge proved only that the tree builds, so the full
   * suites run here, once per gate entry, against the tip the cycle actually produced.
   * On failure the loop stops rather than promote a failing tip.
   */
  function runCycleSuite(cycle: number): boolean {
    if (config.taskGate !== 'light') return true
    const suiteLog = join(paths.logsDir, `cycle-suite-${cycle}.log`)
    writeFileSync(suiteLog, '')
    log(`[loop] Cycle suite: full tests against the branch tip (task gates were light) — Log: ${suiteLog}`)

    const runStep = (cwd: string, command: string): boolean => {
      try {
        const out = execFileSync('bash', ['-c', command], {
          cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        appendFileSync(suiteLog, out)
        return true
      } catch (error) {
        const failed = error as { stdout?: string; stderr?: string }
        appendFileSync(suiteLog, `${failed.stdout ?? ''}${failed.stderr ?? ''}`)
        return false
      }
    }

    let ok = true
    for (const step of project.cycleSuite()) {
      if (step.requires !== undefined && !existsSync(join(paths.repoRoot, step.requires))) continue
      // A toolchain that broke in a way reinstalling fixes is the environment, not the
      // branch; the repair keeps the suite's verdict about the code.
      const repair = step.repairWhenMissing
      if (repair !== undefined && !existsSync(join(paths.repoRoot, repair.path))) {
        log(`[loop] Cycle suite: ${repair.message}`)
        if (!runStep(join(paths.repoRoot, step.cwd), repair.command)) {
          log('[loop] WARN: the repair command could not restore the toolchain')
        }
      }
      ok = runStep(join(paths.repoRoot, step.cwd), step.command)
      if (!ok) break
    }

    if (!ok) {
      const logText = existsSync(suiteLog) ? readFileSync(suiteLog, 'utf8') : ''
      if (/is not recognized|command not found|ENOENT/i.test(logText)) {
        log(`[loop] Cycle suite failed because a tool is missing — the environment broke, not the branch. Log: ${suiteLog}`)
      } else {
        log(`[loop] Cycle suite failed — stopping rather than promoting a failing tip. Log: ${suiteLog}`)
      }
      writeFileSync(stopFile, '')
      return false
    }
    log('[loop] Cycle suite passed.')
    return true
  }

  /** The inter-cycle gate and idle scan dispatch. */
  async function triggerScanIfIdle(): Promise<'continue' | 'done'> {
    if (!config.scanEnabled) return 'continue'
    if (countRunning() > 0 || queueLength() > 0) return 'continue'
    if (isScanRunning()) return 'continue'
    if (config.issueQueueEnabled) {
      try {
        const issues = await Promise.all([
          forge.listOpenIssues(LABEL_READY),
          forge.listOpenIssues(LABEL_IN_PROGRESS),
          forge.listOpenIssues(LABEL_MERGE_READY),
        ])
        const openIssues = new Map(issues.flat().map((issue) => [issue.number, issue]))
        const pendingIssues = await Promise.all([...openIssues.values()].map(async (issue) => {
          if (issuePromotionForIssue(paths, issue.number) !== undefined) return undefined
          try {
            const comments = await forge.listIssueComments(issue.number)
            if (comments.some((comment) => /^MERGED: /.test(comment))) return undefined
          } catch (error) {
            log(`[loop] WARN: could not inspect issue #${issue.number} for merge metadata: ${(error as Error).message}`)
          }
          return issue.number
        }))
        const remoteCount = pendingIssues.filter((issueNumber) => issueNumber !== undefined).length
        if (remoteCount > 0) {
          log(`[loop] Waiting for ${remoteCount} remote issue-queue task(s) before entering the cycle gate`)
          return 'continue'
        }
      } catch (error) {
        log(`[loop] WARN: could not count remote issue-queue work: ${(error as Error).message}`)
      }
    }

    const currentScans = readCount(scanCountFile)

    if (currentScans > 0 && (config.autoPr || config.reviewEnabled)) {
      const resumeFlag = join(paths.queueDir, `cycle-resume-${currentScans}`)
      const completeFlag = join(paths.queueDir, `cycle-complete-${currentScans}`)
      const ciFixFlag = join(paths.queueDir, `ci-fix-emitted-${currentScans}`)

      if (!existsSync(resumeFlag)) {
        if (!existsSync(completeFlag)) {
          // A cycle that lost tasks did not do what it set out to do, and the PR cannot
          // show it: work that never ran leaves no diff to notice it by.
          const failedFile = join(paths.queueDir, `failed-${currentScans}`)
          if (existsSync(failedFile)) {
            const failed = readFileSync(failedFile, 'utf8').split(/\r?\n/).filter((line) => line !== '')
            if (failed.length > 0) {
              log(`[loop] Cycle ${currentScans} lost ${failed.length} task(s) to failure; their findings were never applied:`)
              for (const taskId of failed) log(`[loop]   ${taskId}`)
              const lossNote = `Cycle ${currentScans} lost ${failed.length} task(s) to failure, so their findings are not in this branch: ${failed.join(' ')}`
              if (!decisionAlreadyRecorded(lossNote)) {
                appendFileSync(decisionsFile, `${lossNote}\n`)
              }
            }
          }

          if (!runCycleSuite(currentScans)) return 'continue'

          if (config.autoPr) await ensureDraftPr('cycle')
          const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
          log(`[loop] CYCLE_COMPLETE: ${currentScans}/${config.maxScanCycles}${prUrl === '' ? '' : ` PR:${prUrl}`}`)
          writeFileSync(completeFlag, '')
        }

        const ciStatus = config.ciGateEnabled ? await checkPrCiStatus() : 'success'
        if (ciStatus === 'pending' || ciStatus === 'unknown') {
          log(`[loop] CI running (cycle=${currentScans}) ...`)
          return 'continue'
        }
        if (ciStatus === 'failure') {
          const attempts = readCount(ciFixFlag)
          if (attempts < config.maxCiFixAttempts) {
            const prUrl = existsSync(prUrlFile) ? readFileSync(prUrlFile, 'utf8').trim() : ''
            log(`[loop] CI failure — generate fix task ${attempts + 1}/${config.maxCiFixAttempts} (cycle=${currentScans})`)
            let failSummary = ''
            try {
              const status = await forge.prStatus(prUrl)
              failSummary = status.checks.map((check) => `${check.name}: ${check.conclusion}`).join('\n')
            } catch {
              failSummary = ''
            }
            generateCiFixTask(currentScans, prUrl, failSummary)
            writeFileSync(ciFixFlag, `${attempts + 1}\n`)
            rmSync(completeFlag, { force: true })
          } else {
            log(`[loop] CI still failing after ${attempts} fix attempts (cycle=${currentScans}).`)
            log('[loop] Stopping rather than polling a gate that cannot pass on its own.')
            writeFileSync(stopFile, '')
          }
          return 'continue'
        }
        if (config.autoReview) {
          if (!runAutoReview(currentScans, cycleIsFinal(currentScans))) return 'continue'
          writeFileSync(resumeFlag, '')
        } else if (config.reviewEnabled) {
          log(`[loop] CI successful — waiting for review (cycle=${currentScans}) ...`)
          return 'continue'
        } else {
          log(`[loop] CI success — automatic resume (cycle=${currentScans})`)
          writeFileSync(resumeFlag, '')
        }
      }
    }

    foldScanYields(currentScans)

    if (currentScans >= config.maxScanCycles) {
      log(`[loop] Scan cycle limit (${config.maxScanCycles}) has been reached.`)
      if (config.autoPr) await postLoopPr()
      cleanupSessionState()
      log('[loop] End the loop.')
      return 'done'
    }

    const emptyScans = readCount(emptyScanFile)
    if (emptyScans >= config.maxEmptyScans) {
      log(`[loop] The scan did not detect any issues ${emptyScans} times in a row.`)
      log('[loop] Further automatic scanning will end as no harvest is expected.')
      if (config.autoPr) await postLoopPr()
      cleanupSessionState()
      log('[loop] End the loop.')
      return 'done'
    }

    const nextCycle = currentScans + 1
    writeFileSync(scanCountFile, `${nextCycle}\n`)
    const nScans = [1, 2, 3, 4].includes(config.scanParallel) ? config.scanParallel : 2

    // Disjoint groups of the checklist's ten sections, balanced so the deep reads
    // (bugs, tests) do not share a scan at higher parallelism.
    const sectionGroups: Record<number, string[]> = {
      1: [''],
      2: ['1, 2, 5 and 6', '3, 4, 7, 8, 9 and 10'],
      3: ['1 and 2', '3, 4, 5 and 6', '7, 8, 9 and 10'],
      4: ['1 and 2', '5 and 6', '3 and 4', '7, 8, 9 and 10'],
    }
    for (let i = 1; i <= nScans; i++) {
      const scanId = newTaskId(paths, 'scan', now())
      const scope = nScans === 1
        ? 'Perform every numbered section below.'
        : `This scan runs alongside ${nScans - 1} partner scan(s). Perform only sections ${(sectionGroups[nScans] as string[])[i - 1]}; the partners cover the rest. Stay inside them — overlapping findings merge away, duplicated reading does not.`
      log(`[loop] Idle detection → Scan start (cycle=${nextCycle}/${config.maxScanCycles}, scan ${i}/${nScans}): ${scanId}`)
      if (generateScanTask(scanId, scope)) {
        try {
          await startTask(paths, runner, scanId, {
            effort: config.scanEffort as 'high',
            model: config.scanModel === '' ? undefined : config.scanModel,
            setup: project.scanWorktreeSetup,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log(`[loop] WARN: Scan startup failure: ${message} — Log: ${logFile(paths, scanId)}`)
        }
      }
    }
    return 'continue'
  }

  /** One poll iteration. Returns 'stopped' | 'done' | 'continue'. */
  async function poll(): Promise<'stopped' | 'done' | 'continue'> {
    const currentBranch = git(['branch', '--show-current']).trim()
    const recordedBranch = existsSync(runBranchFile)
      ? readFileSync(runBranchFile, 'utf8').replace(/[\r\n]/g, '')
      : ''
    if (currentBranch !== recordedBranch) {
      log(`[loop] ERROR: checkout is on ${currentBranch} but this run belongs to ${recordedBranch} — stopping before anything merges into the wrong branch`)
      writeFileSync(stopFile, '')
      return 'stopped'
    }

    if (existsSync(stopFile)) {
      log('[loop] A stopped file was detected. Exit the loop.')
      rmSync(stopFile, { force: true })
      return 'stopped'
    }

    let burstFailures = 0
    const locallyRunningIssues = new Set<number>()
    for (const taskId of listTaskIds(paths)) {
      const before = readStatus(paths, taskId)
      if (before === undefined) continue
      const status = before.status === 'running'
        ? (await refreshTask(paths, taskId))?.status
        : before.status
      if (status === undefined) continue

      const linkedIssue = status === 'running' ? issueNumberForTask(paths, taskId) : undefined
      if (linkedIssue !== undefined) {
        locallyRunningIssues.add(linkedIssue)
        try {
          await heartbeatIssueForTask(forge, paths, taskId, now())
        } catch (error) {
          log(`[loop] WARN: heartbeat failed for ${taskId}: ${(error as Error).message}`)
        }
      }

      // A task whose process is gone without the completion marker used to pass in
      // silence. Say so, once per task, and keep the count for the gate to report.
      const failedFlag = join(scannedDir, `${taskId}.failed`)
      if (status === 'failed' && !existsSync(failedFlag)) {
        const cycleNow = readCount(scanCountFile)
        log(`[loop] FAILED: ${taskId} — log: ${logFile(paths, taskId)}`)
        appendFileSync(join(paths.queueDir, `failed-${cycleNow}`), `${taskId}\n`)
        writeFileSync(failedFlag, '')
        burstFailures += 1
      }

      const scannedFlag = join(scannedDir, taskId)
      if (status === 'completed' && !existsSync(scannedFlag)) {
        const depthFile = join(scannedDir, `${taskId}.depth`)
        const depth = existsSync(depthFile) ? readCount(depthFile) : 0
        log(`[loop] Completed: ${taskId} (depth=${depth})`)

        if (config.workerMode) {
          const linkedIssue = issueNumberForTask(paths, taskId)
          if (linkedIssue === undefined) {
            log(`[loop] WARN: worker task ${taskId} has no linked issue`)
            continue
          }
          try {
            await publishWorkerCompletion(taskId, linkedIssue)
            writeFileSync(scannedFlag, '')
          } catch (error) {
            log(`[loop] WARN: could not publish ${taskId}: ${(error as Error).message}`)
          }
          continue
        }

        await scanForNextTasks(taskId, depth)
        collectDecisions(taskId)

        recordScanYield(taskId)

        if (config.autoMerge) {
          log(`[loop] Automatic merge: ${taskId}`)
          const mergeLog = join(paths.logsDir, `${taskId}.merge.log`)
          const linkedIssue = issueNumberForTask(paths, taskId)
          try {
            const mergeCommit = await mergeTask(paths, taskId, {
              taskGate: config.taskGate,
              testCmd: config.testCmd === '' ? undefined : config.testCmd,
              skipAutoTest: config.skipAutoTest,
              project,
              closesIssue: linkedIssue,
              outputFile: mergeLog,
            })
            log(`[loop]   Merge successful: ${taskId}`)
            writeFileSync(mergeFailureFile, '0\n')
            if (linkedIssue !== undefined) {
              const runBranch = git(['branch', '--show-current']).trim()
              try {
                recordIssuePromotion(paths, taskId, mergeCommit, runBranch)
                await commentOnIssueMerge(
                  forge,
                  linkedIssue,
                  taskId,
                  mergeCommit,
                  runBranch,
                )
              } catch (error) {
                log(`[loop] WARN: could not link issue #${linkedIssue} to its merge: ${(error as Error).message}`)
              }
            }
            // A task delegated while the gate was waiting merges commits the gate has
            // already pushed past; clearing the flag makes the gate push and verify
            // again with the new commits included.
            if (!isInspectionTaskId(paths, taskId)) {
              const cycle = readCount(scanCountFile)
              if (cycle > 0) rmSync(join(paths.queueDir, `cycle-complete-${cycle}`), { force: true })
            }
          } catch (error) {
            if (error instanceof MergeError) appendFileSync(mergeLog, `${error.message}\n`)
            log(`[loop] WARN: Automerge failure for ${taskId} — Log: ${mergeLog}`)
            noteMergeFailure(mergeLog)
          }
        }
        writeFileSync(scannedFlag, '')
      }
    }

    // Several tasks failing at once is the environment, not the work. Eleven tasks once
    // died together because DNS stopped resolving the Codex endpoint; the loop carried
    // on starting more, and each burned its tokens reaching the same wall.
    if (burstFailures >= config.maxBurstFailures) {
      log(`[loop] ${burstFailures} tasks failed in one poll (limit ${config.maxBurstFailures}).`)
      log('[loop] That pattern is an environment failure — network, credentials, or the runner CLI.')
      log('[loop] Stopping so the cause is fixed before more tasks are spent on it.')
      log('[loop] Recover with: cleanup <task-id> then enqueue <task-id>')
      writeFileSync(stopFile, '')
    }

    if (!config.workerMode && config.issueQueueEnabled && !existsSync(stopFile)) {
      await adoptRemoteTasks()
    }

    let running = countRunning()

    // Nothing new starts while a stop is pending: without this the burst detector above
    // would fill the parallel slots with the very outage it just stopped for.
    if (!existsSync(stopFile)) {
      if (config.issueQueueEnabled) {
        // The shared backlog: reap quiet leases, then claim ready issues into the
        // local queue up to capacity. A forge outage degrades to local-only work for
        // this poll rather than stopping anything.
        try {
          await reconcileFindingFingerprints(forge, paths)
          for (const reaped of await reapStaleLeases(
            forge,
            paths,
            config.issueLeaseHours,
            now(),
            locallyRunningIssues,
          )) {
            log(`[loop] Lease reaped: issue #${reaped} is ready again`)
          }
          let capacity = config.maxParallel - running - queueLength()
          if (capacity > 0) {
            if (cachedUser === undefined) cachedUser = await forge.currentUser()
            for (const issue of await forge.listOpenIssues(LABEL_READY)) {
              if (capacity <= 0) break
              if (issue.assignees.length > 0) continue
              const result = await claimIssue(forge, paths, issue, cachedUser,
                (newTaskId_, requirement) => appendSharedRequirements(newTaskId_, `issue-${issue.number}`, requirement))
              if (result.outcome === 'claimed') {
                log(`[loop] Claimed issue #${issue.number} → task ${result.taskId}`)
                capacity -= 1
              } else if (result.outcome === 'lost-race') {
                log(`[loop]   Lost the claim race for issue #${issue.number}`)
              } else {
                log(`[loop] WARN: issue #${issue.number} has no parseable requirement — left claimed for a person`)
              }
            }
          }
        } catch (error) {
          log(`[loop] WARN: the issue queue is unreachable this poll: ${(error as Error).message}`)
        }
      }

      for (;;) {
        if (running >= config.maxParallel) break
        const entry = dequeueNext()
        if (entry === undefined) break
        writeFileSync(join(scannedDir, `${entry.taskId}.depth`), `${entry.depth}\n`)

        const effortFile = join(paths.queueDir, 'effort', entry.taskId)
        const effort = existsSync(effortFile)
          ? readFileSync(effortFile, 'utf8').replace(/[\s\r\n]/g, '')
          : config.taskEffort
        log(`[loop] Start: ${entry.taskId} (depth=${entry.depth} effort=${effort})`)
        try {
          await startTask(paths, runner, entry.taskId, {
            effort: effort as 'medium',
            model: config.taskModel === '' ? undefined : config.taskModel,
          })
          running += 1
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          log(`[loop] WARN: ${entry.taskId} startup failure: ${message} — Log: ${logFile(paths, entry.taskId)}`)
        }
      }

      if (!config.workerMode) {
        const outcome = await triggerScanIfIdle()
        if (outcome === 'done') return 'done'
      }
    }

    const hhmmss = now().toTimeString().slice(0, 8)
    if (config.workerMode) {
      log(`[loop] ${hhmmss} | Worker Running=${running} Queue=${queueLength()} | Next poll: ${config.pollIntervalSeconds}s`)
    } else {
      const cycle = readCount(scanCountFile)
      log(`[loop] ${hhmmss} | Cycle=${cycle}/${config.maxScanCycles} Running=${running} Queue=${queueLength()} | Next poll: ${config.pollIntervalSeconds}s`)
    }
    return 'continue'
  }

  return {
    // exported for the daemon
    poll,
    initializeSessionStateForBranch,
    cleanupSessionState,
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
