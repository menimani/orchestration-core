import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { loadForge } from './adapters/forge.ts'
import { loadProject } from './adapters/project.ts'
import { loadRunner, type ReasoningEffort } from './adapters/runner.ts'
import { cleanupTask } from './cleanup.ts'
import { waitForCi } from './ciWait.ts'
import { loadConfig, type LoopConfig } from './config.ts'
import { createLoop } from './loop.ts'
import { loopLogLines, prepareLoopLog } from './loopLog.ts'
import {
  commentOnIssueMerge, issueNumberForTask, recordIssuePromotion,
} from './issueQueue.ts'
import { mergeTask, MergeError, syncOrchestrationDepsAtStartup } from './merge.ts'
import { deploy } from './deploy.ts'
import { isScanTaskId, logFile, orchPaths, type OrchPaths } from './paths.ts'
import { pruneTasks } from './prune.ts'
import { listTaskIds, refreshAll, refreshTask } from './refresh.ts'
import { readStatus } from './status.ts'
import { startTask } from './start.ts'
import {
  delegateTaskVisible, enqueueTask, isLoopRunning, newTaskSpec, removeIssueModeMarker,
  writeIssueModeMarker,
} from './tasks.ts'
import { observeNextPoll } from './wake.ts'
import { runWorkerCommand } from './worker.ts'

// The command surface: each package.json script dispatches here with the command name
// as the first argument. CLI tokens such as `Enqueued:`, `Created:`, and `LOOP_DONE:`
// are frozen contracts that skills and tests key on.

type Command = (paths: OrchPaths, args: string[]) => Promise<number>

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high'])

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim()
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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

const cmdStart: Command = async (paths, args) => {
  const taskId = args[0]
  if (taskId === undefined) {
    console.error('Usage: start <task-id> [--effort minimal|low|medium|high] [--model <model>]')
    return 1
  }
  let effort = (process.env['CODEX_EFFORT'] ?? '') as ReasoningEffort | ''
  let model = process.env['CODEX_MODEL'] ?? ''
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
  const config = loadConfig()
  const runner = await loadRunner(config.runner)
  const project = await loadProject(config.project)
  const result = await startTask(paths, runner, taskId, {
    effort: effort === '' ? 'medium' : effort,
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
    const result = spawnSync('tail', ['-f', log], { stdio: 'inherit', windowsHide: true })
    return result.status ?? 0
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
  const project = await loadProject(config.project)
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
    const linkedIssue = issueNumberForTask(paths, taskId)
    const mergeCommit = await mergeTask(paths, taskId, {
      taskGate: config.taskGate,
      testCmd: testCmd ?? (config.testCmd === '' ? undefined : config.testCmd),
      skipAutoTest: config.skipAutoTest,
      project: await loadProject(config.project),
      closesIssue: linkedIssue,
    })
    if (linkedIssue !== undefined) {
      const runBranch = execFileSync('git', ['branch', '--show-current'], {
        cwd: paths.repoRoot,
        encoding: 'utf8',
        windowsHide: true,
      }).trim()
      recordIssuePromotion(paths, taskId, mergeCommit, runBranch)
      try {
        const forge = await loadForge(config.forge, paths.repoRoot)
        await commentOnIssueMerge(forge, linkedIssue, taskId, mergeCommit, runBranch)
      } catch (error) {
        console.error(
          `WARN: could not link issue #${linkedIssue} to its merge: ${(error as Error).message}`,
        )
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
  const taskId = args[0]
  if (taskId === undefined) {
    console.error('Usage: cleanup <task-id>')
    return 1
  }
  cleanupTask(paths, taskId)
  return 0
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
  const pid = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : ''
  if (/^\d+$/.test(pid) && isPidAlive(Number(pid))) {
    console.log(`loop: running (PID=${pid})`)
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
  console.log('Created the stop file. The loop will exit on the next poll.')
  return 0
}

const cmdLoop: Command = async (paths, args) => {
  const loopLog = join(paths.logsDir, 'loop.log')
  if (args[0] === '--daemon' || args[0] === '-d') {
    // run-branch.txt is updated by the child after this descriptor is opened. Use the
    // branch it is about to record so a new run rotates immediately, not on its restart.
    const runBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: paths.repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    }).trim()
    prepareLoopLog(paths, { runBranch })
    const fd = openSync(loopLog, 'a')
    const child = spawn(process.execPath, [join(paths.root, 'ts', 'src', 'cli.ts'), 'loop'], {
      cwd: paths.repoRoot,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    })
    child.unref()
    console.log(`Started the loop in the background (PID=${child.pid})`)
    console.log(`Log: ${loopLog}`)
    console.log('Check: npm run -C orchestration/ts loop-status')
    console.log('Stop: npm run -C orchestration/ts stop')
    return 0
  }
  const config = loadConfig()
  const scanCountFile = join(paths.queueDir, 'scan-count.txt')
  const log = (message: string, error = false): void => {
    const write = error ? console.error : console.log
    const currentCycle = existsSync(scanCountFile)
      ? Number(readFileSync(scanCountFile, 'utf8').trim()) || 0
      : 0
    for (const line of loopLogLines(message, {
      currentCycle,
      cycleCap: config.maxScanCycles,
    })) write(line)
  }
  try {
    return await runLoopDaemon(paths, log, config)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`ERROR: ${(message.split(/\r?\n/, 1)[0] ?? '').trim() || 'unknown error'}`, true)
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
  config: LoopConfig,
): Promise<number> {
  const pidFile = join(paths.queueDir, 'loop.pid')
  const stopFile = join(paths.queueDir, 'stop')
  const scanCountFile = join(paths.queueDir, 'scan-count.txt')

  // PID lock: one loop per repository.
  if (existsSync(pidFile)) {
    const existing = readFileSync(pidFile, 'utf8').trim()
    if (/^\d+$/.test(existing) && isPidAlive(Number(existing))) {
      log(`ERROR: Loop is already running (PID=${existing}). Please stop and restart.`)
      return 1
    }
    log('WARN: Removing stale PID file')
    rmSync(pidFile, { force: true })
  }
  writeFileSync(pidFile, `${process.pid}\n`)
  const releaseDaemonState = (): void => {
    try {
      removeIssueModeMarker(paths, process.pid)
    } catch {
      // nothing to release
    }
    try {
      if (readFileSync(pidFile, 'utf8').trim() === `${process.pid}`) {
        rmSync(pidFile, { force: true })
      }
    } catch {
      // nothing to release
    }
  }
  process.on('exit', releaseDaemonState)
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

  try {
    writeIssueModeMarker(paths, config.issueQueueEnabled, process.pid)

    // A stale stop file is cleared only after the PID lock is taken, so another
    // instance's signal is never removed.
    rmSync(stopFile, { force: true })
    if (!existsSync(scanCountFile)) writeFileSync(scanCountFile, '0\n')

    syncOrchestrationDepsAtStartup(
      paths,
      (name, subject) => log(`${name} ${subject}`),
    )
    const forge = await loadForge(config.forge, paths.repoRoot)
    const runner = await loadRunner(config.runner)
    const project = await loadProject(config.project)
    if (config.issueQueueEnabled) {
      const { ensureQueueLabels, reconcileClosedIssueLifecycleLabels } = await import('./issueQueue.ts')
      await ensureQueueLabels(forge)
      try {
        await reconcileClosedIssueLifecycleLabels(forge)
      } catch (error) {
        log(`WARN could not reconcile closed issue lifecycle labels: ${(error as Error).message}`)
      }
    }
    const loop = createLoop({ paths, config, forge, runner, project, log, now: () => new Date() })

    loop.initializeSessionStateForBranch()

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
      if (outcome !== 'continue') {
        wake.cancel()
        await wake.outcome
        return 0
      }
      await wake.outcome
    }
  } finally {
    releaseDaemonState()
  }
}

const commands: Record<string, Command> = {
  'new': cmdNew,
  'enqueue': cmdEnqueue,
  'delegate': cmdDelegate,
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
