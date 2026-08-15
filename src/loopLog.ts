import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrchPaths } from './paths.ts'

const WARN_SUMMARY_INTERVAL_MS = 10 * 60 * 1000
const LOOP_EVENT_NAME_WIDTH = 10

const EVENT_NAMES = [
  'Completed',
  'Decision',
  'Claimed',
  'Started',
  'Installed',
  'Running',
  'Idle',
  'Merging',
  'Merged',
  'No-change',
  'Failed',
  'Filed',
  'Released',
  'Stopped',
  'Waiting',
  'Status',
  'Updated',
  'Restarting',
  'Restarted',
  'ERROR',
  'WARN',
  'Recovered',
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

interface ActiveWarning {
  firstAt: number
  lastSummaryAt: number
  repeats: number
  message: string
  operation: string
}

/** Keep noisy recoverable failures visible without letting them consume loop.log. */
export class LoopWarningLog {
  private readonly active = new Map<string, ActiveWarning>()
  private readonly paths: OrchPaths
  private readonly write: (message: string) => void
  private readonly now: () => Date

  constructor(
    paths: OrchPaths,
    write: (message: string) => void,
    now: () => Date = () => new Date(),
  ) {
    this.paths = paths
    this.write = write
    this.now = now
  }

  warn(callSite: string, operation: string, message: string): void {
    const key = `${callSite}\0${message}`
    const existing = this.active.get(key)
    const current = this.now()
    const displayMessage = message.split(/\r?\n/, 1)[0] ?? ''
    if (existing === undefined) {
      this.active.set(key, {
        firstAt: current.getTime(),
        lastSummaryAt: current.getTime(),
        repeats: 0,
        message,
        operation,
      })
      this.write(`WARN ${displayMessage}`)
      appendFileSync(
        join(this.paths.logsDir, 'warn-detail.log'),
        `${logTimestamp(current)} WARN ${message}\n`,
      )
      return
    }

    existing.repeats += 1
    if (current.getTime() - existing.lastSummaryAt < WARN_SUMMARY_INTERVAL_MS) return

    const existingDisplay = existing.message.split(/\r?\n/, 1)[0] ?? ''
    this.write(`WARN ${existingDisplay} repeated ${existing.repeats} times`)
    existing.repeats = 0
    existing.lastSummaryAt = current.getTime()
  }

  recovered(callSite: string): void {
    const warnings = [...this.active.entries()]
      .filter(([key]) => key.startsWith(`${callSite}\0`))
    if (warnings.length === 0) return

    const current = this.now().getTime()
    const firstAt = Math.min(...warnings.map(([, warning]) => warning.firstAt))
    const operation = warnings[0]![1].operation
    for (const [key] of warnings) this.active.delete(key)
    this.write(`Recovered ${operation} after ${Math.floor((current - firstAt) / 60_000)} minutes`)
  }
}

function safeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

export interface PrepareLoopLogOptions {
  now?: Date
  runBranch?: string
}

export interface LoopLogContext {
  currentCycle: number
  cycleCap: number
  now?: Date
}

function splitEvent(message: string): { event: string; subject: string } {
  const content = message.startsWith('[loop] ')
    ? message.slice('[loop] '.length)
    : message === '[loop]' ? '' : message
  for (const marker of ['CYCLE_COMPLETE', 'FAILED', 'LOOP_DONE']) {
    if (content.startsWith(`${marker}:`)) {
      return { event: `${marker}:`, subject: content.slice(marker.length + 1).trimStart() }
    }
  }
  if (content.startsWith('DECISION_REQUIRED')) {
    return {
      event: 'Decision',
      subject: content.slice('DECISION_REQUIRED'.length).replace(/^:\s*/, '').trimStart(),
    }
  }
  for (const event of EVENT_NAMES) {
    if (content === event) return { event, subject: '' }
    if (content.startsWith(`${event} `)) {
      return { event, subject: content.slice(event.length + 1) }
    }
    if (['WARN', 'ERROR'].includes(event) && content.startsWith(`${event}:`)) {
      return { event, subject: content.slice(event.length + 1).trimStart() }
    }
  }
  const separator = content.indexOf(' ')
  return separator === -1
    ? { event: content, subject: '' }
    : { event: content.slice(0, separator), subject: content.slice(separator + 1) }
}

/** Format a single-line event for the daemon log; detailed output belongs elsewhere. */
export function loopLogLines(message: string, context: LoopLogContext): string[] {
  const cycle = String(context.currentCycle).padStart(2, '0')
  const cap = String(context.cycleCap).padStart(2, '0')
  const prefix = `${logTimestamp(context.now ?? new Date())} [loop ${cycle}/${cap}] `
  const firstLine = message.split(/\r?\n/, 1)[0] ?? ''
  const { event, subject } = splitEvent(firstLine)
  const content = `${event.padEnd(LOOP_EVENT_NAME_WIDTH)}${subject === '' ? '' : ` ${subject}`}`
  return [`${prefix}${content}`]
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
