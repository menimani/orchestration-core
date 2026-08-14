import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, toNamespacedPath } from 'node:path'

const packageRoot = resolve(import.meta.dirname, '..')
const lockName = '.orchestration-test-suite-lock'
const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
const retryMilliseconds = 250
const unpublishedOwnerGraceMilliseconds = 30_000

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

function lockOwnerIsAlive() {
  try {
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8'))
    return Number.isSafeInteger(owner.pid) && owner.pid > 0 && processIsAlive(owner.pid)
  } catch {
    try {
      return Date.now() - statSync(lockDirectory).mtimeMs < unpublishedOwnerGraceMilliseconds
    } catch {
      return false
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
  for (;;) {
    try {
      mkdirSync(lockDirectory)
      try {
        writeFileSync(ownerFile, `${JSON.stringify({ pid: process.pid, token })}\n`)
      } catch (error) {
        removeDirectory(lockDirectory)
        throw error
      }
      return
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }

    if (!lockOwnerIsAlive()) {
      reclaimAbandonedLock()
      continue
    }
    if (!announced) {
      console.log('Another worktree is running the test suite; waiting for its repository lock.')
      announced = true
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, retryMilliseconds))
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
