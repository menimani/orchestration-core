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
// A step that meets a path another process moved, removed, or recreated fails with one
// of these, as each platform reports it. Each means a lost race, never a broken lock.
const LOST_RACE_CODES = new Set(['ENOENT', 'EPERM', 'EEXIST', 'ENOTEMPTY', 'EBUSY'])
const sleepBuffer = new SharedArrayBuffer(4)
const releasedOwnedLockTokens = new Set<string>()

/** Owner text last verified as current, per lock path, during one acquisition. */
type OwnerVerifications = Map<string, { owner: string, verifiedAt: number }>

/** A held recovery mutex and the private directory its fenced steps move locks into. */
interface RecoveryMutex { token: string, fence: string }

function lostRace(error: unknown): boolean {
  return LOST_RACE_CODES.has((error as NodeJS.ErrnoException).code ?? '')
}

function ownerText(lockDir: string): string {
  try {
    return readFileSync(join(lockDir, 'owner'), 'utf8').trim()
  } catch {
    return ''
  }
}

function lockOwnerIsStale(lockDir: string, verified?: OwnerVerifications): boolean {
  // Release publishes this durable marker when the directory rename fails. Unlike the
  // process-local token cache, it remains visible to other processes when Windows
  // refuses to rename a lock whose owning daemon is still alive.
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

/** Remove a private remnant unless another process already removed or still holds it. */
function removeRemnant(path: string): void {
  try {
    operatingSystem.removeDirectory(path)
  } catch (error) {
    if (!lostRace(error)) throw error
  }
}

/** Create a lock directory and publish its owner; undefined when the name is lost. */
function ownedLock(lockDir: string): string | undefined {
  const identity = encodeProcessStartIdentity(currentProcessStartIdentity())
  const token = `v2.${randomUUID()}.${identity}`
  try {
    mkdirSync(lockDir)
  } catch (error) {
    // Windows reports a name still pending deletion as EPERM rather than EEXIST.
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST' || code === 'EPERM') return undefined
    throw error
  }
  try {
    // Exclusive: when the new directory was displaced and the name recreated, only one
    // of the two creators can publish an owner into what now stands there.
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()} ${token}\n`, { flag: 'wx' })
  } catch (error) {
    // Whatever stands at the name is no longer provably this process's to remove.
    if (lostRace(error)) return undefined
    operatingSystem.removeDirectory(lockDir)
    throw error
  }
  return token
}

/** Put back a lock displaced by mistake, or remove it when its name was taken meanwhile. */
function restoreDisplaced(displaced: string, lockDir: string): void {
  if (!existsSync(lockDir)) {
    try {
      renameSync(displaced, lockDir)
      return
    } catch (error) {
      if (!lostRace(error)) throw error
    }
  }
  // Its owner reads a foreign or missing owner at the name and never releases it.
  removeRemnant(displaced)
}

function releaseOwnedLock(lockDir: string, token: string, restoreForeign: boolean): void {
  if (ownerText(lockDir).split(/\s+/)[2] !== token) return

  const displaced = `${lockDir}.released.${process.pid}-${randomUUID()}`
  try {
    renameSync(lockDir, displaced)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    // The mutation has already committed. Keep its result observable and let the next
    // acquisition reclaim this exact token even while this process remains alive. The
    // marker follows the failed rename: published before it, the marker let a recoverer
    // replace the lock in time for this rename to displace the successor.
    try {
      writeFileSync(join(lockDir, 'retired'), '', { flag: 'wx' })
    } catch {
      // The local token remains for filesystems that reject both the rename and the marker.
    }
    releasedOwnedLockTokens.add(token)
    return
  }
  releasedOwnedLockTokens.delete(token)

  // Revalidate after the atomic displacement so a racing replacement is never erased.
  if (ownerText(displaced).split(/\s+/)[2] !== token) {
    if (restoreForeign) restoreDisplaced(displaced, lockDir)
    else removeRemnant(displaced)
    return
  }
  try {
    operatingSystem.removeDirectory(displaced)
  } catch {
    // The public lock name is already free; removal of the private remnant is best effort.
  }
}

/** Reclaim an abandoned recovery mutex; true when the stale owner observed was removed. */
function recoverStaleMutex(mutexDir: string, verified: OwnerVerifications): boolean {
  if (!lockOwnerIsStale(mutexDir, verified)) return false
  const observedOwner = ownerText(mutexDir)
  const displaced = `${mutexDir}.${process.pid}-${randomUUID()}`
  try {
    renameSync(mutexDir, displaced)
  } catch (error) {
    if (lostRace(error)) return false
    throw error
  }

  // No rename is conditional on what it moves, so a successor may have acquired the
  // mutex since the observation. It is never restored: a restore can land after a third
  // process held the name in between. Its fence leaves with it and its next step fails.
  const recovered = ownerText(displaced) === observedOwner && lockOwnerIsStale(displaced)
  removeRemnant(displaced)
  return recovered
}

function tryAcquireRecoveryMutex(
  lockDir: string,
  verified: OwnerVerifications,
): RecoveryMutex | undefined {
  const mutexDir = `${lockDir}.recovery`
  const token = ownedLock(mutexDir)
  if (token === undefined) {
    recoverStaleMutex(mutexDir, verified)
    return undefined
  }
  // Breaking the main lock moves it into this directory, which exists only inside this
  // process's mutex: once another process displaces the mutex, that step fails.
  const fence = join(mutexDir, `fence.${randomUUID()}`)
  try {
    mkdirSync(fence)
  } catch (error) {
    releaseOwnedLock(mutexDir, token, false)
    if (lostRace(error)) return undefined
    throw error
  }
  // The fence was created through the name, so it is inside this process's directory
  // only while that directory still stands there; a displaced one never returns.
  if (ownerText(mutexDir).split(/\s+/)[2] !== token) return undefined
  return { token, fence }
}

/** Revalidate and break a stale main lock, fenced by the recovery mutex this process holds. */
function recoverStaleLock(
  lockDir: string,
  fence: string,
  verified: OwnerVerifications,
): boolean {
  if (!lockOwnerIsStale(lockDir, verified)) return false
  const displaced = join(fence, 'stale')
  try {
    renameSync(lockDir, displaced)
  } catch (error) {
    // The lock is gone, or the fence left with a mutex another process displaced.
    if (lostRace(error)) return false
    throw error
  }
  removeRemnant(displaced)
  return true
}

function tryAcquireBacklogLock(
  lockDir: string,
  verified: OwnerVerifications,
): string | undefined {
  const mutex = tryAcquireRecoveryMutex(lockDir, verified)
  if (mutex === undefined) return undefined
  try {
    if (existsSync(lockDir) && !recoverStaleLock(lockDir, mutex.fence, verified)) return undefined
    // A process running an older core can still race by acquiring without the mutex.
    return ownedLock(lockDir)
  } finally {
    releaseOwnedLock(`${lockDir}.recovery`, mutex.token, false)
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
    releaseOwnedLock(lockDir, lockToken, true)
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
