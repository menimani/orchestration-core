import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isScanTaskId, type OrchPaths } from './paths.ts'
import type { TaskProcess } from './taskProcesses.ts'

export const interruptedScansFileName = 'stop-interrupted-scans'

/**
 * Persist the scans that were live when an operator requested a stop. The daemon may
 * consume the stop file and terminate the processes before the stop command gets to
 * inspect them again, so callers take the live-process snapshot before publishing the
 * stop file.
 */
export function recordInterruptedScans(
  paths: OrchPaths,
  liveTasks: readonly TaskProcess[],
): void {
  const scans = liveTasks.filter((task) => isScanTaskId(task.taskId))
  if (scans.length === 0) return

  const scanCountFile = join(paths.queueDir, 'scan-count.txt')
  if (!existsSync(scanCountFile)) return
  const rawCycle = readFileSync(scanCountFile, 'utf8').trim()
  if (!/^[1-9][0-9]*$/.test(rawCycle)) return
  const cycle = Number(rawCycle)
  if (!Number.isSafeInteger(cycle)) return

  const marker = join(paths.queueDir, interruptedScansFileName)
  appendFileSync(marker, scans.map((task) => `${cycle}\t${task.taskId}\n`).join(''))
}
