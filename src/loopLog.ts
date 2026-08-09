import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrchPaths } from './paths.ts'

const MAX_MESSAGE_LENGTH = 80
export const LOOP_EVENT_NAME_WIDTH = 'DECISION_REQUIRED'.length

const EVENT_NAMES = [
  'DECISION_REQUIRED',
  'CYCLE_COMPLETE',
  'Merge completed',
  'Review started',
  'Scan completed',
  'Merge started',
  'Merge failed',
  'Issue claimed',
  'Issue filed',
  'Task failed',
  'Task completed',
  'Task started',
  'Scan started',
  'LOOP_DONE',
  'FAILED',
  'Status',
  'ERROR',
  'WARN',
] as const

function timestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function logTimestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + ` ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

function safeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

export interface PrepareLoopLogOptions {
  now?: Date
  runBranch?: string
}

function splitEvent(message: string): { event: string; subject: string } {
  const content = message.startsWith('[loop] ')
    ? message.slice('[loop] '.length)
    : message === '[loop]' ? '' : message
  for (const event of EVENT_NAMES) {
    // The lifecycle phrase is "Task failed", while FAILED remains a frozen log token.
    const loggedEvent = event === 'Task failed' ? 'FAILED' : event
    if (content === event) return { event: loggedEvent, subject: '' }
    if (content.startsWith(`${event} `)) {
      return { event: loggedEvent, subject: content.slice(event.length + 1) }
    }
    if (['WARN', 'ERROR', 'CYCLE_COMPLETE', 'LOOP_DONE', 'FAILED', 'DECISION_REQUIRED']
      .includes(event) && content.startsWith(`${event}:`)) {
      return { event, subject: content.slice(event.length + 1).trimStart() }
    }
  }
  const separator = content.indexOf(' ')
  return separator === -1
    ? { event: content, subject: '' }
    : { event: content.slice(0, separator), subject: content.slice(separator + 1) }
}

/** Align every physical daemon-log line under the event that produced the message. */
export function loopLogLines(message: string, now: Date = new Date()): string[] {
  const prefix = `[loop] ${logTimestamp(now)} | `
  const physicalLines = message.split(/\r?\n/)
  const { event, subject } = splitEvent(physicalLines[0] ?? '')
  return [subject, ...physicalLines.slice(1)].map((line) => {
    const content = `${event.padEnd(LOOP_EVENT_NAME_WIDTH)}${line === '' ? '' : ` ${line}`}`
    const capped = content.length > MAX_MESSAGE_LENGTH
      ? `${content.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
      : content
    return `${prefix}${capped}`
  })
}

/** Prepare the process-wide loop log before the daemon opens it for append. */
export function prepareLoopLog(
  paths: OrchPaths,
  options: PrepareLoopLogOptions = {},
): void {
  const loopLog = join(paths.logsDir, 'loop.log')
  const branchMarker = join(paths.logsDir, 'loop.log.branch')
  const runBranchFile = join(paths.queueDir, 'run-branch.txt')
  const recordedRunBranch = existsSync(runBranchFile)
    ? readFileSync(runBranchFile, 'utf8').trim()
    : ''
  const markerBranch = options.runBranch ?? recordedRunBranch
  const loggedBranch = existsSync(branchMarker)
    ? readFileSync(branchMarker, 'utf8').trim()
    : undefined

  if (existsSync(loopLog) && (loggedBranch === undefined || loggedBranch !== markerBranch)) {
    const oldBranch = loggedBranch ?? (recordedRunBranch || markerBranch)
    renameSync(
      loopLog,
      join(paths.logsDir, `loop-${safeBranchName(oldBranch)}-${timestamp(options.now ?? new Date())}.log`),
    )
  }

  if (!existsSync(loopLog)) writeFileSync(loopLog, '')
  writeFileSync(branchMarker, `${markerBranch}\n`)
}
