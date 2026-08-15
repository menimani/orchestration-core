import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, toNamespacedPath } from 'node:path'
import { performance } from 'node:perf_hooks'

const packageRoot = resolve(import.meta.dirname, '..')
const lockName = '.orchestration-test-suite-lock'
const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
const retryMilliseconds = 250
const unpublishedOwnerGraceMilliseconds = 30_000
const maximumWaitMilliseconds = 10 * 60_000

function commonGitDirectory() {
  try {
    return execFileSync(
      'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
  } catch {
    // Exported source archives have no Git metadata and cannot share a worktree lock.
    return packageRoot
  }
}

const lockDirectory = join(commonGitDirectory(), lockName)
const ownerFile = join(lockDirectory, 'owner.json')

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // A permission failure does not prove that the process stopped.
    return error?.code !== 'ESRCH'
  }
}

function processIdentity(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const closingParenthesis = stat.lastIndexOf(')')
      const fields = stat.slice(closingParenthesis + 2).split(' ')
      if (closingParenthesis < 0 || fields[19] === undefined) return null
      return `linux:${fields[19]}`
    }
    if (process.platform === 'win32') {
      const command = [
        '& { param([int]$TargetPid)',
        '(Get-Process -Id $TargetPid -ErrorAction Stop).StartTime.ToUniversalTime().Ticks',
        '}',
      ].join(' ')
      const started = execFileSync(
        'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command, String(pid)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      return started === '' ? null : `windows:${started}`
    }
    const started = execFileSync(
      'ps', ['-p', String(pid), '-o', 'lstart='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return started === '' ? null : `${process.platform}:${started}`
  } catch {
    return null
  }
}

function readLockOwner() {
  try {
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8'))
    if (
      !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.token !== 'string' || owner.token === ''
    ) return { alive: false, diagnostic: 'invalid owner record' }
    if (owner.processIdentity === undefined) {
      return {
        alive: processIsAlive(owner.pid),
        diagnostic: `legacy owner PID ${owner.pid}`,
      }
    }
    if (
      typeof owner.processIdentity !== 'string' || owner.processIdentity === ''
      || typeof owner.acquiredAt !== 'string' || Number.isNaN(Date.parse(owner.acquiredAt))
      || typeof owner.cwd !== 'string' || owner.cwd === ''
    ) return { alive: false, diagnostic: 'invalid owner record' }
    const alive = processIsAlive(owner.pid)
    const currentIdentity = alive ? processIdentity(owner.pid) : null
    return {
      alive: alive && (currentIdentity === null || currentIdentity === owner.processIdentity),
      diagnostic: `PID ${owner.pid}, acquired ${owner.acquiredAt}, cwd ${owner.cwd}${
        alive && currentIdentity === null ? ', identity unavailable' : ''}`,
    }
  } catch {
    try {
      return {
        alive: Date.now() - statSync(lockDirectory).mtimeMs < unpublishedOwnerGraceMilliseconds,
        diagnostic: 'owner record not yet available',
      }
    } catch {
      return { alive: false, diagnostic: 'owner record unavailable' }
    }
  }
}

function removeDirectory(directory) {
  try {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  } catch (error) {
    if (process.platform !== 'win32') throw error
    rmSync(toNamespacedPath(directory), { recursive: true, force: true, maxRetries: 3 })
  }
}

function reclaimAbandonedLock() {
  const abandoned = `${lockDirectory}.abandoned-${token}`
  try {
    renameSync(lockDirectory, abandoned)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EPERM') return
    throw error
  }
  removeDirectory(abandoned)
}

async function acquireLock() {
  let announced = false
  const waitStartedAt = performance.now()
  const configuredMaximumWait = Number(process.env.ORCHESTRATION_TEST_LOCK_TIMEOUT_MS)
  const waitLimit = Number.isSafeInteger(configuredMaximumWait) && configuredMaximumWait > 0
    ? Math.min(configuredMaximumWait, maximumWaitMilliseconds)
    : maximumWaitMilliseconds
  for (;;) {
    try {
      mkdirSync(lockDirectory)
      try {
        const identity = processIdentity(process.pid)
        if (identity === null) throw new Error('Unable to determine the test lock process identity.')
        writeFileSync(ownerFile, `${JSON.stringify({
          pid: process.pid,
          token,
          processIdentity: identity,
          acquiredAt: new Date().toISOString(),
          cwd: packageRoot,
        })}\n`)
      } catch (error) {
        removeDirectory(lockDirectory)
        throw error
      }
      return
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }

    const owner = readLockOwner()
    if (!owner.alive) {
      reclaimAbandonedLock()
    } else if (!announced) {
      console.log(`Another worktree is running the test suite; waiting for its repository lock (${owner.diagnostic}).`)
      announced = true
    }
    const remainingWait = waitLimit - (performance.now() - waitStartedAt)
    if (remainingWait <= 0) {
      throw new Error(`Timed out after ${waitLimit}ms waiting for the repository test lock. Lock owner: ${owner.diagnostic}.`)
    }
    await new Promise((resolveWait) => setTimeout(
      resolveWait, Math.min(retryMilliseconds, remainingWait),
    ))
  }
}

function releaseLock() {
  try {
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8'))
    if (owner.token !== token) return
  } catch {
    return
  }

  const released = `${lockDirectory}.released-${token}`
  try {
    renameSync(lockDirectory, released)
  } catch {
    return
  }
  removeDirectory(released)
}

function vitestEntryPoint() {
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
}

await acquireLock()
let child
const forwardSignal = (signal) => child?.kill(signal)
process.once('SIGINT', forwardSignal)
process.once('SIGTERM', forwardSignal)
try {
  // The package script deliberately supplies no Vitest flags. npm appends gate flags to
  // this argument list once, so the merge gate remains `npm test -- ...` compatible.
  child = spawn(process.execPath, [vitestEntryPoint(), 'run', ...process.argv.slice(2)], {
    cwd: packageRoot,
    stdio: 'inherit',
    windowsHide: true,
  })
  const status = await new Promise((resolveStatus, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveStatus({ code, signal }))
  })
  if (status.signal !== null) {
    console.error(`Vitest stopped on signal ${status.signal}.`)
    process.exitCode = 1
  } else {
    process.exitCode = status.code ?? 1
  }
} finally {
  process.removeListener('SIGINT', forwardSignal)
  process.removeListener('SIGTERM', forwardSignal)
  releaseLock()
}
