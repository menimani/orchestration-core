import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mkdirSync: vi.fn(), renameSync: vi.fn(), rmSync: vi.fn(), writeFileSync: vi.fn(),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    mkdirSync: mocks.mkdirSync,
    renameSync: mocks.renameSync,
    rmSync: mocks.rmSync,
    writeFileSync: mocks.writeFileSync,
  }
})

import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { readStatus, writeStatus } from '../src/status.ts'

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
let repoRoot = ''
let paths: OrchPaths

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-status-lock-'))
  mocks.mkdirSync.mockReset().mockImplementation((...args: unknown[]) =>
    Reflect.apply(actualFs.mkdirSync, actualFs, args))
  paths = orchPaths(repoRoot)
  mocks.renameSync.mockReset().mockImplementation((...args: unknown[]) =>
    Reflect.apply(actualFs.renameSync, actualFs, args))
  mocks.rmSync.mockReset().mockImplementation((...args: unknown[]) =>
    Reflect.apply(actualFs.rmSync, actualFs, args))
  mocks.writeFileSync.mockReset().mockImplementation((...args: unknown[]) =>
    Reflect.apply(actualFs.writeFileSync, actualFs, args))
})

afterEach(() => {
  vi.restoreAllMocks()
  actualFs.rmSync(repoRoot, { recursive: true, force: true })
})

describe('status lock publication', () => {
  it('preserves a successful write and recovers when lock release rename fails', async () => {
    const taskId = 'release-rename-failure'
    const lockDirectory = join(paths.statusDir, `.${taskId}.lock`)
    const failure = Object.assign(new Error('lock release failed'), { code: 'EPERM' })
    let releaseFailed = false
    mocks.renameSync.mockImplementation((...args: unknown[]) => {
      if (!releaseFailed && args[0] === lockDirectory) {
        releaseFailed = true
        throw failure
      }
      return Reflect.apply(actualFs.renameSync, actualFs, args)
    })

    await expect(writeStatus(paths, taskId, 'running', process.pid)).resolves.toBeUndefined()
    expect(releaseFailed).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('running')
    expect(actualFs.existsSync(lockDirectory)).toBe(true)
    expect(actualFs.readFileSync(join(lockDirectory, 'retired-owner-token'), 'utf8').trim())
      .toBe(actualFs.readFileSync(join(lockDirectory, 'owner-token'), 'utf8').trim())

    // A fresh module has none of the releasing module's process-local recovery state,
    // matching the relevant boundary between the daemon and a CLI invocation.
    vi.resetModules()
    const { writeStatus: writeStatusFromAnotherProcess } = await import('../src/status.ts')
    await expect(writeStatusFromAnotherProcess(paths, taskId, 'completed')).resolves.toBeUndefined()
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(actualFs.existsSync(lockDirectory)).toBe(false)
  })

  it('keeps the lock released when retired metadata removal fails', async () => {
    const taskId = 'partial-release-failure'
    const lockDir = join(paths.statusDir, `.${taskId}.lock`)
    const failure = Object.assign(new Error('retired lock removal failed'), { code: 'EIO' })
    mocks.rmSync.mockImplementation((...args: unknown[]) => {
      if (String(args[0]).includes('.lock.released-')) throw failure
      return Reflect.apply(actualFs.rmSync, actualFs, args)
    })

    await expect(writeStatus(paths, taskId, 'running', process.pid)).resolves.toBeUndefined()
    expect(mocks.rmSync).toHaveBeenCalledWith(
      expect.stringContaining('.lock.released-'),
      expect.objectContaining({ recursive: true }),
    )
    expect(actualFs.existsSync(lockDir)).toBe(false)

    mocks.rmSync.mockImplementation((...args: unknown[]) =>
      Reflect.apply(actualFs.rmSync, actualFs, args))
    await expect(writeStatus(paths, taskId, 'completed')).resolves.toBeUndefined()
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('removes a partially published lock and rethrows a metadata write failure', async () => {
    const taskId = 'metadata-failure'
    const lockDir = join(paths.statusDir, `.${taskId}.lock`)
    const failure = Object.assign(new Error('identity metadata unavailable'), { code: 'EIO' })
    mocks.writeFileSync.mockImplementation((...args: unknown[]) => {
      if (basename(String(args[0])) === 'start-identity') throw failure
      return Reflect.apply(actualFs.writeFileSync, actualFs, args)
    })

    await expect(writeStatus(paths, taskId, 'completed')).rejects.toBe(failure)
    expect(actualFs.existsSync(lockDir)).toBe(false)

    mocks.writeFileSync.mockImplementation((...args: unknown[]) =>
      Reflect.apply(actualFs.writeFileSync, actualFs, args))
    await expect(writeStatus(paths, taskId, 'completed')).resolves.toBeUndefined()
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('waits for a lock name that Windows still reports as pending deletion', async () => {
    const taskId = 'pending-deletion'
    const lockDir = join(paths.statusDir, `.${taskId}.lock`)
    let pendingDeletionReports = 0
    mocks.mkdirSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === lockDir && pendingDeletionReports < 2) {
        pendingDeletionReports += 1
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      }
      return Reflect.apply(actualFs.mkdirSync, actualFs, args)
    })

    await expect(writeStatus(paths, taskId, 'completed')).resolves.toBeUndefined()
    expect(pendingDeletionReports).toBe(2)
    expect(mocks.mkdirSync.mock.calls.filter(([path]) => path === lockDir)).toHaveLength(3)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(actualFs.existsSync(lockDir)).toBe(false)
  })

  it('names EPERM when the wait times out on a lock name that never clears', async () => {
    const taskId = 'persistent-eperm'
    const lockDir = join(paths.statusDir, `.${taskId}.lock`)
    mocks.mkdirSync.mockImplementation((...args: unknown[]) => {
      if (args[0] === lockDir) {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
      }
      return Reflect.apply(actualFs.mkdirSync, actualFs, args)
    })
    const now = Date.now()
    let elapsed = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now + elapsed++ * 1_000)

    await expect(writeStatus(paths, taskId, 'completed')).rejects.toThrow(
      new Error(`Timed out waiting for the status lock: ${taskId} (last error: EPERM)`),
    )
    expect(readStatus(paths, taskId)).toBeUndefined()
    expect(actualFs.existsSync(lockDir)).toBe(false)
  })

  it('keeps the plain timeout message when a live owner holds the lock throughout', async () => {
    const taskId = 'held-lock'
    const lockDir = join(paths.statusDir, `.${taskId}.lock`)
    actualFs.mkdirSync(lockDir, { recursive: true })
    actualFs.writeFileSync(join(lockDir, 'pid'), `${process.pid}\n`)
    const now = Date.now()
    let elapsed = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now + elapsed++ * 1_000)

    await expect(writeStatus(paths, taskId, 'completed')).rejects.toThrow(
      new Error(`Timed out waiting for the status lock: ${taskId}`),
    )
    expect(readStatus(paths, taskId)).toBeUndefined()
    expect(actualFs.readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(`${process.pid}\n`)
  })

  it('does not treat a file at the lock path as lock contention', async () => {
    const taskId = 'invalid-lock-file'
    const lockFile = join(paths.statusDir, `.${taskId}.lock`)
    actualFs.writeFileSync(lockFile, 'not a directory\n')

    await expect(writeStatus(paths, taskId, 'completed')).rejects.toMatchObject({
      code: 'EEXIST',
    })
    expect(actualFs.readFileSync(lockFile, 'utf8')).toBe('not a directory\n')
  })
})
