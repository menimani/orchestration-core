import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync,
  statSync, writeFileSync,
} from 'node:fs'
import { join, relative, toNamespacedPath } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { loadForge } from './adapters/forge.ts'
import { loadRunner, type ReasoningEffort } from './adapters/runner.ts'
import { operatingSystem, type OperatingSystem } from './adapters/os.ts'
import { currentProcessStartIdentity, lockOwnerIsCurrent } from './processOwner.ts'
import {
  currentProcessMarkerPid, processMarker, processMarkerText,
} from './processMarker.ts'
import { cleanupTask } from './cleanup.ts'
import { runCleanupCommand } from './cleanupCommand.ts'
import { waitForCi } from './ciWait.ts'
import { loadConfig, type LoopConfig } from './config.ts'
import { createLoop, formatEventLine } from './loop.ts'
import { loopLogLines, prepareLoopLog } from './loopLog.ts'
import { followLog } from './logFollower.ts'
import {
  closeIssueAndRemoveLifecycleLabels, commentOnIssueMerge, issueNumbersForTask,
  missingRequirementCompletionMarkers, recordIssueCompletions, recordIssuePromotions,
} from './issueQueue.ts'
import {
  mergeTask, MergeError, orchestrationDepsRuntimeForPackage,
  syncOrchestrationDepsAtStartup,
} from './merge.ts'
import { deploy } from './deploy.ts'
import {
  isScanTaskId, logFile, orchPaths, packageFile, packageScriptCommand, type OrchPaths,
} from './paths.ts'
import { pruneTasks } from './prune.ts'
import { branchAcceptsCommits, runPreCommitChecks } from './preCommit.ts'
import { runReportUpstreamCommand } from './reportUpstreamCommand.ts'
import { listTaskIds, refreshAll, refreshTask } from './refresh.ts'
import { readStatus } from './status.ts'
import { startTask } from './start.ts'
import {
  liveTaskProcesses, orphanedWorktreeDirectories, terminateLiveTaskProcesses,
  worktreeHolderHint, type TaskProcessTermination,
} from './taskProcesses.ts'
import {
  delegateTaskVisible, enqueueTask, isLoopRunning, newTaskSpec, removeIssueModeMarker,
  writeIssueModeMarker,
} from './tasks.ts'
import { observeNextPoll } from './wake.ts'
import { runWorkerCommand } from './worker.ts'
import {
  loopRestartPredecessorPid, publishLoopReplacementPid, signalLoopRestartReady,
  startLoopReplacement,
} from './restart.ts'
import {
  prepareBranchTopology, prepareIntegrationWorktree,
} from './branchTopology.ts'
import { LOOP_STARTUP_RESULT_FILE_ENV } from './internalEnvironment.ts'

// The command surface: each package.json script dispatches here with the command name
// as the first argument. CLI tokens such as `Enqueued:`, `Created:`, `CYCLE_COMPLETE:`,
// `FAILED:`, and `LOOP_DONE:` are frozen contracts that skills and tests key on.

type Command = (paths: OrchPaths, args: string[]) => Promise<number>

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high'])

async function loadProject(pathsRoot: string) {
  const projectModule = await import('./adapters/project.ts')
  return projectModule.loadProject(pathsRoot)
}

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}

interface RecoveryLockOwner {
  pid: number
  startIdentity?: string | null
  acquiredAt: string
  token: string
}

const RECOVERY_LOCK_STALE_MS = 10_000
const RECOVERY_LOCK_TIMEOUT_MS = 10_000
const RECOVERY_LOCK_POLL_MS = 10
const LOOP_STARTUP_TIMEOUT_MS = 30_000

interface LoopStartupResult {
  status: 'ready' | 'error'
  pid: number
  error?: string
}

function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return (message.split(/\r?\n/, 1)[0] ?? '').trim() || 'unknown error'
}

function publishLoopStartupResult(
  resultFile: string | undefined,
  result: LoopStartupResult,
): void {
  if (resultFile === undefined || resultFile === '') return
  writeFileSync(resultFile, `${JSON.stringify(result)}\n`, { flag: 'wx' })
}

async function waitForLoopStartup(
  daemon: Awaited<ReturnType<OperatingSystem['launchDaemon']>>,
  resultFile: string,
): Promise<LoopStartupResult> {
  const deadline = Date.now() + LOOP_STARTUP_TIMEOUT_MS
  let spawnError: string | undefined
  const onError = (error: Error): void => { spawnError = errorSummary(error) }
  daemon.onError(onError)
  try {
    for (;;) {
      if (existsSync(resultFile)) {
        try {
          const result = JSON.parse(readFileSync(resultFile, 'utf8')) as LoopStartupResult
          if (result.pid !== daemon.pid) {
            try {
              daemon.terminate()
            } catch (error) {
              return {
                status: 'error',
                pid: daemon.pid,
                error: `daemon published an unexpected PID (${result.pid}); `
                  + `cleanup failed: ${errorSummary(error)}`,
              }
            }
            return {
              status: 'error',
              pid: daemon.pid,
              error: `daemon published an unexpected PID (${result.pid})`,
            }
          }
          if (result.status === 'ready') return result
          if (result.status === 'error') {
            while (daemon.isAlive() && Date.now() < deadline) await sleep(10)
            if (daemon.isAlive()) {
              try {
                daemon.terminate()
              } catch (error) {
                return {
                  ...result,
                  error: `${result.error ?? 'daemon initialization failed'}; `
                    + `cleanup failed: ${errorSummary(error)}`,
                }
              }
            }
            return result
          }
        } catch {
          // The child may still be completing its single status-file write.
        }
      }
      if (spawnError !== undefined) {
        return { status: 'error', pid: daemon.pid, error: spawnError }
      }
      if (!daemon.isAlive()) {
        return {
          status: 'error',
          pid: daemon.pid,
          error: 'daemon exited before reporting startup readiness',
        }
      }
      if (Date.now() >= deadline) {
        try {
          daemon.terminate()
        } catch (error) {
          return {
            status: 'error',
            pid: daemon.pid,
            error: 'daemon did not initialize before the startup timeout; '
              + `cleanup failed: ${errorSummary(error)}`,
          }
        }
        return {
          status: 'error',
          pid: daemon.pid,
          error: 'daemon did not initialize before the startup timeout',
        }
      }
      await sleep(10)
    }
  } finally {
    daemon.offError(onError)
    rmSync(resultFile, { force: true })
  }
}

function recoveryLockOwner(recoveryLock: string): RecoveryLockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(recoveryLock, 'owner.json'), 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const owner = parsed as Partial<RecoveryLockOwner>
    if (!Number.isSafeInteger(owner.pid) || (owner.pid ?? 0) <= 0
      || (owner.startIdentity !== undefined && owner.startIdentity !== null
        && (typeof owner.startIdentity !== 'string' || owner.startIdentity === ''))
      || typeof owner.acquiredAt !== 'string' || typeof owner.token !== 'string'
      || owner.token === '') return undefined
    return owner as RecoveryLockOwner
  } catch {
    return undefined
  }
}

function reclaimRecoveryLock(recoveryLock: string): boolean {
  const owner = recoveryLockOwner(recoveryLock)
  if (owner !== undefined && lockOwnerIsCurrent(owner.pid, owner.startIdentity)) return false
  if (owner === undefined) {
    try {
      if (Date.now() - statSync(recoveryLock).mtimeMs < RECOVERY_LOCK_STALE_MS) return false
    } catch {
      return false
    }
  }
  try {
    // Once the owner file is removed, the empty-directory removal either wins or a
    // successor publishes its non-empty candidate. It never removes that successor.
    rmSync(toNamespacedPath(join(recoveryLock, 'owner.json')), { force: true })
    rmdirSync(toNamespacedPath(recoveryLock))
    return true
  } catch {
    return false
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function acquireRecoveryLock(recoveryLock: string): Promise<() => void> {
  const owner: RecoveryLockOwner = {
    pid: process.pid,
    startIdentity: currentProcessStartIdentity(),
    acquiredAt: new Date().toISOString(),
    token: randomUUID(),
  }
  const candidate = `${recoveryLock}.candidate-${process.pid}-${owner.token}`
  const deadline = Date.now() + RECOVERY_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      // Metadata exists before the atomic publish, so an observer cannot mistake the
      // acquisition window for a crashed ownerless lock.
      mkdirSync(candidate)
      writeFileSync(join(candidate, 'owner.json'), `${JSON.stringify(owner)}\n`, { flag: 'wx' })
      renameSync(candidate, recoveryLock)
      return () => {
        if (recoveryLockOwner(recoveryLock)?.token !== owner.token) return
        try {
          rmSync(toNamespacedPath(join(recoveryLock, 'owner.json')), { force: true })
          rmdirSync(toNamespacedPath(recoveryLock))
        } catch {
          // Ownership has already ended or a successor won the publication race.
        }
      }
    } catch (error) {
      operatingSystem.removeDirectory(candidate)
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error
    }

    if (reclaimRecoveryLock(recoveryLock)) continue
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for stale loop PID recovery lock')
    }
    await sleep(RECOVERY_LOCK_POLL_MS)
  }
}

function reportTaskProcessTermination(
  result: TaskProcessTermination,
  report: (line: string) => void,
  announceEmpty: boolean,
): boolean {
  for (const task of result.terminated) {
    report(formatEventLine('Stopped', task.taskId, `process tree PID ${task.pid}`))
  }
  for (const failure of result.failures) {
    report(formatEventLine(
      'ERROR', failure.taskId,
      `could not stop process tree PID ${failure.pid}: ${failure.error}`,
    ))
  }
  if (announceEmpty && result.terminated.length === 0 && result.failures.length === 0) {
    report(formatEventLine('Stopped', 'tasks', 'no live process trees'))
  }
  return result.failures.length === 0
}

const cmdInit: Command = async (paths, args) => {
  if (args.length > 1) {
    console.error('Usage: init [project-name]')
    return 1
  }
  const config = loadConfig()
  const forge = await loadForge(config.forge, paths.repoRoot)
  const { initializeRepository } = await import('./initialize.ts')
  const result = await initializeRepository(paths, forge, args[0])
  return result.ok ? 0 : 1
}

const cmdPreCommit: Command = async (paths, args) => {
  if (args.length !== 0) {
    console.error('Usage: pre-commit')
    return 1
  }
  const project = await loadProject(paths.root)
  const ok = branchAcceptsCommits(paths.repoRoot)
    && runPreCommitChecks(paths.repoRoot, project)
  return ok ? 0 : 1
}

const cmdVerifySetup: Command = async (paths, args) => {
  if (args.length !== 0) {
    console.error('Usage: verify-setup')
    return 1
  }
  const config = loadConfig()
  const forge = await loadForge(config.forge, paths.repoRoot)
  const { verifyRepositorySetup } = await import('./setup.ts')
  return await verifyRepositorySetup(paths, forge, { env: process.env }) ? 0 : 1
}

const cmdNew: Command = async (paths, args) => {
  const taskId = args[0]
  if (taskId === undefined) {
    console.error('Usage: new <task-id>')
    return 1
  }
  const file = newTaskSpec(paths, taskId)
  console.log(`Created: ${file}`)
  return 0
}

const cmdEnqueue: Command = async (paths, args) => {
  const taskId = args[0]
  if (taskId === undefined) {
    console.error('Usage: enqueue <task-id> [depth]')
    return 1
  }
  const depth = args[1] !== undefined && /^\d+$/.test(args[1]) ? Number(args[1]) : 0
  const result = enqueueTask(paths, taskId, depth)
  if (result.outcome === 'already-queued') {
    console.log(`WARN: ${taskId} is already in the queue`)
  } else if (result.outcome === 'already-processed') {
    console.log(`WARN: ${taskId} has already been processed or is running (status=${result.status}) — skipping`)
  } else {
    console.log(`Enqueued: ${taskId} (depth=${depth})`)
  }
  return 0
}

const cmdDelegate: Command = async (paths, args) => {
  let description = ''
  let effort: ReasoningEffort | undefined
  let inspect = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--effort') {
      const value = args[++i]
      if (value === undefined || !EFFORTS.has(value)) {
        console.error('ERROR: --effort must be minimal, low, medium or high')
        return 1
      }
      effort = value as ReasoningEffort
    } else if (arg === '--inspect') {
      inspect = true
    } else if (description !== '') {
      console.error('ERROR: only one description is accepted; quote it as a single argument')
      return 1
    } else {
      description = arg
    }
  }
  if (description.trim() === '') {
    console.error('Usage: delegate "<description>" [--effort minimal|low|medium|high] [--inspect]')
    return 1
  }

  const result = await delegateTaskVisible(paths, description, { effort, inspect }, {
    loadForge: async () => {
      const config = loadConfig()
      return loadForge(config.forge, paths.repoRoot)
    },
    warn: (message) => console.warn(message),
  })
  if (result.enqueue === undefined) {
    console.log(`Delegated through issue #${result.issue.issueNumber}; the loop daemon owns local materialization.`)
    return 0
  }
  if (result.specReused) {
    console.log(`Reusing existing specification: ${result.spec}`)
  } else {
    console.log(`Created: ${result.spec}`)
  }
  if (effort !== undefined) console.log(`Effort override: ${effort}`)
  if (inspect) console.log('Marked as an inspection: no commits expected')
  if (result.enqueue.outcome === 'enqueued') {
    console.log(`Enqueued: ${result.taskId} (depth=0)`)
  } else if (result.enqueue.outcome === 'already-queued') {
    console.log(`WARN: ${result.taskId} is already in the queue`)
  }
  if (isLoopRunning(paths)) {
    console.log('The loop is running and starts this task on its next poll.')
  } else {
    console.log('The loop is not running. The task waits in the backlog until the loop starts,')
    console.log(`or run the start command with ${result.taskId} to run it now.`)
  }
  return 0
}

const cmdReportUpstream: Command = async (paths, args) => {
  return runReportUpstreamCommand(paths, args, {
    stdinIsTerminal: process.stdin.isTTY === true,
    output: (message) => console.log(message),
    error: (message) => console.error(message),
    confirm: async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        const answer = await rl.question('File this issue? [y/N] ')
        return answer === 'y' || answer === 'Y'
      } finally {
        rl.close()
      }
    },
    loadForge: async () => {
      const config = loadConfig()
      return loadForge(config.forge, paths.repoRoot)
    },
  })
}

const cmdStart: Command = async (paths, args) => {
  const taskId = args[0]
  if (taskId === undefined) {
    console.error('Usage: start <task-id> [--effort minimal|low|medium|high] [--model <model>]')
    return 1
  }
  const config = loadConfig()
  let effort = config.taskEffort
  let model = config.taskModel
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--effort') {
      const value = args[++i]
      if (value === undefined || !EFFORTS.has(value)) {
        console.error('Error: --effort must be minimal, low, medium or high')
        return 1
      }
      effort = value as ReasoningEffort
    } else if (args[i] === '--model') {
      model = args[++i] ?? ''
    } else {
      console.error(`Error: unknown option: ${args[i]}`)
      return 1
    }
  }
  const runner = await loadRunner(config.runner, config)
  const project = await loadProject(paths.root)
  const result = await startTask(paths, runner, taskId, {
    effort,
    model: model === '' ? undefined : model,
    setup: isScanTaskId(taskId) ? project.scanWorktreeSetup : undefined,
    report: (line) => console.log(line),
  })
  if (result.outcome === 'already-running') {
    console.log(`[start] ${taskId} is already running (skipping)`)
  }
  return 0
}

const cmdStatus: Command = async (paths, args) => {
  const taskId = args[0]
  if (taskId !== undefined) {
    const status = await refreshTask(paths, taskId)
    if (status === undefined) {
      console.error(`Task not found: ${taskId}`)
      return 1
    }
    console.log(`${taskId.padEnd(20)} ${status.status.padEnd(10)} pid=${status.pid ?? ''}`)
    return 0
  }
  const lines = await refreshAll(paths)
  if (lines.length === 0) {
    console.log('There are no running or completed tasks.')
    return 0
  }
  for (const line of lines) console.log(line)
  return 0
}

const cmdLogs: Command = async (paths, args) => {
  const taskId = args[0]
  if (taskId === undefined) {
    console.error('Usage: logs <task-id> [-f]')
    return 1
  }
  const log = logFile(paths, taskId)
  if (!existsSync(log)) {
    console.error(`Log not found: ${log}`)
    return 1
  }
  if (args[1] === '-f') {
    await followLog(log, process.stdout)
    return 0
  }
  process.stdout.write(readFileSync(log, 'utf8'))
  return 0
}

const cmdDeploy: Command = async (paths, args) => {
  if (args.length !== 0) {
    console.error('Usage: deploy')
    return 1
  }
  const config = loadConfig()
  const project = await loadProject(paths.root)
  if (project.deployment === undefined) {
    console.error(`Project '${project.name}' does not define a deployment.`)
    return 1
  }
  const ref = execFileSync('git', ['branch', '--show-current'], {
    cwd: paths.repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
  const forge = await loadForge(config.forge, paths.repoRoot)
  const result = await deploy(project.deployment, ref, forge)
  console.log(`Workflow run ${result.run.id} completed successfully.`)
  console.log(`${result.verified ? 'PASS' : 'FAIL'}: deployed revision verification; expected=${result.expectedRevision} actual=${result.deployedRevision || '(missing)'}`)
  return result.verified ? 0 : 1
}

const cmdMerge: Command = async (paths, args) => {
  const taskId = args[0]
  if (taskId === undefined) {
    console.error('Usage: merge <task-id> [--yes] [--test-cmd "cmd"]')
    return 1
  }
  let autoYes = false
  let testCmd: string | undefined
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--yes') autoYes = true
    else if (args[i] === '--test-cmd') testCmd = args[++i]
    else {
      console.error(`Unknown option: ${args[i]}`)
      return 1
    }
  }
  const config = loadConfig()
  if (!autoYes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`Merge task/${taskId} into the current branch? [y/N] `)
    rl.close()
    if (answer !== 'y' && answer !== 'Y') {
      console.log('Aborted.')
      return 0
    }
  }
  try {
    const linkedIssues = issueNumbersForTask(paths, taskId)
    const missingMarkers = missingRequirementCompletionMarkers(paths, taskId)
    if (missingMarkers.length > 0) {
      throw new MergeError(`Grouped task is missing requirement completion markers for ${missingMarkers.map((number) => `#${number}`).join(', ')}.`)
    }
    const forge = linkedIssues.length === 0
      ? undefined
      : await loadForge(config.forge, paths.repoRoot)
    const mergeResult = await mergeTask(paths, taskId, {
      taskGate: config.taskGate,
      testCmd: testCmd ?? (config.testCmd === '' ? undefined : config.testCmd),
      skipAutoTest: config.skipAutoTest,
      project: await loadProject(paths.root),
      closesIssues: linkedIssues,
      forge,
      onMergeStart: () => console.log(`Merging ${taskId}`),
      onMergeSkipped: (reason) => console.log(
        `Skipped ${taskId}: ${reason === 'active' ? 'merge already in progress' : 'merge already succeeded'}`,
      ),
      onNoChange: async () => {
        if (linkedIssues.length > 0) {
          await Promise.all(linkedIssues.map((linkedIssue) =>
            closeIssueAndRemoveLifecycleLabels(forge!, linkedIssue,
              `Task ${taskId} completed without commits after reporting that no change was warranted.`)))
        }
        // Keep completion persistence inside the retryable reconciliation phase. Once
        // mergeTask writes no-change and removes the worktree there is no merge retry.
        recordIssueCompletions(paths, taskId, 'no-change')
      },
    })
    if (mergeResult.outcome === 'merged') {
      // A completed manual merge proves the previous failures are no longer consecutive.
      // Clear the durable streak immediately, before optional forge bookkeeping can fail.
      writeFileSync(join(paths.queueDir, 'merge-failure-count.txt'), '0\n')
    }
    if (mergeResult.outcome === 'merged' && linkedIssues.length > 0) {
      const mergeCommit = mergeResult.mergeCommit
      const runBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: paths.repoRoot,
        encoding: 'utf8',
        windowsHide: true,
      }).trim()
      recordIssuePromotions(paths, taskId, mergeCommit, runBranch)
      for (const linkedIssue of linkedIssues) {
        try {
          await commentOnIssueMerge(forge!, linkedIssue, taskId, mergeCommit, runBranch)
        } catch (error) {
          console.error(
            `WARN: could not link issue #${linkedIssue} to its merge: ${(error as Error).message}`,
          )
        }
      }
    }
    return 0
  } catch (error) {
    if (error instanceof MergeError) {
      console.error(error.message)
      return 1
    }
    throw error
  }
}

const cmdCleanup: Command = async (paths, args) => {
  let config: LoopConfig | undefined
  const cleanupConfig = (): LoopConfig => config ??= loadConfig()
  return runCleanupCommand(paths, args, {
    issueQueueEnabled: () => cleanupConfig().issueQueueEnabled,
    loadForge: () => loadForge(cleanupConfig().forge, paths.repoRoot),
    cleanup: cleanupTask,
    error: (message) => console.error(message),
  })
}

const cmdPrune: Command = async (paths, args) => {
  let days = 14
  let dryRun = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days') {
      const value = args[++i]
      if (value === undefined || !/^\d+$/.test(value)) {
        console.error('ERROR: --days requires a number')
        return 1
      }
      days = Number(value)
    } else if (args[i] === '--dry-run') {
      dryRun = true
    } else {
      console.error('Usage: prune [--days N] [--dry-run]')
      return 1
    }
  }
  const report = pruneTasks(paths, { days, dryRun })
  for (const kept of report.kept) console.log(kept)
  for (const removed of report.removed) {
    console.log(`${dryRun ? 'would remove' : 'removed'}: ${removed}`)
  }
  console.log(`Pruned the artifacts of ${report.prunedTasks} finished tasks older than ${days} days.`)
  if (dryRun) console.log('Dry run: nothing was actually deleted.')
  return 0
}

const cmdQueue: Command = async (paths) => {
  const backlog = join(paths.queueDir, 'backlog.txt')
  console.log('=== Queue (backlog) ===')
  const lines = existsSync(backlog)
    ? readFileSync(backlog, 'utf8').split(/\r?\n/).filter((line) => line !== '')
    : []
  if (lines.length === 0) {
    console.log('  (empty)')
  } else {
    for (const line of lines) {
      const sep = line.indexOf(':')
      console.log(`  ${line.slice(0, sep).padEnd(30)} depth=${line.slice(sep + 1)}`)
    }
  }
  console.log('')
  console.log('=== Task Status ===')
  return cmdStatus(paths, [])
}

const cmdLoopStatus: Command = async (paths) => {
  // A compact answer to "is it running, and what is in flight". Always exits 0 so it
  // is safe to embed in a skill preamble.
  const pidFile = join(paths.queueDir, 'loop.pid')
  const ownerPid = existsSync(pidFile)
    ? currentProcessMarkerPid(readFileSync(pidFile, 'utf8'))
    : undefined
  if (ownerPid !== undefined) {
    console.log(`loop: running (PID=${ownerPid})`)
  } else {
    console.log('loop: not running')
  }

  const backlog = join(paths.queueDir, 'backlog.txt')
  const queued = existsSync(backlog)
    ? readFileSync(backlog, 'utf8').split(/\r?\n/).filter((line) => line !== '').length
    : 0
  console.log(queued === 0 ? 'queued: none' : `queued: ${queued}`)

  // Only tasks that still need a decision; merged and cleaned-up ones need none.
  console.log('in flight:')
  let found = false
  for (const taskId of listTaskIds(paths)) {
    const status = readStatus(paths, taskId)?.status
    if (status === 'running' || status === 'completed' || status === 'failed') {
      console.log(`  ${taskId.padEnd(46)} ${status}`)
      found = true
    }
  }
  if (!found) console.log('  (nothing)')
  return 0
}

const cmdStop: Command = async (paths) => {
  writeFileSync(join(paths.queueDir, 'stop'), '')
  const stopped = terminateLiveTaskProcesses(paths)
  const success = reportTaskProcessTermination(stopped, console.log, true)
  console.log('Created the stop file. The loop will exit on the next poll.')
  return success ? 0 : 1
}

const cmdLoop: Command = async (paths, args) => {
  const loopLog = join(paths.logsDir, 'loop.log')
  if (args[0] === '--daemon' || args[0] === '-d') {
    // run-branch.txt is updated by the child after this descriptor is opened. Use the
    // branch it is about to record so a new run rotates immediately, not on its restart.
    const configuredIntegrationBranch = loadConfig().integrationBranch
    const runBranch = configuredIntegrationBranch || execFileSync(
      'git', ['branch', '--show-current'], {
        cwd: paths.repoRoot,
        encoding: 'utf8',
        windowsHide: true,
      },
    ).trim()
    prepareLoopLog(paths, { runBranch })
    const markerLog = join(paths.logsDir, 'loop-markers.log')
    const startupResultFile = join(
      paths.logsDir,
      `.loop-startup-${process.pid}-${randomUUID()}.json`,
    )
    const daemonArgs = [packageFile('src', 'cli.ts'), 'loop', '--marker-output', markerLog]
    // The daemon must work on the repository this launcher was pointed at. Starting it
    // in the package directory instead made it resolve its own checkout as the
    // repository, which put the startup dependency install inside the very package the
    // daemon runs from — `npm ci` deletes node_modules first, so a suite launching a
    // daemon deleted its own dependencies mid-run. The script path is absolute, so the
    // working directory is free to be the repository.
    const daemon = await operatingSystem.launchDaemon({
      args: daemonArgs,
      command: process.execPath,
      cwd: paths.repoRoot,
      env: { ...process.env, [LOOP_STARTUP_RESULT_FILE_ENV]: startupResultFile },
      outputFile: loopLog,
    })
    const daemonPid = daemon.pid
    const startup = await waitForLoopStartup(daemon, startupResultFile)
    if (startup.status === 'error') {
      console.error(`Could not start the loop: ${startup.error ?? 'unknown error'}`)
      console.error(`Log: ${loopLog}`)
      return 1
    }
    daemon.release()
    console.log(`Started the loop in the background (PID=${daemonPid})`)
    console.log(`Log: ${loopLog}`)
    console.log(`Check: ${packageScriptCommand(paths.repoRoot, 'loop-status')}`)
    console.log(`Stop: ${packageScriptCommand(paths.repoRoot, 'stop')}`)
    return 0
  }
  const markerOutput = args[0] === '--marker-output' ? args[1] : undefined
  const startupResultFile = process.env[LOOP_STARTUP_RESULT_FILE_ENV]
  delete process.env[LOOP_STARTUP_RESULT_FILE_ENV]
  let startupReported = false
  const reportStartup = (result: LoopStartupResult): void => {
    if (startupReported) return
    startupReported = true
    publishLoopStartupResult(startupResultFile, result)
  }
  const scanCountFile = join(paths.queueDir, 'scan-count.txt')
  let config: LoopConfig | undefined
  let startupError: string | undefined
  const log = (message: string, error = false): void => {
    if (startupError === undefined && message.startsWith('ERROR:')) {
      startupError = message.slice('ERROR:'.length).trim()
    }
    const write = error ? console.error : console.log
    const currentCycle = existsSync(scanCountFile)
      ? Number(readFileSync(scanCountFile, 'utf8').trim()) || 0
      : 0
    for (const line of loopLogLines(message, {
      currentCycle,
      cycleCap: config?.maxScanCycles ?? 0,
    })) write(line)
  }
  const marker = (message: string): void => {
    if (markerOutput === undefined) console.log(message)
    else appendFileSync(markerOutput, `${message}\n`)
  }
  try {
    config = loadConfig()
    const result = await runLoopDaemon(paths, log, marker, config, () => {
      reportStartup({
        status: 'ready',
        pid: operatingSystem.processTreeRootPid(),
      })
    })
    if (result !== 0) {
      reportStartup({
        status: 'error',
        pid: operatingSystem.processTreeRootPid(),
        error: startupError ?? 'daemon initialization failed',
      })
    }
    return result
  } catch (error) {
    const message = errorSummary(error)
    log(`ERROR: ${message}`, true)
    reportStartup({
      status: 'error',
      pid: operatingSystem.processTreeRootPid(),
      error: message,
    })
    return 1
  }
}

const cmdWorker: Command = async (paths, args) => {
  const baseRef = args[0]
  if (baseRef === undefined || args.length !== 1) {
    console.error('Usage: worker <base-ref>')
    return 1
  }
  return await runWorkerCommand(paths, baseRef)
}

const cmdCiWait: Command = async (paths, args) => {
  const prNumber = args[0]
  let timeoutSeconds = 900
  if (prNumber === undefined || !/^\d+$/.test(prNumber)
    || !Number.isSafeInteger(Number(prNumber)) || Number(prNumber) < 1) {
    console.error('Usage: ci-wait <pr-number> [--timeout <seconds>]')
    return 1
  }
  if (args.length > 1) {
    const timeout = args[2]
    if (args.length !== 3 || args[1] !== '--timeout' || timeout === undefined
      || !/^\d+$/.test(timeout) || !Number.isSafeInteger(Number(timeout))) {
      console.error('ERROR: --timeout must be a non-negative number of seconds')
      return 1
    }
    timeoutSeconds = Number(timeout)
  }

  const config = loadConfig()
  const forge = await loadForge(config.forge, paths.repoRoot)
  return waitForCi(forge, Number(prNumber), { timeoutSeconds })
}

async function runLoopDaemon(
  paths: OrchPaths,
  log: (line: string) => void,
  marker: (line: string) => void,
  config: LoopConfig,
  ready: () => void = () => {},
): Promise<number> {
  const daemonPid = operatingSystem.processTreeRootPid()
  const daemonOwner = processMarker(daemonPid)
  const daemonOwnerText = processMarkerText(daemonOwner)
  const pidFile = join(paths.queueDir, 'loop.pid')
  const stopFile = join(paths.queueDir, 'stop')
  const scanCountFile = join(paths.queueDir, 'scan-count.txt')
  const cycleCapFile = join(paths.queueDir, 'cycle-cap.txt')
  const recoveryLock = `${pidFile}.recovery`
  let ownsTaskLifecycle = false
  let ownsDaemonState = true
  const restartPredecessorPid = loopRestartPredecessorPid()
  let usesRestartReservation = false

  // PID lock: one loop per repository.
  for (;;) {
    const releaseRecoveryLock = await acquireRecoveryLock(recoveryLock)
    try {
      try {
        // Creation uses the same mutex as stale recovery so another starter cannot
        // observe the file between its exclusive creation and completed metadata write.
        writeFileSync(pidFile, daemonOwnerText, { flag: 'wx' })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }

      let existingText: string
      try {
        existingText = readFileSync(pidFile, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const existingPid = currentProcessMarkerPid(existingText)
      if (restartPredecessorPid !== undefined
        && existingPid === restartPredecessorPid) {
        usesRestartReservation = true
        break
      }
      if (existingPid !== undefined) {
        log(`ERROR: Loop is already running (PID=${existingPid}). Please stop and restart.`)
        return 1
      }
      log('WARN: Removing stale PID file')
      rmSync(pidFile, { force: true })
    } finally {
      releaseRecoveryLock()
    }
  }
  const releaseDaemonState = (): void => {
    if (!ownsDaemonState) return
    try {
      removeIssueModeMarker(paths, daemonPid)
    } catch {
      // nothing to release
    }
    try {
      if (readFileSync(pidFile, 'utf8') === daemonOwnerText) {
        rmSync(pidFile, { force: true })
      }
    } catch {
      // nothing to release
    }
  }
  const stopOwnedTaskProcesses = (announceEmpty: boolean): boolean => {
    if (!ownsTaskLifecycle) return true
    return reportTaskProcessTermination(
      terminateLiveTaskProcesses(paths),
      log,
      announceEmpty,
    )
  }
  process.on('exit', releaseDaemonState)
  const stopOnSignal = (): void => {
    process.exit(stopOwnedTaskProcesses(true) ? 0 : 1)
  }
  process.on('SIGINT', stopOnSignal)
  process.on('SIGTERM', stopOnSignal)

  try {
    const foreignTasks = liveTaskProcesses(paths)
    const orphanedWorktrees = orphanedWorktreeDirectories(paths)
    if (foreignTasks.length > 0 || orphanedWorktrees.length > 0) {
      for (const task of foreignTasks) {
        log(formatEventLine(
          'ERROR', 'task', task.taskId,
        ))
        log(formatEventLine(
          'ERROR', 'process', `foreign live process tree PID ${task.pid}`,
        ))
        log(formatEventLine(
          'ERROR', 'startup',
          'terminate or adopt the foreign task before starting',
        ))
      }
      for (const worktree of orphanedWorktrees) {
        const displayedWorktree = relative(paths.repoRoot, worktree)
        log(formatEventLine(
          'ERROR', 'orphan', displayedWorktree,
        ))
        log(formatEventLine(
          'ERROR', 'worktree', 'has no task status; something may still hold it',
        ))
        log(formatEventLine(
          'ERROR', 'diagnose',
          worktreeHolderHint(displayedWorktree),
        ))
      }
      return 1
    }
    ownsTaskLifecycle = true

    // During a restart the predecessor stays visible and owns both markers until this
    // process has completed initialization. The predecessor publishes this PID as one
    // atomic handover after observing the ready signal.
    if (!usesRestartReservation) {
      writeIssueModeMarker(paths, config.issueQueueEnabled, daemonPid)
    }
    log(formatEventLine(
      'Started', 'core', config.coreAutoUpdate ? 'auto-update on' : 'auto-update off',
    ))

    // A stale stop file is cleared only after the PID lock is taken, so another
    // instance's signal is never removed.
    rmSync(stopFile, { force: true })
    if (!existsSync(scanCountFile)) writeFileSync(scanCountFile, '0\n')
    writeFileSync(cycleCapFile, `${config.maxScanCycles}\n`)

    syncOrchestrationDepsAtStartup(
      paths,
      (name, subject) => log(name === 'Installed'
        ? formatEventLine(name, 'orchestration deps', subject)
        : formatEventLine(name, subject)),
    )
    const topology = prepareBranchTopology(paths, config.integrationBranch)
    const loopPaths = topology.paths
    const forge = await loadForge(config.forge, loopPaths.repoRoot)
    const runner = await loadRunner(config.runner, config)
    const projectModule = await import('./adapters/project.ts')
    const projectRoot = topology.integrationBranch === undefined
      ? paths.root
      : join(loopPaths.repoRoot, relative(paths.repoRoot, paths.root))
    const monitoredProject = await projectModule.loadMonitoredProject(projectRoot)
    if (topology.integrationBranch !== undefined) {
      prepareIntegrationWorktree(
        loopPaths,
        monitoredProject.project.integrationWorktreeSetup ?? [],
        (line) => log(formatEventLine('Preparing', 'integration', line)),
      )
    }
    const loop = createLoop({
      paths: loopPaths,
      config,
      forge,
      runner,
      project: monitoredProject.project,
      projectAdapterChanged: monitoredProject.sourceChanged,
      orchestrationDepsRuntime: orchestrationDepsRuntimeForPackage(topology.packageRoot),
      branchGuard: topology.validateDaemonCheckout,
      prepareIntegrationWorktree: topology.integrationBranch === undefined
        ? undefined
        : () => prepareIntegrationWorktree(
            loopPaths,
            monitoredProject.project.integrationWorktreeSetup ?? [],
            (line) => log(formatEventLine('Preparing', 'integration', line)),
          ),
      log,
      marker,
      now: () => new Date(),
    })

    if (!loop.validatePushTarget()) return 1
    await loop.initializeIssueQueue()

    loop.initializeSessionStateForBranch()
    signalLoopRestartReady()
    ready()

    for (;;) {
      // Observe first: delegation may append after poll() returns but before this
      // process begins waiting, and that edge must not cost a full poll interval.
      const wake = observeNextPoll(paths, config.pollIntervalSeconds)
      let outcome: Awaited<ReturnType<typeof loop.poll>>
      try {
        outcome = await loop.poll()
      } catch (error) {
        wake.cancel()
        throw error
      }
      if (outcome === 'continue' && existsSync(stopFile)) outcome = 'stopped'
      if (outcome !== 'continue') {
        wake.cancel()
        await wake.outcome
        if (outcome === 'stopped' && !stopOwnedTaskProcesses(true)) return 1
        if (outcome === 'restart') {
          if (!stopOwnedTaskProcesses(false)) return 1
          // Node has no portable exec(2). Keep this live PID published while the
          // replacement initializes, then atomically transfer ownership after its
          // explicit ready signal.
          const readyFile = join(
            paths.queueDir,
            `loop.restart-${daemonPid}-${Date.now()}.ready`,
          )
          const replacement = await startLoopReplacement(readyFile, {
            onReady: (replacementPid) => {
              // Once the child PID is published, neither finally nor the process exit
              // handler may race it with the predecessor's read-then-remove cleanup.
              process.off('exit', releaseDaemonState)
              try {
                writeIssueModeMarker(paths, config.issueQueueEnabled, replacementPid)
                publishLoopReplacementPid(pidFile, daemonPid, replacementPid)
                ownsDaemonState = false
              } catch (error) {
                try {
                  writeIssueModeMarker(paths, config.issueQueueEnabled, daemonPid)
                } finally {
                  process.on('exit', releaseDaemonState)
                }
                throw error
              }
            },
            outputFile: join(paths.logsDir, 'loop.log'),
          })
          if (!replacement.ok) {
            log(formatEventLine(
              'ERROR', 'restart', `replacement could not start: ${replacement.error ?? 'unknown error'}`,
            ))
            return 1
          }
          log(formatEventLine(
            'Restarted', loop.restartSubject(), `replacement PID ${replacement.pid}`,
          ))
        }
        return 0
      }
      await wake.outcome
    }
  } catch (error) {
    stopOwnedTaskProcesses(false)
    throw error
  } finally {
    releaseDaemonState()
  }
}

const cmdShipped: Command = async (paths, args) => {
  const pr = args[0]
  if (pr === undefined || args.length !== 1) {
    console.error('Usage: shipped <pr-number-or-url>')
    return 1
  }
  const isPositiveNumber = /^#?\d+$/.test(pr) && BigInt(pr.replace(/^#/, '')) > 0n
  let reference = isPositiveNumber ? `#${pr.replace(/^#/, '')}` : undefined
  if (reference === undefined && !/[\u0000-\u001f\u007f]/.test(pr)) {
    try {
      const url = new URL(pr)
      if (/^https?:\/\//i.test(pr)
        && (url.protocol === 'http:' || url.protocol === 'https:')
        && url.hostname !== '') {
        reference = url.href
      }
    } catch {
      // A non-URL may still be a valid numeric reference, handled above.
    }
  }
  if (reference === undefined) {
    console.error('A shipped reference must be a positive PR number or absolute HTTP(S) URL.')
    return 1
  }
  if (isLoopRunning(paths)) {
    console.error('The loop is running and records its own ending; shipped is for runs promoted by hand.')
    return 1
  }
  const config = loadConfig()
  const scanCountFile = join(paths.queueDir, 'scan-count.txt')
  const cycleCapFile = join(paths.queueDir, 'cycle-cap.txt')
  const currentCycle = existsSync(scanCountFile)
    ? Number(readFileSync(scanCountFile, 'utf8').trim()) || 0
    : 0
  const cycleCap = existsSync(cycleCapFile)
    ? Number(readFileSync(cycleCapFile, 'utf8').trim())
    : config.maxScanCycles
  mkdirSync(paths.logsDir, { recursive: true })
  const lines = loopLogLines(formatEventLine('Completed', 'Loop', `PR ${reference}`), {
    currentCycle,
    cycleCap,
  })
  appendFileSync(join(paths.logsDir, 'loop.log'), `${lines.join('\n')}\n`)
  appendFileSync(join(paths.logsDir, 'loop-markers.log'), `LOOP_DONE: ${reference}\n`)
  console.log(`Recorded: Completed Loop PR ${reference}`)
  return 0
}

const commands: Record<string, Command> = {
  'init': cmdInit,
  'pre-commit': cmdPreCommit,
  'verify-setup': cmdVerifySetup,
  'new': cmdNew,
  'enqueue': cmdEnqueue,
  'delegate': cmdDelegate,
  'report-upstream': cmdReportUpstream,
  'start': cmdStart,
  'status': cmdStatus,
  'logs': cmdLogs,
  'deploy': cmdDeploy,
  'merge': cmdMerge,
  'cleanup': cmdCleanup,
  'prune': cmdPrune,
  'queue': cmdQueue,
  'loop': cmdLoop,
  'worker': cmdWorker,
  'ci-wait': cmdCiWait,
  'loop-status': cmdLoopStatus,
  'shipped': cmdShipped,
  'stop': cmdStop,
}

async function main(): Promise<number> {
  const [commandName, ...args] = process.argv.slice(2)
  if (commandName === undefined || commandName === '') {
    console.error(`Usage: npm run <command>\nAvailable: ${Object.keys(commands).join(', ')}`)
    return 1
  }
  const command = commands[commandName]
  if (command === undefined) {
    console.error(`Unknown command: '${commandName}'.`)
    console.error(`Available commands: ${Object.keys(commands).join(', ')}`)
    return 1
  }
  const paths = orchPaths(repoRoot())
  try {
    return await command(paths, args)
  } catch (error) {
    console.error((error as Error).message)
    return 1
  }
}

process.exitCode = await main()
