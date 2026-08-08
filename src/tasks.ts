import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pitfallsFileForDesc } from './gates.ts'
import { taskIdForDesc } from './ids.ts'
import { statusFile, type OrchPaths } from './paths.ts'
import { readStatus } from './status.ts'

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
  const lines = existsSync(backlog)
    ? readFileSync(backlog, 'utf8').split(/\r?\n/).filter((line) => line !== '')
    : []
  if (lines.some((line) => line.startsWith(`${taskId}:`))) {
    return { outcome: 'already-queued', taskId }
  }
  const status = existsSync(statusFile(paths, taskId))
    ? readStatus(paths, taskId)?.status
    : undefined
  if (status === 'merged' || status === 'running' || status === 'completed') {
    return { outcome: 'already-processed', taskId, status }
  }
  writeFileSync(backlog, [...lines, `${taskId}:${depth}`].map((line) => `${line}\n`).join(''))
  return { outcome: 'enqueued', taskId, depth }
}

export interface DelegateOptions {
  effort?: 'minimal' | 'low' | 'medium' | 'high' | undefined
  inspect?: boolean
}

export interface DelegateResult {
  taskId: string
  spec: string
  specReused: boolean
  enqueue: EnqueueResult
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
  const spec = specFile(paths, taskId)
  const specReused = existsSync(spec)
  if (!specReused) {
    const parts = [`# ${taskId}: delegated task\n\n## Requirement\n\n${description}\n`]
    const requirements = join(paths.root, 'templates', 'task-requirements.md')
    if (existsSync(requirements)) {
      parts.push(`\n${readFileSync(requirements, 'utf8')}`)
    }
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
