import {
  mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { operatingSystem } from './adapters/os.ts'
import { branchName, statusFile, worktreeDir, type OrchPaths } from './paths.ts'
import { forgetTaskProcess, recordTaskProcess, taskProcessPid } from './processRegistry.ts'

// A task reads `running` while its runner process is alive, `completed` once the
// completion marker appears in its final-message file, and `failed` when the process is
// gone without it. Status refresh and merge can run at the same time — the loop daemon
// and a CLI invocation are separate processes — so every writer takes the same on-disk
// lock and compare-and-swap transitions refuse to overwrite a state another writer
// already changed.

export type TaskState = 'running' | 'completed' | 'failed' | 'merged' | string

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

export function readStatus(paths: OrchPaths, taskId: string): TaskStatus | undefined {
  let record: TaskStatus
  try {
    record = JSON.parse(readFileSync(statusFile(paths, taskId), 'utf8')) as TaskStatus
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  // The record is durable; the process it named is not. The registry answers for the
  // process, so a number left in an old record is not read back as a live task.
  return { ...record, pid: taskProcessPid(paths, taskId) ?? null }
}

function lockDir(paths: OrchPaths, taskId: string): string {
  return join(paths.statusDir, `.${taskId}.lock`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function lockIsAged(dir: string): boolean {
  try {
    return Date.now() - statSync(dir).mtimeMs >= 10_000
  } catch {
    return false
  }
}

async function acquireStatusLock(paths: OrchPaths, taskId: string): Promise<void> {
  const dir = lockDir(paths, taskId)
  const pidFile = join(dir, 'pid')
  for (let attempts = 0; ; attempts++) {
    try {
      mkdirSync(dir)
      writeFileSync(pidFile, `${process.pid}\n`)
      return
    } catch {
      // Lock held. Reclaim it only when its owner is provably gone: a recorded PID that
      // no longer runs, or no PID at all once the lock has aged past the window in which
      // a live owner could still be about to publish one.
      let lockPid = ''
      try {
        lockPid = readFileSync(pidFile, 'utf8').trim()
      } catch {
        // no pid published yet
      }
      if (/^[1-9][0-9]*$/.test(lockPid) && !operatingSystem.processIsAlive(Number(lockPid))) {
        try {
          rmSync(pidFile)
          rmdirSync(dir)
        } catch {
          // another waiter won the reclaim
        }
        continue
      }
      if (!/^[1-9][0-9]*$/.test(lockPid) && lockIsAged(dir)) {
        try {
          if (lockPid !== '') rmSync(pidFile)
          rmdirSync(dir)
        } catch {
          // another waiter won the reclaim
        }
        continue
      }
      if (attempts >= 1000) {
        throw new Error(`Timed out waiting for the status lock: ${taskId}`)
      }
      await sleep(10)
    }
  }
}

function releaseStatusLock(paths: OrchPaths, taskId: string): void {
  const dir = lockDir(paths, taskId)
  const pidFile = join(dir, 'pid')
  let lockPid = ''
  try {
    lockPid = readFileSync(pidFile, 'utf8').trim()
  } catch {
    return
  }
  if (lockPid !== String(process.pid)) return
  rmSync(pidFile)
  rmdirSync(dir)
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
  // The registry, not the record, is what later readers believe. Publish there first so
  // no window exists in which the record claims a process the registry does not have.
  if (pid !== undefined && Number.isInteger(pid)) recordTaskProcess(paths, taskId, pid)
  else forgetTaskProcess(paths, taskId)
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const record: TaskStatus = {
    task_id: taskId,
    status,
    pid: pid !== undefined && Number.isInteger(pid) ? pid : null,
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
}

export async function writeStatus(paths: OrchPaths, taskId: string, status: TaskState, pid?: number): Promise<void> {
  await acquireStatusLock(paths, taskId)
  try {
    writeStatusUnlocked(paths, taskId, status, pid)
  } finally {
    releaseStatusLock(paths, taskId)
  }
}

/** Record the merge verdict and the identity needed for durable issue reconciliation. */
export async function writeMergedStatus(
  paths: OrchPaths,
  taskId: string,
  mergeCommit: string,
  runBranch: string,
): Promise<void> {
  await acquireStatusLock(paths, taskId)
  try {
    writeStatusUnlocked(paths, taskId, 'merged', undefined, { mergeCommit, runBranch })
  } finally {
    releaseStatusLock(paths, taskId)
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
  await acquireStatusLock(paths, taskId)
  try {
    const current = readStatus(paths, taskId)?.status
    if (current !== expected) return false
    writeStatusUnlocked(paths, taskId, next, pid)
    return true
  } finally {
    releaseStatusLock(paths, taskId)
  }
}
