import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'
import { operatingSystem } from './adapters/os.ts'
import type { OrchPaths } from './paths.ts'

// A process identifier is true only while that process runs, but a task's status record
// outlives it. Recording the PID inside that durable record made a dead task's number
// survive a stop and a reboot, and the operating system hands the number to something
// else — after a restart it starts handing out low numbers again. Whoever then read the
// record could refuse to start ("a task is already running"), or terminate a process
// tree that belongs to a stranger.
//
// So a PID lives here instead, in a store whose lifetime matches what it describes: the
// entry is removed when the process is stopped, and a confirmed process-start identity
// mismatch invalidates it. A temporarily unavailable identity probe leaves ownership in
// place until a later probe can decide. Nothing migrates — a PID left in an old status
// record is simply no longer read, which is the same verdict this store gives.

/** Clock granularity between a recorded time and the boot time derived from uptime. */
const BOOT_COMPARISON_TOLERANCE_MS = 5_000

interface VerifiedProcessRegistryEntry {
  pid: number
  startIdentity: string
}

interface UnverifiedProcessRegistryEntry {
  pid: number
  startIdentity: null
}

type ProcessRegistryEntry = VerifiedProcessRegistryEntry | UnverifiedProcessRegistryEntry

export type ProcessStartIdentity = (pid: number) => string | undefined
export type ProcessIsAlive = (pid: number) => boolean

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
export function recordTaskProcess(
  paths: OrchPaths,
  taskId: string,
  pid: number,
  processStartIdentity: ProcessStartIdentity = operatingSystem.processStartIdentity,
  processIsAlive: ProcessIsAlive = operatingSystem.processIsAlive,
): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    forgetTaskProcess(paths, taskId)
    return
  }
  let startIdentity: string | undefined
  try {
    startIdentity = processStartIdentity(pid)
  } catch {
    startIdentity = undefined
  }
  if (startIdentity === undefined) {
    let alive = true
    try {
      alive = processIsAlive(pid)
    } catch {
      // An unavailable liveness probe does not prove that the process stopped.
    }
    if (!alive) {
      forgetTaskProcess(paths, taskId)
      return
    }
  }
  mkdirSync(registryDir(paths), { recursive: true })
  writeFileSync(registryFile(paths, taskId), `${JSON.stringify({
    pid, startIdentity: startIdentity ?? null,
  })}\n`)
}

/** Forget the process for `taskId`. Safe to call when nothing was recorded. */
export function forgetTaskProcess(paths: OrchPaths, taskId: string): void {
  rmSync(registryFile(paths, taskId), { force: true })
}

function registeredTaskProcessPid(
  paths: OrchPaths,
  taskId: string,
  boot: () => number,
  processStartIdentity: ProcessStartIdentity,
  processIsAlive: ProcessIsAlive,
  requireVerifiedIdentity: boolean,
): number | undefined {
  const file = registryFile(paths, taskId)
  let recorded: string
  let entry: ProcessRegistryEntry
  let writtenAt: number
  try {
    recorded = readFileSync(file, 'utf8')
    writtenAt = statSync(file).mtimeMs
  } catch {
    return undefined
  }
  try {
    entry = JSON.parse(recorded) as ProcessRegistryEntry
  } catch {
    forgetTaskProcess(paths, taskId)
    return undefined
  }

  if (entry === null || typeof entry !== 'object'
    || !Number.isSafeInteger(entry.pid) || entry.pid <= 0
    || (typeof entry.startIdentity !== 'string' && entry.startIdentity !== null)
    || entry.startIdentity === '') {
    forgetTaskProcess(paths, taskId)
    return undefined
  }
  if (writtenAt + BOOT_COMPARISON_TOLERANCE_MS < boot()) {
    forgetTaskProcess(paths, taskId)
    return undefined
  }
  if (requireVerifiedIdentity && entry.startIdentity === null) return undefined
  let currentStartIdentity: string | undefined
  try {
    currentStartIdentity = processStartIdentity(entry.pid)
  } catch {
    currentStartIdentity = undefined
  }
  if (currentStartIdentity === undefined) {
    let alive = true
    try {
      alive = processIsAlive(entry.pid)
    } catch {
      // An unavailable liveness probe does not prove that the process stopped.
    }
    if (alive) return requireVerifiedIdentity ? undefined : entry.pid
    forgetTaskProcess(paths, taskId)
    return undefined
  }
  if (entry.startIdentity !== null && currentStartIdentity !== entry.startIdentity) {
    forgetTaskProcess(paths, taskId)
    return undefined
  }
  return entry.pid
}

/**
 * The process recorded for `taskId`, or undefined when none is or it is confirmed stale.
 * An unverifiable identity keeps the recorded ownership as a blocker. A confirmed stale
 * entry is dropped as it is read, so the answer does not change again.
 */
export function taskProcessPid(
  paths: OrchPaths,
  taskId: string,
  boot: () => number = bootedAt,
  processStartIdentity: ProcessStartIdentity = operatingSystem.processStartIdentity,
  processIsAlive: ProcessIsAlive = operatingSystem.processIsAlive,
): number | undefined {
  return registeredTaskProcessPid(
    paths, taskId, boot, processStartIdentity, processIsAlive, false,
  )
}

/**
 * The verified process recorded for `taskId`, or undefined when it must not be terminated.
 * An identity missing at launch can never be recovered safely: the PID may have been reused
 * before a later probe succeeded, so the unverified entry remains only as a blocker.
 */
export function terminableTaskProcessPid(
  paths: OrchPaths,
  taskId: string,
  boot: () => number = bootedAt,
  processStartIdentity: ProcessStartIdentity = operatingSystem.processStartIdentity,
  processIsAlive: ProcessIsAlive = operatingSystem.processIsAlive,
): number | undefined {
  return registeredTaskProcessPid(
    paths, taskId, boot, processStartIdentity, processIsAlive, true,
  )
}
