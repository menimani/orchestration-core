import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { operatingSystem } from './adapters/os.ts'
import { finalMessageFile, logFile, rebaseEmptiedMarkerFile, type OrchPaths } from './paths.ts'
import {
  forgetTaskProcess, taskProcessRecorded, terminableTaskProcessPid,
} from './processRegistry.ts'
import { readStatus, transitionStatus, type TaskStatus } from './status.ts'

// The status refresh. Only a running task is ever
// rewritten: terminal files (merged, failed) are left byte-for-byte as they are, and
// the running→completed/failed decision goes through the compare-and-swap transition
// so a merge that won the lock first is preserved rather than overwritten.

/** The Markdown inline formatting a marker line may carry as one pair around the token. */
const MARKER_WRAPPERS = ['', '`', '**', '*', '__', '_']

/**
 * A fenced code block's opening line by the CommonMark rule: three or more backticks or
 * tildes at the first column, then an optional info string holding no backtick.
 */
const FENCE_OPENER = /^(`{3,}|~{3,})[^`]*$/

/** A fence's closing line: a run of fence characters with nothing after it but white space. */
const FENCE_CLOSER = /^(`{3,}|~{3,})\s*$/

/**
 * Whether one line is a standalone marker: the marker alone at the first column once
 * trailing white space and at most one pair of Markdown inline formatting around the whole
 * token are removed. Leading white space is never tolerated, since git prints commit
 * messages and diff context indented, and that text comes from accounts the loop does not
 * control.
 */
function markerLine(line: string, marker: string): boolean {
  const trimmed = line.trimEnd()
  return MARKER_WRAPPERS.some((wrapper) => trimmed === `${wrapper}${marker}${wrapper}`)
}

/** The index of the line closing the fence opened by `opener`, if any line closes it. */
function fenceCloser(lines: string[], from: number, opener: string): number | undefined {
  for (let index = from; index < lines.length; index++) {
    const run = FENCE_CLOSER.exec(lines[index] ?? '')?.[1]
    if (run !== undefined && run[0] === opener[0] && run.length >= opener.length) return index
  }
  return undefined
}

/**
 * Whether a final message carries a standalone marker line (see `markerLine`), since a
 * model writing Markdown naturally formats a literal token that way. A marker inside a
 * closed fenced code block counts only when it is the block's sole non-blank line — one
 * more layer of the runner's own formatting — so quoted prompt or forge text stays inert.
 * An opening fence that nothing closes hides nothing: the lines after it are read as
 * outside a fence, so a mis-nested or unterminated block cannot hide a final marker.
 */
export function markerLinePresent(text: string, marker: string): boolean {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const opener = FENCE_OPENER.exec(line.trimEnd())?.[1]
    const closer = opener === undefined ? undefined : fenceCloser(lines, index + 1, opener)
    if (closer !== undefined) {
      const content = lines.slice(index + 1, closer).filter((inner) => inner.trim() !== '')
      if (content.length === 1 && markerLine(content[0] ?? '', marker)) return true
      index = closer
      continue
    }
    if (markerLine(line, marker)) return true
  }
  return false
}

/**
 * Completion is detected only from the final-message file the runner wrote, never the
 * transcript — TASK_COMPLETE appearing in prompt text echoed to the log is not
 * completion. The marker must occupy its own line.
 */
export function completionMarkerPresent(paths: OrchPaths, taskId: string): boolean {
  const file = finalMessageFile(paths, taskId)
  if (!existsSync(file)) return false
  return markerLinePresent(readFileSync(file, 'utf8'), 'TASK_COMPLETE')
}

/** An explicit verdict that a completed implementation task legitimately needs no commit. */
export function noChangeMarkerPresent(paths: OrchPaths, taskId: string): boolean {
  const file = finalMessageFile(paths, taskId)
  if (!existsSync(file)) return false
  return markerLinePresent(readFileSync(file, 'utf8'), 'NO_CHANGE_WARRANTED')
}

/**
 * The merge's verdict that a rebase emptied the task's commits. The rebase rewrites the
 * task branch, so once anything after it fails the commits look empty from the start;
 * this record lets the retry tell them from commits the worker made empty.
 */
export function rebaseEmptiedMarkerPresent(paths: OrchPaths, taskId: string): boolean {
  return existsSync(rebaseEmptiedMarkerFile(paths, taskId))
}

export function recordRebaseEmptiedMarker(paths: OrchPaths, taskId: string): void {
  const file = rebaseEmptiedMarkerFile(paths, taskId)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, '')
  try {
    renameSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function removeRebaseEmptiedMarker(paths: OrchPaths, taskId: string): void {
  rmSync(rebaseEmptiedMarkerFile(paths, taskId), { force: true })
}

export interface RefreshOptions {
  /**
   * False when no daemon holds the queue. A graceful stop removes the PID records of the
   * trees it terminated and leaves their statuses running, and the next daemon reports
   * those as dead at startup; failing them here first would turn them into fresh failures
   * counted against their issues and the burst guard.
   */
  daemonOwnsQueue?: boolean
  /**
   * Hours a live task may stay running without the completion marker, measured from its
   * status file's `started_at`. Zero or absent sets no deadline.
   */
  taskDeadlineHours?: number
  /** Epoch milliseconds the deadline is measured against. */
  now?: () => number
  /** Told when an overdue task's process tree was stopped, or why it could not be. */
  onDeadline?: (verdict: DeadlineVerdict) => void
}

export type DeadlineVerdict =
  | { taskId: string, pid: number, stopped: true }
  | { taskId: string, pid: number, stopped: false, error: string }

const HOUR_MS = 3_600_000

function deadlineExpired(startedAt: string, deadlineHours: number, now: () => number): boolean {
  if (deadlineHours <= 0) return false
  const started = Date.parse(startedAt)
  // An unreadable start time cannot prove the task overdue, so it is left running.
  return Number.isFinite(started) && now() - started >= deadlineHours * HOUR_MS
}

/**
 * Stop an overdue task's process tree the way cleanup does: only a process whose start
 * identity was captured at launch is terminated, and the stop counts only once the whole
 * tree is gone. Returns why the tree could not be stopped, or undefined once it is.
 */
function stopOverdueProcess(paths: OrchPaths, taskId: string, pid: number): string | undefined {
  const terminablePid = terminableTaskProcessPid(
    paths, taskId, undefined, operatingSystem.processStartIdentity,
    operatingSystem.processTreeIsAlive,
  )
  if (terminablePid === undefined) {
    return 'process identity was not captured at launch or is currently unavailable'
  }
  if (terminablePid !== pid) return 'task process ownership changed'
  try {
    if (!operatingSystem.terminateProcessTree(terminablePid)
      || operatingSystem.processTreeIsAlive(terminablePid)) {
      return 'process tree termination could not be verified'
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  forgetTaskProcess(paths, taskId)
  return undefined
}

/**
 * Refresh one task: a live process with the marker is completed; a dead process is
 * completed or failed by whether the marker made it into the final message. Without a
 * daemon, a task with no PID record and no marker stays running for the next daemon to
 * classify; one whose record outlived its process crashed and is failed. A live task past
 * its deadline has its process tree stopped and is failed with the reason in its log; one
 * whose tree cannot be stopped stays running and is tried again at the next refresh.
 * Returns the status after refresh.
 */
export async function refreshTask(
  paths: OrchPaths,
  taskId: string,
  { daemonOwnsQueue = true, taskDeadlineHours = 0, now = Date.now, onDeadline }:
    RefreshOptions = {},
): Promise<TaskStatus | undefined> {
  // Asked before the status is read: reading it drops a record whose process is gone,
  // after which a crashed runner would look like one a graceful stop released.
  const recorded = taskProcessRecorded(paths, taskId)
  const status = readStatus(paths, taskId)
  if (status === undefined || status.status !== 'running') return status

  const alive = status.pid !== null && operatingSystem.processIsAlive(status.pid)
  let next: 'completed' | 'failed' | undefined
  let nextPid: number | undefined
  let deadlineReason: string | undefined
  if (alive) {
    if (completionMarkerPresent(paths, taskId)) {
      next = 'completed'
      nextPid = status.pid ?? undefined
    } else if (deadlineExpired(status.started_at, taskDeadlineHours, now)) {
      const pid = status.pid!
      const error = stopOverdueProcess(paths, taskId, pid)
      if (error !== undefined) {
        onDeadline?.({ taskId, pid, stopped: false, error })
        return status
      }
      onDeadline?.({ taskId, pid, stopped: true })
      next = 'failed'
      deadlineReason = `running since ${status.started_at}, past the `
        + `${taskDeadlineHours}-hour task deadline; process tree ${pid} was stopped`
    }
  } else if (completionMarkerPresent(paths, taskId)) {
    next = 'completed'
  } else if (daemonOwnsQueue || recorded || status.pid !== null) {
    next = 'failed'
  }
  if (next === undefined) return status

  // When the transition loses, a merge won the lock after this refresh classified the
  // file; the re-read is the answer, not this refresh's stale decision.
  const transitioned = await transitionStatus(paths, taskId, 'running', next, nextPid)
  if (transitioned && deadlineReason !== undefined) {
    appendFileSync(logFile(paths, taskId), `\nTask deadline exceeded: ${deadlineReason}\n`)
  }
  return readStatus(paths, taskId)
}

export function listTaskIds(paths: OrchPaths): string[] {
  return readdirSync(paths.statusDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort()
}

/** Refresh every task and return the listing `status` prints, one line per task. */
export async function refreshAll(
  paths: OrchPaths,
  options: RefreshOptions = {},
): Promise<string[]> {
  const lines: string[] = []
  for (const taskId of listTaskIds(paths)) {
    const before = readStatus(paths, taskId)
    if (before === undefined) continue
    if (before.status === 'merged' || before.status === 'no-change' || before.status === 'failed') {
      lines.push(`${taskId.padEnd(20)} ${before.status.padEnd(10)} pid=`)
      continue
    }
    const after = before.status === 'running' ? await refreshTask(paths, taskId, options) : before
    const pid = after?.pid ?? ''
    lines.push(`${taskId.padEnd(20)} ${(after?.status ?? '?').padEnd(10)} pid=${pid}`)
  }
  return lines
}
