import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'
import type { OrchPaths } from './paths.ts'

// A process identifier is true only while that process runs, but a task's status record
// outlives it. Recording the PID inside that durable record made a dead task's number
// survive a stop and a reboot, and the operating system hands the number to something
// else — after a restart it starts handing out low numbers again. Whoever then read the
// record could refuse to start ("a task is already running"), or terminate a process
// tree that belongs to a stranger.
//
// So a PID lives here instead, in a store whose lifetime matches what it describes: the
// entry is removed when the process is stopped, and an entry written before the current
// boot is not believed. Nothing migrates — a PID left in an old status record is simply
// no longer read, which is the same verdict this store would give it.

/** Clock granularity between a recorded time and the boot time derived from uptime. */
const BOOT_COMPARISON_TOLERANCE_MS = 5_000

function registryDir(paths: OrchPaths): string {
  return join(paths.queueDir, 'pids')
}

function registryFile(paths: OrchPaths, taskId: string): string {
  return join(registryDir(paths), taskId)
}

/** When the running system started, in epoch milliseconds. */
export function bootedAt(now: () => number = Date.now, up: () => number = uptime): number {
  return now() - up() * 1000
}

/** Record the process now running `taskId`. Replaces any earlier entry. */
export function recordTaskProcess(paths: OrchPaths, taskId: string, pid: number): void {
  mkdirSync(registryDir(paths), { recursive: true })
  writeFileSync(registryFile(paths, taskId), `${pid}\n`)
}

/** Forget the process for `taskId`. Safe to call when nothing was recorded. */
export function forgetTaskProcess(paths: OrchPaths, taskId: string): void {
  rmSync(registryFile(paths, taskId), { force: true })
}

/**
 * The process recorded for `taskId`, or undefined when none is or a recorded one predates
 * this boot. A stale entry is dropped as it is read, so the answer does not change again.
 */
export function taskProcessPid(
  paths: OrchPaths,
  taskId: string,
  boot: () => number = bootedAt,
): number | undefined {
  const file = registryFile(paths, taskId)
  let recorded: string
  let writtenAt: number
  try {
    recorded = readFileSync(file, 'utf8').trim()
    writtenAt = statSync(file).mtimeMs
  } catch {
    return undefined
  }

  if (!/^[1-9][0-9]*$/.test(recorded)) {
    forgetTaskProcess(paths, taskId)
    return undefined
  }
  if (writtenAt + BOOT_COMPARISON_TOLERANCE_MS < boot()) {
    forgetTaskProcess(paths, taskId)
    return undefined
  }
  return Number(recorded)
}
