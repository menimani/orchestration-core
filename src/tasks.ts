import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendBacklogUnless } from './backlog.ts'
import { pitfallsFileForDesc } from './gates.ts'
import { taskIdForDesc } from './ids.ts'
import { statusFile, type OrchPaths } from './paths.ts'
import { readStatus } from './status.ts'
import { readTemplate } from './templates.ts'
import { signalWake } from './wake.ts'
import type { Forge } from './adapters/forge.ts'

// The queue-writing commands: new, enqueue, delegate. Everything here prints the exact
// lines the bash implementation printed (`Created:`, `Enqueued:`, `WARN:`), because the
// loop's tests and the skills key on them.

const SPEC_TAIL = `
## Commit

After implementation is complete, git add and git commit the changed files.
Commit prefixes: feat: / fix: / refactor: / test: / docs: / chore:

## Completion Marker

After committing, output the following as the final standalone line:
TASK_COMPLETE
`

export function specFile(paths: OrchPaths, taskId: string): string {
  return join(paths.tasksDir, `${taskId}.md`)
}

export function newTaskSpec(paths: OrchPaths, taskId: string): string {
  const file = specFile(paths, taskId)
  if (existsSync(file)) {
    throw new Error(`Task specification already exists: ${file}`)
  }
  writeFileSync(file, `# ${taskId}

## Target Files
(List the target files and directories)

## Requirements
-

## Completion Criteria
- Existing tests pass
-
${SPEC_TAIL}`)
  return file
}

export type EnqueueResult
  = { outcome: 'enqueued'; taskId: string; depth: number }
    | { outcome: 'already-queued'; taskId: string }
    | { outcome: 'already-processed'; taskId: string; status: string }

/**
 * Append a task to the backlog unless it is already queued, running, or done.
 * Failed tasks may be re-enqueued — that is the manual retry path.
 */
export function enqueueTask(paths: OrchPaths, taskId: string, depth = 0): EnqueueResult {
  if (!existsSync(specFile(paths, taskId))) {
    throw new Error(`Task specification not found: ${specFile(paths, taskId)}`)
  }
  const backlog = join(paths.queueDir, 'backlog.txt')
  const status = existsSync(statusFile(paths, taskId))
    ? readStatus(paths, taskId)?.status
    : undefined
  if (status === 'merged' || status === 'running' || status === 'completed') {
    return { outcome: 'already-processed', taskId, status }
  }
  const appended = appendBacklogUnless(
    backlog,
    (lines) => lines.some((line) => line.startsWith(`${taskId}:`)),
    `${taskId}:${depth}`,
  )
  if (!appended) return { outcome: 'already-queued', taskId }
  return { outcome: 'enqueued', taskId, depth }
}

export interface DelegateOptions {
  effort?: 'minimal' | 'low' | 'medium' | 'high' | undefined
  inspect?: boolean
}

export class DelegatedTaskMutationError extends Error {
  readonly issueNumber: number | undefined

  constructor(error: unknown, issueNumber?: number) {
    const detail = error instanceof Error ? error.message : String(error)
    const issue = issueNumber === undefined ? 'the forge' : `issue #${issueNumber}`
    super(`Could not reconcile ${issue} after delegated work may have been published: ${detail}`, {
      cause: error,
    })
    this.name = 'DelegatedTaskMutationError'
    this.issueNumber = issueNumber
  }
}

interface DelegateResultBase {
  taskId: string
  spec: string
  specReused: boolean
}

type DelegatedIssueResult = {
  outcome: 'created' | 'duplicate'
  issueNumber: number
} & ({ materialize: true } | { materialize: false })

type MaterializedDelegateResult = DelegateResultBase & {
  enqueue: EnqueueResult
  issue?: DelegatedIssueResult
}

export type DelegateResult
  = MaterializedDelegateResult
    | DelegateResultBase & {
      enqueue?: undefined
      issue: DelegatedIssueResult & { materialize: false }
    }

function issueModeMarkerFile(paths: OrchPaths): string {
  return join(paths.queueDir, 'issue-mode')
}

export function writeIssueModeMarker(
  paths: OrchPaths,
  enabled: boolean,
  pid = process.pid,
): void {
  writeFileSync(issueModeMarkerFile(paths), `${enabled}\n${pid}\n`)
}

export function removeIssueModeMarker(paths: OrchPaths, pid: number): void {
  const marker = issueModeMarkerFile(paths)
  if (!existsSync(marker)) return
  const [, owner] = readFileSync(marker, 'utf8').trim().split(/\s+/)
  if (owner === `${pid}`) rmSync(marker, { force: true })
}

/** The delegate process prefers its own explicit setting, then the daemon marker. */
export function isIssueModeActive(
  paths: OrchPaths,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = env['ISSUE_QUEUE_ENABLED']
  if (configured !== undefined) return configured === 'true'
  const marker = issueModeMarkerFile(paths)
  if (!existsSync(marker)) return false
  const [enabled, owner] = readFileSync(marker, 'utf8').trim().split(/\s+/)
  if (enabled !== 'true' || owner === undefined || !/^\d+$/.test(owner)) return false
  try {
    process.kill(Number(owner), 0)
    return true
  } catch {
    return false
  }
}

/**
 * Turn a description into a specification and enqueue it. The spec is written
 * completely before enqueueing, so a polling loop can never start a half-written task.
 */
export function delegateTask(
  paths: OrchPaths,
  description: string,
  options: DelegateOptions = {},
): DelegateResult {
  if (description.trim() === '') {
    throw new Error('A non-empty description is required')
  }
  const taskId = taskIdForDesc(paths, 'user', description)
  return materializeDelegatedTask(paths, taskId, description, options)
}

function materializeDelegatedTask(
  paths: OrchPaths,
  taskId: string,
  description: string,
  options: DelegateOptions,
): MaterializedDelegateResult {
  const spec = specFile(paths, taskId)
  const specReused = existsSync(spec)
  if (!specReused) {
    const parts = [`# ${taskId}: delegated task\n\n## Requirement\n\n${description}\n`]
    parts.push(`\n${readTemplate(paths, 'task-requirements.md')}`)
    // Delegated work is nearly always code; the pitfall list carries the defect classes
    // reviews kept re-flagging, so the implementer checks them up front.
    const pitfalls = pitfallsFileForDesc(paths, description)
    if (existsSync(pitfalls)) {
      parts.push(`\n${readFileSync(pitfalls, 'utf8')}`)
    }
    parts.push(SPEC_TAIL)
    writeFileSync(spec, parts.join(''))
  }
  if (options.effort !== undefined) {
    const effortDir = join(paths.queueDir, 'effort')
    mkdirSync(effortDir, { recursive: true })
    writeFileSync(join(effortDir, taskId), `${options.effort}\n`)
  }
  if (options.inspect === true) {
    const inspectDir = join(paths.queueDir, 'inspect')
    mkdirSync(inspectDir, { recursive: true })
    writeFileSync(join(inspectDir, taskId), '')
  }
  return { taskId, spec, specReused, enqueue: enqueueTask(paths, taskId, 0) }
}

export interface DelegatedIssueOptions {
  env?: NodeJS.ProcessEnv
  loadForge: () => Promise<Forge>
  warn: (message: string) => void
}

/** Publish shared work for the daemon that exclusively creates its local task. */
export async function delegateTaskVisible(
  paths: OrchPaths,
  description: string,
  options: DelegateOptions,
  issueOptions: DelegatedIssueOptions,
): Promise<DelegateResult> {
  if (description.trim() === '') {
    throw new Error('A non-empty description is required')
  }
  if (!isIssueModeActive(paths, issueOptions.env)) {
    return delegateTask(paths, description, options)
  }

  const taskId = taskIdForDesc(paths, 'user', description)
  const spec = specFile(paths, taskId)
  let issue: DelegatedIssueResult

  try {
    const forge = await issueOptions.loadForge()
    const { publishDelegatedTask } = await import('./issueQueue.ts')
    issue = await publishDelegatedTask(
      forge, paths, description, taskId, options.effort, options.inspect,
    )
  } catch (error) {
    // Once a forge write may have happened, a local-only task could run without the
    // issue mapping that supplies its heartbeat. Leave it unmaterialized instead.
    if (error instanceof DelegatedTaskMutationError) throw error
    issueOptions.warn(`WARN: Could not publish delegated task to the forge: ${(error as Error).message}`)
    return materializeDelegatedTask(paths, taskId, description, options)
  }
  // The publication touched only the forge; without a local nudge the daemon's
  // backlog watcher never fires and the issue waits out the poll interval.
  signalWake(paths)
  return { taskId, spec, specReused: existsSync(spec), issue }
}

export function isLoopRunning(paths: OrchPaths): boolean {
  const pidFile = join(paths.queueDir, 'loop.pid')
  if (!existsSync(pidFile)) return false
  const pid = readFileSync(pidFile, 'utf8').trim()
  if (!/^\d+$/.test(pid)) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}
