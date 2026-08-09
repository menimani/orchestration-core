import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrchPaths } from './paths.ts'

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

/** Normalize even multiline failures so every physical daemon-log line is identifiable. */
export function loopLogLines(message: string, now: Date = new Date()): string[] {
  const prefix = `[loop] ${logTimestamp(now)} `
  return message.split(/\r?\n/).map((line) => {
    if (line.startsWith('[loop] ')) return `${prefix}${line.slice('[loop] '.length)}`
    if (line === '[loop]') return prefix
    return `${prefix}${line}`
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
