import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rmSync: vi.fn(), writeFileSync: vi.fn() }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, rmSync: mocks.rmSync, writeFileSync: mocks.writeFileSync }
})

import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { readStatus, writeStatus } from '../src/status.ts'

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
let repoRoot = ''
let paths: OrchPaths

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-status-lock-'))
  paths = orchPaths(repoRoot)
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
