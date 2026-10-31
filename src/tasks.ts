import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendBacklogUnless } from './backlog.ts'
import { loadConfig } from './config.ts'
import { pitfallsFileForDesc } from './gates.ts'
import { descSlug, newTaskId, recordTaskIdForDesc, taskIdForDesc } from './ids.ts'
import { branchName, statusFile, worktreeDir, type OrchPaths } from './paths.ts'
import { readStatus } from './status.ts'
import { readTemplate } from './templates.ts'
import { signalWake } from './wake.ts'
import type { Forge } from './adapters/forge.ts'
import {
  currentProcessMarkerPid, parseProcessMarker, processMarker, processMarkerText,
} from './processMarker.ts'

// The queue-writing commands: new, enqueue, delegate. The line prefixes printed here
// (`Created:`, `Enqueued:`, `WARN:`) are contract, not wording: the loop's tests and the
// skills key on them.

const SPEC_TAIL = `
## Commit

After implementation is complete, git add and git commit the changed files.
Commit prefixes: feat: / fix: / refactor: / test: / docs: / chore:

The commit body is all a reader of this repository's history will have to go on. State
the problem the change addresses, why this change addresses it, and how it was verified;
do not restate the diff. Do not mention task ids, issue numbers, or the orchestration
that produced the change. For a security fix, say what was hardened without describing
how the weakness could be exploited.

## Completion Marker

If investigation proves that no change is warranted, do not create an empty commit.
Explain why and output \`NO_CHANGE_WARRANTED\` on its own line.

After committing, or after reporting that no change is warranted, output the following
as the final standalone line:
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
    | { outcome: 'needs-cleanup'; taskId: string; leftover: string }

function localBranchExists(paths: OrchPaths, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: paths.repoRoot,
      stdio: 'ignore',
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Append a task to the backlog unless it is already queued, running, or done.
 * Failed tasks may be re-enqueued — that is the manual retry path — but only once
 * cleanup has removed their worktree and branch: the start step refuses to reuse
 * either, so a retry queued before then would be dropped on the next poll.
 */
export function enqueueTask(paths: OrchPaths, taskId: string, depth = 0): EnqueueResult {
  if (!existsSync(specFile(paths, taskId))) {
    throw new Error(`Task specification not found: ${specFile(paths, taskId)}`)
  }
  const backlog = join(paths.queueDir, 'backlog.txt')
  const status = existsSync(statusFile(paths, taskId))
    ? readStatus(paths, taskId)?.status
    : undefined
  if (status === 'merged' || status === 'no-change'
    || status === 'running' || status === 'completed') {
    return { outcome: 'already-processed', taskId, status }
  }
  if (status === 'failed') {
    const worktree = worktreeDir(paths, taskId)
    if (existsSync(worktree)) return { outcome: 'needs-cleanup', taskId, leftover: worktree }
    const branch = branchName(taskId)
    if (localBranchExists(paths, branch)) {
      return { outcome: 'needs-cleanup', taskId, leftover: `branch ${branch}` }
    }
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
  writeFileSync(issueModeMarkerFile(paths), `${enabled}\n${processMarkerText(processMarker(pid))}`)
}

export function removeIssueModeMarker(paths: OrchPaths, pid: number): void {
  const marker = issueModeMarkerFile(paths)
  if (!existsSync(marker)) return
  const [, ownerText] = readFileSync(marker, 'utf8').split(/\r?\n/, 2)
  if (ownerText !== undefined && parseProcessMarker(ownerText)?.pid === pid) {
    rmSync(marker, { force: true })
  }
}

function fileSetsIssueQueue(configFile: string): boolean {
  if (!existsSync(configFile)) return false
  const values = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>
  return Object.hasOwn(values, 'ISSUE_QUEUE_ENABLED')
}

/**
 * The delegate process prefers an explicit setting, resolved as the daemon resolves it
 * (the repository configuration file over the environment), then the daemon marker.
 */
export function isIssueModeActive(
  paths: OrchPaths,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configFile = join(paths.projectRoot, 'config.json')
  // Resolving first rejects a malformed value instead of silently reading it as false.
  if (loadConfig(env, { filePath: configFile }).issueQueueEnabled) return true
  if ((env['ISSUE_QUEUE_ENABLED'] ?? '') !== '' || fileSetsIssueQueue(configFile)) return false
  const marker = issueModeMarkerFile(paths)
  if (!existsSync(marker)) return false
  const [enabled, ownerText] = readFileSync(marker, 'utf8').split(/\r?\n/, 2)
  if (enabled !== 'true' || ownerText === undefined) return false
  return currentProcessMarkerPid(ownerText) !== undefined
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
  indexedTaskId: string,
  description: string,
  options: DelegateOptions,
): MaterializedDelegateResult {
  // The index can still name a task that has already landed. Delegating the same words
  // again is then a new request, so it gets a fresh task rather than being dropped as
  // already processed.
  const indexedStatus = existsSync(statusFile(paths, indexedTaskId))
    ? readStatus(paths, indexedTaskId)?.status
    : undefined
  const needsFreshTask = indexedStatus === 'merged' || indexedStatus === 'no-change'
  const taskId = needsFreshTask
    ? newTaskId(paths, `user-${descSlug(description)}`)
    : indexedTaskId
  if (needsFreshTask) recordTaskIdForDesc(paths, 'user', description, taskId)
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
  return currentProcessMarkerPid(readFileSync(pidFile, 'utf8')) !== undefined
}
