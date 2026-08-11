import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const LOCK_RETRY_MS = 10
const OWNER_GRACE_MS = 30_000
const MAX_LOCK_RETRIES = Math.ceil(OWNER_GRACE_MS / LOCK_RETRY_MS)
const sleepBuffer = new SharedArrayBuffer(4)

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function lockOwnerIsStale(lockDir: string): boolean {
  const lockIsAged = (): boolean => {
    try {
      return Date.now() - statSync(lockDir).mtimeMs >= OWNER_GRACE_MS
    } catch {
      return false
    }
  }
  const ownerFile = join(lockDir, 'owner')
  let owner = ''
  try {
    owner = readFileSync(ownerFile, 'utf8').trim()
  } catch {
    // The creator may still be between mkdir and publishing its owner metadata.
  }
  const [pidRaw, createdRaw, ...extra] = owner.split(/\s+/)
  const pid = Number(pidRaw)
  const created = Number(createdRaw)
  if (
    !/^[1-9]\d*$/.test(pidRaw ?? '')
    || !/^\d+$/.test(createdRaw ?? '')
    || !Number.isSafeInteger(pid)
    || !Number.isSafeInteger(created)
    || extra.length > 0
  ) {
    return lockIsAged()
  }
  if (processIsAlive(pid)) return false
  return Date.now() - created >= OWNER_GRACE_MS
}

function recoverStaleLock(lockDir: string): boolean {
  const recoveryDir = `${lockDir}.recovery`
  try {
    mkdirSync(recoveryDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }

  try {
    // Another waiter may have replaced the stale lock while this process waited for
    // the recovery mutex. Only the current owner snapshot may be reclaimed.
    if (!lockOwnerIsStale(lockDir)) return false
    try {
      rmSync(lockDir, { recursive: true })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  } finally {
    rmSync(recoveryDir, { recursive: true, force: true })
  }
}

/** Serialize backlog read-modify-write operations across loop and CLI processes. */
export function withBacklogLock<T>(backlog: string, mutation: () => T): T {
  const lockDir = `${backlog}.lock`
  for (let attempts = 0; ; attempts++) {
    try {
      mkdirSync(lockDir)
      try {
        writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()}\n`)
      } catch (error) {
        rmSync(lockDir, { recursive: true, force: true })
        throw error
      }
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      if (lockOwnerIsStale(lockDir) && recoverStaleLock(lockDir)) continue
      if (attempts >= MAX_LOCK_RETRIES) {
        throw new Error(`Timed out waiting for the backlog lock: ${backlog}`)
      }
      Atomics.wait(new Int32Array(sleepBuffer), 0, 0, LOCK_RETRY_MS)
    }
  }

  try {
    return mutation()
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}

export function ensureBacklog(backlog: string): void {
  withBacklogLock(backlog, () => {
    if (!existsSync(backlog)) writeFileSync(backlog, '')
  })
}

export function appendBacklogUnless(
  backlog: string,
  shouldSkip: (lines: readonly string[]) => boolean,
  line: string,
): boolean {
  return withBacklogLock(backlog, () => {
    const lines = existsSync(backlog)
      ? readFileSync(backlog, 'utf8').split(/\r?\n/).filter((entry) => entry !== '')
      : []
    if (shouldSkip(lines)) return false
    appendFileSync(backlog, `${line}\n`)
    return true
  })
}

export function dequeueBacklog(
  backlog: string,
  shouldDequeue: (line: string) => boolean = () => true,
): string | undefined {
  return withBacklogLock(backlog, () => {
    const lines = readFileSync(backlog, 'utf8').split(/\r?\n/).filter((line) => line !== '')
    const index = lines.findIndex(shouldDequeue)
    if (index === -1) return undefined
    const [first] = lines.splice(index, 1)
    if (first === undefined) return undefined

    const replacement = join(
      dirname(backlog),
      `.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.backlog.tmp`,
    )
    try {
      writeFileSync(replacement, lines.map((line) => `${line}\n`).join(''))
      renameSync(replacement, backlog)
    } finally {
      rmSync(replacement, { force: true })
    }
    return first
  })
}
