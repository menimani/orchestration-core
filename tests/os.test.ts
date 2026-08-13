import { describe, expect, it, vi } from 'vitest'
import { createOperatingSystem as createPosixOperatingSystem } from '../src/adapters/os-posix.ts'
import { createOperatingSystem as createWindowsOperatingSystem } from '../src/adapters/os-windows.ts'

describe('operating-system adapters', () => {
  it('exposes behavior without a platform field', () => {
    expect(createWindowsOperatingSystem()).not.toHaveProperty('platform')
    expect(createPosixOperatingSystem()).not.toHaveProperty('platform')
  })

  it('retries an ordinary Windows directory with its extended-length path', () => {
    const remove = vi.fn()
      .mockImplementationOnce(() => { throw new Error('Filename too long') })
    const os = createWindowsOperatingSystem({
      spawn: () => {}, listProcesses: () => [], probeProcess: () => {}, remove,
      now: Date.now, sleep: () => {},
    })

    os.removeDirectory('C:\\deep\\directory')

    expect(remove).toHaveBeenNthCalledWith(
      1, 'C:\\deep\\directory', { recursive: true, force: true },
    )
    expect(remove).toHaveBeenNthCalledWith(
      2, '\\\\?\\C:\\deep\\directory', { recursive: true, force: true },
    )
  })

  it('uses case-insensitive worktree comparison keys on Windows', () => {
    const os = createWindowsOperatingSystem()

    expect(os.worktreePathFor('C:\\Repo\\Task').comparisonKey)
      .toBe(os.worktreePathFor('c:\\repo\\task').comparisonKey)
  })

  it('removes a POSIX directory directly', () => {
    const remove = vi.fn()
    const os = createPosixOperatingSystem({
      signalProcessGroup: () => {}, probeProcess: () => {}, remove,
      now: Date.now, sleep: () => {}, groupHasRunningMember: () => undefined,
    })

    os.removeDirectory('/tmp/worktree')

    expect(remove).toHaveBeenCalledWith('/tmp/worktree', { recursive: true, force: true })
  })
})
