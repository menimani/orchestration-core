import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ writeFileSync: vi.fn() }))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, writeFileSync: mocks.writeFileSync }
})

import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { readStatus, writeStatus } from '../src/status.ts'

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
let repoRoot = ''
let paths: OrchPaths

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-status-lock-'))
  paths = orchPaths(repoRoot)
  mocks.writeFileSync.mockReset().mockImplementation((...args: unknown[]) =>
    Reflect.apply(actualFs.writeFileSync, actualFs, args))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('status lock publication', () => {
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
