import { randomUUID } from 'node:crypto'
import {
  mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { operatingSystem } from './adapters/os.ts'
import { branchName, statusFile, worktreeDir, type OrchPaths } from './paths.ts'
import { currentProcessStartIdentity, lockOwnerIsCurrent } from './processOwner.ts'
import {
  forgetTaskProcess, recordTaskProcess, taskProcessPid, type ProcessIsAlive,
  type ProcessStartIdentity,
} from './processRegistry.ts'

// A task reads `running` while its runner process is alive, `completed` once the
// completion marker appears in its final-message file, `no-change` after its explicit
// no-change verdict is accepted, and `failed` when the process is gone without completion.
// Status refresh and merge can run at the same time — the loop daemon
// and a CLI invocation are separate processes — so every writer takes the same on-disk
// lock and compare-and-swap transitions refuse to overwrite a state another writer
// already changed.

export type TaskState = 'running' | 'completed' | 'failed' | 'merged' | 'no-change' | string

export interface TaskStatus {
  task_id: string
  status: TaskState
  pid: number | null
  started_at: string
  updated_at: string
  worktree: string
  branch: string
  /** Durable merge identity used to finish issue reconciliation after a restart. */
  merge_commit?: string
  run_branch?: string
}

interface StatusMetadata {
  mergeCommit: string
  runBranch: string
}

type DurableTaskStatus = Omit<TaskStatus, 'pid'>

export function readStatus(
  paths: OrchPaths,
  taskId: string,
  processStartIdentity: ProcessStartIdentity = operatingSystem.processStartIdentity,
  processIsAlive: ProcessIsAlive = operatingSystem.processIsAlive,
): TaskStatus | undefined {
  let record: DurableTaskStatus
  try {
    record = JSON.parse(readFileSync(statusFile(paths, taskId), 'utf8')) as DurableTaskStatus
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  // The record is durable; the process it named is not. The registry answers for the
  // process, so a number left in an old record is not read back as a live task.
  return {
    ...record,
    pid: taskProcessPid(paths, taskId, undefined, processStartIdentity, processIsAlive) ?? null,
  }
}

function lockDir(paths: OrchPaths, taskId: string): string {
  return join(paths.statusDir, `.${taskId}.lock`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const STATUS_LOCK_WAIT_MS = 10_000
const STATUS_LOCK_RETRY_MS = 10

function lockIsAged(dir: string): boolean {
  try {
    return Date.now() - statSync(dir).mtimeMs >= 10_000
  } catch {
    return false
  }
}

function lockRemovalWasVerified(dir: string): boolean {
  try {
    statSync(dir)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

async function acquireStatusLock(paths: OrchPaths, taskId: string): Promise<string> {
  const dir = lockDir(paths, taskId)
  const pidFile = join(dir, 'pid')
  const identityFile = join(dir, 'start-identity')
  const owner = JSON.stringify(currentProcessStartIdentity())
  const deadline = Date.now() + STATUS_LOCK_WAIT_MS
  for (;;) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the status lock: ${taskId}`)
    }
    try {
      mkdirSync(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (!statSync(dir).isDirectory()) throw error
      } catch (inspectionError) {
        // The directory may have been released between mkdir and inspection.
        if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      // Lock held. Reclaim it only when its owner is provably gone: a recorded PID that
      // no longer runs, or no PID at all once the lock has aged past the window in which
      // a live owner could still be about to publish one.
      let recordedOwner = ''
      try {
        recordedOwner = readFileSync(pidFile, 'utf8').trim()
      } catch {
        // no pid published yet
      }
      const validOwner = /^[1-9][0-9]*$/.test(recordedOwner)
      let startIdentity: string | undefined
      try {
        const parsed = JSON.parse(readFileSync(identityFile, 'utf8')) as unknown
        if (typeof parsed === 'string' && parsed !== '') startIdentity = parsed
      } catch {
        // Legacy owner or identity not published yet.
      }
      if (validOwner && !lockOwnerIsCurrent(Number(recordedOwner), startIdentity)) {
        try {
          rmSync(identityFile, { force: true })
          rmSync(pidFile)
          rmdirSync(dir)
        } catch {
          // another waiter won the reclaim
        }
        // A persistent filesystem error can leave the stale directory behind. Verify
        // reclamation and use the same bounded, sleeping retry as ordinary contention.
        if (lockRemovalWasVerified(dir)) continue
        await sleep(STATUS_LOCK_RETRY_MS)
        continue
      }
      if (!validOwner && lockIsAged(dir)) {
        try {
          if (recordedOwner !== '') rmSync(pidFile)
          rmdirSync(dir)
        } catch {
          // another waiter won the reclaim
        }
        if (lockRemovalWasVerified(dir)) continue
        await sleep(STATUS_LOCK_RETRY_MS)
        continue
      }
      await sleep(STATUS_LOCK_RETRY_MS)
      continue
    }

    try {
      // Keep the PID file readable by older cores and publish identity separately.
      writeFileSync(pidFile, `${process.pid}\n`)
      writeFileSync(identityFile, `${owner}\n`)
      return owner
    } catch (error) {
      // Publishing metadata is part of acquisition, not contention. A writer that
      // cannot finish it must not leave its own PID looking like a live lock owner.
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
      throw error
    }
  }
}

function releaseStatusLock(paths: OrchPaths, taskId: string, owner: string): void {
  const dir = lockDir(paths, taskId)
  const pidFile = join(dir, 'pid')
  const identityFile = join(dir, 'start-identity')
  let recordedPid = ''
  let recordedOwner = ''
  try {
    recordedPid = readFileSync(pidFile, 'utf8').trim()
    recordedOwner = readFileSync(identityFile, 'utf8').trim()
  } catch {
    return
  }
  if (recordedPid !== String(process.pid) || recordedOwner !== owner) return
  const releasedDir = join(paths.statusDir, `.${taskId}.lock.released-${randomUUID()}`)
  // Renaming the whole lock is the release operation. Once it succeeds, failures
  // while removing the retired metadata cannot leave a live-looking owner at the
  // well-known lock path or block the next writer.
  renameSync(dir, releasedDir)
  try {
    rmSync(releasedDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
  } catch {
    // The lock is already released; leave its uniquely named remains for later cleanup.
  }
}

function writeStatusUnlocked(
  paths: OrchPaths,
  taskId: string,
  status: TaskState,
  pid?: number,
  metadata?: StatusMetadata,
): void {
  const file = statusFile(paths, taskId)
  const temporaryFile = join(paths.statusDir, `.${taskId}.${process.pid}.tmp`)
  const existing = readStatus(paths, taskId)
  const existingPid = taskProcessPid(paths, taskId)
  // The registry, not the record, is what later readers believe. Publish a new owner
  // before its running status, but keep an existing owner visible until a terminal
  // status has been published successfully.
  // Rewriting a status for the same PID must also preserve whether launch captured its
  // start identity; a later successful probe cannot make an initially unsafe PID safe.
  if (pid !== undefined && Number.isInteger(pid) && pid !== existingPid) {
    recordTaskProcess(paths, taskId, pid)
  }
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const record: DurableTaskStatus = {
    task_id: taskId,
    status,
    started_at: existing?.started_at ?? now,
    updated_at: now,
    worktree: worktreeDir(paths, taskId),
    branch: branchName(taskId),
    ...(metadata === undefined ? {} : {
      merge_commit: metadata.mergeCommit,
      run_branch: metadata.runBranch,
    }),
  }
  try {
    // Publishing with a same-directory rename prevents readers from observing a
    // truncated JSON document if this process exits while writing the new record.
    writeFileSync(temporaryFile, `${JSON.stringify(record, null, 2)}\n`)
    renameSync(temporaryFile, file)
  } finally {
    rmSync(temporaryFile, { force: true })
  }
  if (pid === undefined || !Number.isInteger(pid)) forgetTaskProcess(paths, taskId)
}

export async function writeStatus(paths: OrchPaths, taskId: string, status: TaskState, pid?: number): Promise<void> {
  const owner = await acquireStatusLock(paths, taskId)
  try {
    writeStatusUnlocked(paths, taskId, status, pid)
  } finally {
    releaseStatusLock(paths, taskId, owner)
  }
}

/** Record the merge verdict and the identity needed for durable issue reconciliation. */
export async function writeMergedStatus(
  paths: OrchPaths,
  taskId: string,
  mergeCommit: string,
  runBranch: string,
): Promise<void> {
  const owner = await acquireStatusLock(paths, taskId)
  try {
    writeStatusUnlocked(paths, taskId, 'merged', undefined, { mergeCommit, runBranch })
  } finally {
    releaseStatusLock(paths, taskId, owner)
  }
}

/**
 * Compare-and-swap: write `next` only when the current status is `expected`.
 * Returns false without writing when another process already changed it.
 */
export async function transitionStatus(
  paths: OrchPaths,
  taskId: string,
  expected: TaskState,
  next: TaskState,
  pid?: number,
): Promise<boolean> {
  const owner = await acquireStatusLock(paths, taskId)
  try {
    const current = readStatus(paths, taskId)?.status
    if (current !== expected) return false
    writeStatusUnlocked(paths, taskId, next, pid)
    return true
  } finally {
    releaseStatusLock(paths, taskId, owner)
  }
}
