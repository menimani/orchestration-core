import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const LOCK_RETRY_MS = 10
const OWNER_GRACE_MS = 30_000
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
  const ownerFile = join(lockDir, 'owner')
  if (!existsSync(ownerFile)) return false
  const [pidRaw, createdRaw] = readFileSync(ownerFile, 'utf8').trim().split(/\s+/)
  if (pidRaw === undefined || !/^\d+$/.test(pidRaw)) return false
  if (processIsAlive(Number(pidRaw))) return false
  const created = Number(createdRaw)
  return !Number.isFinite(created) || Date.now() - created >= OWNER_GRACE_MS
}

/** Serialize backlog read-modify-write operations across loop and CLI processes. */
export function withBacklogLock<T>(backlog: string, mutation: () => T): T {
  const lockDir = `${backlog}.lock`
  while (true) {
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
      if (lockOwnerIsStale(lockDir)) {
        try {
          rmSync(lockDir, { recursive: true })
        } catch {
          // Another waiter may have recovered it first.
        }
        continue
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

export function dequeueBacklog(backlog: string): string | undefined {
  return withBacklogLock(backlog, () => {
    const lines = readFileSync(backlog, 'utf8').split(/\r?\n/).filter((line) => line !== '')
    const first = lines.shift()
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
