import { randomUUID } from 'node:crypto'
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { operatingSystem } from './adapters/os.ts'
import {
  currentProcessStartIdentity, decodeProcessStartIdentity, encodeProcessStartIdentity,
  lockOwnerIsCurrent,
} from './processOwner.ts'

const LOCK_RETRY_MS = 10
const LOCK_RETRY_MAX_MS = 250
const OWNER_GRACE_MS = 30_000
// While one acquisition waits, an unchanged owner verified as current is trusted this
// long: on Windows each verification starts PowerShell, which can cost seconds.
const OWNER_REVERIFY_MS = 1_000
const sleepBuffer = new SharedArrayBuffer(4)
const releasedOwnedLockTokens = new Set<string>()

/** Owner text last verified as current, per lock path, during one acquisition. */
type OwnerVerifications = Map<string, { owner: string, verifiedAt: number }>
function ownerText(lockDir: string): string {
  try {
    return readFileSync(join(lockDir, 'owner'), 'utf8').trim()
  } catch {
    return ''
  }
}

function lockOwnerIsStale(lockDir: string, verified?: OwnerVerifications): boolean {
  // Release publishes this durable marker before attempting the directory rename.
  // Unlike the process-local token cache, it remains visible to other processes when
  // Windows refuses to rename a lock whose owning daemon is still alive.
  if (existsSync(join(lockDir, 'retired'))) return true

  const lockIsAged = (): boolean => {
    try {
      return Date.now() - statSync(lockDir).mtimeMs >= OWNER_GRACE_MS
    } catch {
      return false
    }
  }
  // The creator may still be between mkdir and publishing its owner metadata. The
  // token is optional so locks created by an older installed core remain readable.
  const owner = ownerText(lockDir)
  const [pidRaw, createdRaw, token, ...extra] = owner.split(/\s+/)
  const pid = Number(pidRaw)
  const created = Number(createdRaw)
  if (token !== undefined && releasedOwnedLockTokens.has(token)) return true
  if (
    !/^[1-9]\d*$/.test(pidRaw ?? '')
    || !/^\d+$/.test(createdRaw ?? '')
    || !Number.isSafeInteger(pid)
    || !Number.isSafeInteger(created)
    || extra.length > 0
  ) {
    return lockIsAged()
  }
  // Keep the legacy three-field format: older cores treat the third field as opaque.
  const startIdentity = token?.startsWith('v2.')
    ? decodeProcessStartIdentity(token.split('.')[2])
    : undefined
  // Only a current verdict is remembered, so staleness always comes from a fresh query.
  const remembered = verified?.get(lockDir)
  if (
    remembered !== undefined
    && remembered.owner === owner
    && Date.now() - remembered.verifiedAt < OWNER_REVERIFY_MS
  ) {
    return false
  }
  if (lockOwnerIsCurrent(pid, startIdentity)) {
    verified?.set(lockDir, { owner, verifiedAt: Date.now() })
    return false
  }
  verified?.delete(lockDir)
  return Date.now() - created >= OWNER_GRACE_MS
}

function ownedLock(lockDir: string): string {
  const identity = encodeProcessStartIdentity(currentProcessStartIdentity())
  const token = `v2.${randomUUID()}.${identity}`
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

  const displaced = `${lockDir}.released.${process.pid}-${randomUUID()}`
  try {
    writeFileSync(join(lockDir, 'retired'), '', { flag: 'wx' })
  } catch {
    // The preferred atomic rename can still release the lock. Keep the local token
    // fallback for filesystems that reject both marker publication and the rename.
  }
  try {
    renameSync(lockDir, displaced)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    // The mutation has already committed. Keep its result observable and let the next
    // acquisition reclaim this exact token even while this process remains alive.
    releasedOwnedLockTokens.add(token)
    return
  }
  releasedOwnedLockTokens.delete(token)

  // Revalidate after the atomic displacement so a racing replacement is never erased.
  if (ownerText(displaced).split(/\s+/)[2] !== token) {
    if (!existsSync(lockDir)) renameSync(displaced, lockDir)
    return
  }
  try {
    operatingSystem.removeDirectory(displaced)
  } catch {
    // The public lock name is already free; removal of the private remnant is best effort.
  }
}

/** Reclaim an abandoned recovery mutex without deleting a successor's owner token. */
function recoverStaleMutex(mutexDir: string, verified: OwnerVerifications): boolean {
  if (!lockOwnerIsStale(mutexDir, verified)) return false
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

function tryAcquireRecoveryMutex(
  lockDir: string,
  verified: OwnerVerifications,
): string | undefined {
  const mutexDir = `${lockDir}.recovery`
  try {
    return ownedLock(mutexDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    recoverStaleMutex(mutexDir, verified)
    return undefined
  }
}

/** Revalidate and remove a stale main lock while every new acquisition is serialized. */
function recoverStaleLock(lockDir: string, verified: OwnerVerifications): boolean {
  if (!lockOwnerIsStale(lockDir, verified)) return false
  operatingSystem.removeDirectory(lockDir)
  return true
}

function tryAcquireBacklogLock(
  lockDir: string,
  verified: OwnerVerifications,
): string | undefined {
  const recoveryToken = tryAcquireRecoveryMutex(lockDir, verified)
  if (recoveryToken === undefined) return undefined
  try {
    if (existsSync(lockDir) && !recoverStaleLock(lockDir, verified)) return undefined
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
  // Bound the wait by elapsed time, not attempts: an attempt against a live owner can
  // run a synchronous process-identity lookup that costs far more than the retry delay.
  const deadline = Date.now() + OWNER_GRACE_MS
  // Back off while the lock stays held: every attempt churns the recovery mutex and
  // re-reads the owner, so a fixed short delay turns a long hold into thousands of them.
  let delay = LOCK_RETRY_MS
  // Spare a waiter one identity query per retry behind the same live owner.
  const verified: OwnerVerifications = new Map()
  let lockToken: string
  for (;;) {
    const acquired = tryAcquireBacklogLock(lockDir, verified)
    if (acquired !== undefined) {
      lockToken = acquired
      break
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for the backlog lock: ${backlog}`)
    }
    Atomics.wait(new Int32Array(sleepBuffer), 0, 0, Math.min(delay, remaining))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
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
