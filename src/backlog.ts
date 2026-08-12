import { randomUUID } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, toNamespacedPath } from 'node:path'
import { operatingSystem } from './adapters/os.ts'

const LOCK_RETRY_MS = 10
const OWNER_GRACE_MS = 30_000
const MAX_LOCK_RETRIES = Math.ceil(OWNER_GRACE_MS / LOCK_RETRY_MS)
const sleepBuffer = new SharedArrayBuffer(4)

function ownerText(lockDir: string): string {
  try {
    return readFileSync(join(lockDir, 'owner'), 'utf8').trim()
  } catch {
    return ''
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
  // The creator may still be between mkdir and publishing its owner metadata. The
  // token is optional so locks created by an older installed core remain readable.
  const [pidRaw, createdRaw, _token, ...extra] = ownerText(lockDir).split(/\s+/)
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
  if (operatingSystem.processIsAlive(pid)) return false
  return Date.now() - created >= OWNER_GRACE_MS
}

function ownedLock(lockDir: string): string {
  const token = randomUUID()
  mkdirSync(lockDir)
  try {
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()} ${token}\n`)
  } catch (error) {
    operatingSystem.removeDirectory(lockDir)
    throw error
  }
  return token
}

function releaseOwnedLock(lockDir: string, token: string): void {
  if (ownerText(lockDir).split(/\s+/)[2] !== token) return
  try {
    // Empty-directory removal cannot erase a successor: if one publishes after the
    // owner file disappears, its metadata makes this operation fail instead.
    rmSync(toNamespacedPath(join(lockDir, 'owner')), { force: true })
    rmdirSync(toNamespacedPath(lockDir))
  } catch {
    // Ownership has already ended or a successor won the publication race.
  }
}

/** Reclaim an abandoned recovery mutex without deleting a successor's owner token. */
function recoverStaleMutex(mutexDir: string): boolean {
  if (!lockOwnerIsStale(mutexDir)) return false
  const observedOwner = ownerText(mutexDir)
  const displaced = `${mutexDir}.${process.pid}-${randomUUID()}`
  try {
    renameSync(mutexDir, displaced)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'EPERM') return false
    throw error
  }

  // Only remove the exact stale owner observed before the rename. If the snapshot was
  // replaced, restore it when no successor has already acquired the mutex.
  if (ownerText(displaced) !== observedOwner || !lockOwnerIsStale(displaced)) {
    if (!existsSync(mutexDir)) renameSync(displaced, mutexDir)
    return false
  }
  operatingSystem.removeDirectory(displaced)
  return true
}

function tryAcquireRecoveryMutex(lockDir: string): string | undefined {
  const mutexDir = `${lockDir}.recovery`
  try {
    return ownedLock(mutexDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    recoverStaleMutex(mutexDir)
    return undefined
  }
}

/** Revalidate and remove a stale main lock while every new acquisition is serialized. */
function recoverStaleLock(lockDir: string): boolean {
  if (!lockOwnerIsStale(lockDir)) return false
  operatingSystem.removeDirectory(lockDir)
  return true
}

function tryAcquireBacklogLock(lockDir: string): string | undefined {
  const recoveryToken = tryAcquireRecoveryMutex(lockDir)
  if (recoveryToken === undefined) return undefined
  try {
    if (existsSync(lockDir) && !recoverStaleLock(lockDir)) return undefined
    try {
      return ownedLock(lockDir)
    } catch (error) {
      // A process running an older core can still race by acquiring without the mutex.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
      throw error
    }
  } finally {
    releaseOwnedLock(`${lockDir}.recovery`, recoveryToken)
  }
}

/** Serialize backlog read-modify-write operations across loop and CLI processes. */
export function withBacklogLock<T>(backlog: string, mutation: () => T): T {
  const lockDir = `${backlog}.lock`
  let lockToken: string
  for (let attempts = 0; ; attempts++) {
    const acquired = tryAcquireBacklogLock(lockDir)
    if (acquired !== undefined) {
      lockToken = acquired
      break
    }
    if (attempts >= MAX_LOCK_RETRIES) {
      throw new Error(`Timed out waiting for the backlog lock: ${backlog}`)
    }
    Atomics.wait(new Int32Array(sleepBuffer), 0, 0, LOCK_RETRY_MS)
  }

  try {
    return mutation()
  } finally {
    releaseOwnedLock(lockDir, lockToken)
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
