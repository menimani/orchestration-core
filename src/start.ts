import { execFileSync, execSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { WorktreeSetupStep } from './adapters/project.ts'
import type { Runner, RunnerStartOptions } from './adapters/runner.ts'
import { branchName, finalMessageFile, logFile, worktreeDir, type OrchPaths } from './paths.ts'
import { readStatus, writeStatus } from './status.ts'
import { specFile } from './tasks.ts'

export type StartResult
  = { outcome: 'started'; pid: number }
    | { outcome: 'already-running' }

export interface StartOptions {
  effort: RunnerStartOptions['effort']
  model?: string | undefined
  setup?: WorktreeSetupStep[] | undefined
}

/**
 * Create the task's worktree and hand it to the runner. Ported from task-start.sh:
 * a worktree whose task is already running is a skip, not an error, so the loop
 * does not retry endlessly; any other leftover worktree needs cleanup first.
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
    if (readStatus(paths, taskId)?.status === 'running') {
      return { outcome: 'already-running' }
    }
    throw new Error(
      `Worktree already exists: ${worktree}\nIf this task was abandoned, run cleanup first.`,
    )
  }

  console.log(`Creating worktree: ${worktree} (branch: ${branch})`)
  execFileSync('git', ['worktree', 'add', worktree, '-b', branch], {
    cwd: paths.repoRoot,
    stdio: 'inherit',
    windowsHide: true,
  })

  for (const step of options.setup ?? []) {
    if (step.requires !== undefined && !existsSync(join(worktree, step.requires))) continue
    console.log(`Preparing worktree: ${step.label}`)
    execSync(step.command, {
      cwd: join(worktree, step.cwd),
      stdio: 'inherit',
      windowsHide: true,
    })
  }

  const log = logFile(paths, taskId)
  const finalMessage = finalMessageFile(paths, taskId)
  writeFileSync(log, '')
  rmSync(finalMessage, { force: true })

  console.log(`Starting task execution: ${taskId}`
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
  await writeStatus(paths, taskId, 'running', pid)
  console.log(`Started. task_id=${taskId} pid=${pid} log=${log}`)
  return { outcome: 'started', pid }
}
