import { execFileSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { operatingSystem } from './adapters/os.ts'
import type { WorktreeSetupStep } from './adapters/project.ts'
import type { Runner, RunnerStartOptions } from './adapters/runner.ts'
import { branchName, finalMessageFile, logFile, worktreeDir, type OrchPaths } from './paths.ts'
import { execShellSync } from './shell.ts'
import { readStatus, writeStatus } from './status.ts'
import { specFile } from './tasks.ts'

export type StartResult
  = { outcome: 'started'; pid: number }
    | { outcome: 'already-running' }

export interface StartOptions {
  effort: RunnerStartOptions['effort']
  model?: string | undefined
  setup?: WorktreeSetupStep[] | undefined
  report?: ((line: string) => void) | undefined
}

export function worktreeAddArgs(worktree: string, branch: string): string[] {
  return ['worktree', 'add', '--quiet', worktree, '-b', branch]
}

/**
 * Create the task's worktree and hand it to the runner.
 * A worktree whose task is already running is a skip, not an error, so the loop
 * does not retry endlessly. A leftover worktree with no live owner may contain work
 * from a crashed runner, so only the explicit cleanup command may discard it.
 */
export async function startTask(
  paths: OrchPaths,
  runner: Runner,
  taskId: string,
  options: StartOptions,
): Promise<StartResult> {
  // Validated here, not only in the CLI: the loop reaches this directly with values
  // from environment settings and per-task effort files, and an unvalidated value
  // would travel into the runner's flags.
  if (!['minimal', 'low', 'medium', 'high'].includes(options.effort)) {
    throw new Error(`effort must be minimal, low, medium or high, got '${options.effort}'`)
  }
  const spec = specFile(paths, taskId)
  if (!existsSync(spec)) {
    throw new Error(
      `Task specification not found: ${spec}\nCreate the specification first with the 'new' command.`,
    )
  }

  const worktree = worktreeDir(paths, taskId)
  const branch = branchName(taskId)
  if (existsSync(worktree)) {
    const status = readStatus(paths, taskId)
    if (status?.pid !== null && status?.pid !== undefined
      && operatingSystem.processIsAlive(status.pid)) {
      return { outcome: 'already-running' }
    }
    throw new Error(
      `Task worktree already exists without a live owner: ${worktree}\n`
      + `Inspect it for uncommitted changes or commits, then run cleanup explicitly.`,
    )
  }

  const log = logFile(paths, taskId)
  const finalMessage = finalMessageFile(paths, taskId)
  writeFileSync(log, '')
  rmSync(finalMessage, { force: true })
  let launchedPid: number | undefined

  try {
    options.report?.(`Creating worktree: ${worktree} (branch: ${branch})`)
    execFileSync('git', worktreeAddArgs(worktree, branch), {
      cwd: paths.repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    for (const step of options.setup ?? []) {
      if (step.requires !== undefined && !existsSync(join(worktree, step.requires))) continue
      options.report?.(`Preparing worktree: ${step.label}`)
      const setupLogFd = openSync(log, 'a')
      try {
        execShellSync(step.command, {
          cwd: join(worktree, step.cwd),
          encoding: 'utf8',
          stdio: ['ignore', setupLogFd, setupLogFd],
          windowsHide: true,
        })
      } finally {
        closeSync(setupLogFd)
      }
    }

    options.report?.(`Starting task execution: ${taskId}`
      + (options.model !== undefined && options.model !== '' ? ` model=${options.model}` : '')
      + ` effort=${options.effort}`)
    const pid = await runner.start({
      worktree,
      specFile: spec,
      finalMessageFile: finalMessage,
      logFile: log,
      effort: options.effort,
      model: options.model,
    })
    launchedPid = pid
    await writeStatus(paths, taskId, 'running', pid)
    options.report?.(`Started. task_id=${taskId} pid=${pid} log=${log}`)
    return { outcome: 'started', pid }
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    if (launchedPid !== undefined) {
      try {
        operatingSystem.terminateProcessTree(launchedPid)
        if (operatingSystem.processTreeIsAlive(launchedPid)) {
          throw new Error(`Process tree ${launchedPid} is still alive.`)
        }
      } catch (terminationError) {
        const terminationDetail = terminationError instanceof Error
          ? terminationError.stack ?? terminationError.message
          : String(terminationError)
        appendFileSync(
          log,
          `Task startup failed:\n${detail}\nProcess tree cleanup failed:\n${terminationDetail}\n`,
        )
        throw new AggregateError(
          [error, terminationError],
          `Task startup failed and process tree ${launchedPid} could not be stopped.`,
        )
      }
    }
    appendFileSync(log, `Task startup failed:\n${detail}\n`)
    await writeStatus(paths, taskId, 'failed')
    throw error
  }
}
