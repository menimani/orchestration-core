import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrchPaths } from './paths.ts'

function timestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

function safeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

export interface PrepareLoopLogOptions {
  now?: Date
  runBranch?: string
}

/** Prepare the process-wide loop log before the daemon opens it for append. */
export function prepareLoopLog(
  paths: OrchPaths,
  options: PrepareLoopLogOptions = {},
): void {
  const loopLog = join(paths.logsDir, 'loop.log')
  const branchMarker = join(paths.logsDir, 'loop.log.branch')
  const runBranchFile = join(paths.queueDir, 'run-branch.txt')
  const runBranch = options.runBranch ?? (existsSync(runBranchFile)
    ? readFileSync(runBranchFile, 'utf8').trim()
    : '')
  const loggedBranch = existsSync(branchMarker)
    ? readFileSync(branchMarker, 'utf8').trim()
    : undefined

  if (existsSync(loopLog) && (loggedBranch === undefined || loggedBranch !== runBranch)) {
    const oldBranch = loggedBranch ?? runBranch
    renameSync(
      loopLog,
      join(paths.logsDir, `loop-${safeBranchName(oldBranch)}-${timestamp(options.now ?? new Date())}.log`),
    )
  }

  if (!existsSync(loopLog)) writeFileSync(loopLog, '')
  writeFileSync(branchMarker, `${runBranch}\n`)
}
