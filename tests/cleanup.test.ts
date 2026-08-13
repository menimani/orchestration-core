import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OperatingSystem } from '../src/adapters/os.ts'
import {
  createOperatingSystem as createPosixOperatingSystem,
  type PosixOperatingSystemRuntime,
} from '../src/adapters/os-posix.ts'
import {
  createOperatingSystem as createWindowsOperatingSystem,
  type WindowsOperatingSystemRuntime,
} from '../src/adapters/os-windows.ts'
import { cleanupTask, type CleanupRuntime } from '../src/cleanup.ts'
import { finalMessageFile, orchPaths, statusFile, worktreeDir, type OrchPaths } from '../src/paths.ts'
import { recordTaskProcess } from '../src/processRegistry.ts'

let repoRoot: string
let paths: OrchPaths
let taskId: string
let worktree: string

function seedTask(pid: number | null): void {
  worktree = worktreeDir(paths, taskId)
  mkdirSync(worktree, { recursive: true })
  mkdirSync(join(paths.queueDir, 'scanned'), { recursive: true })
  writeFileSync(statusFile(paths, taskId), JSON.stringify({ task_id: taskId, pid }))
  // A task's process lives in the registry, not in the record.
  if (pid !== null) recordTaskProcess(paths, taskId, pid)
  writeFileSync(finalMessageFile(paths, taskId), 'TASK_COMPLETE\n')
  writeFileSync(join(paths.queueDir, 'scanned', taskId), '')
  writeFileSync(join(paths.queueDir, 'scanned', `${taskId}.failed`), '')
}

// The Windows implementation prefixes the extended-length marker, which is meaningless
// to a POSIX filesystem. Strip it before a fixture touches real files.
function plainPath(path: string): string {
  if (!path.startsWith('\\\\?\\')) return path
  const withoutMarker = path.slice(4)
  // The marker comes with Windows separators; a POSIX host needs its own back.
  return process.platform === 'win32' ? withoutMarker : withoutMarker.replaceAll('\\', '/')
}

function makeRuntime(overrides: Partial<CleanupRuntime> = {}): CleanupRuntime {
  let worktreeRegistered = true
  let branchPresent = true
  let runtime: CleanupRuntime
  runtime = {
    execFile: (_command, args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        rmSync(worktree, { recursive: true, force: true })
        worktreeRegistered = false
      }
      if (args[0] === 'worktree' && args[1] === 'prune' && !existsSync(worktree)) {
        worktreeRegistered = false
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return worktreeRegistered ? `worktree ${worktree}\0HEAD abc123\0\0` : ''
      }
      if (args[0] === 'branch' && args[1] === '-D') branchPresent = false
      if (args[0] === 'for-each-ref') {
        return branchPresent ? `refs/heads/task/${taskId}\n` : ''
      }
      return ''
    },
    exists: (path) => existsSync(plainPath(path)),
    os: undefined as unknown as OperatingSystem,
    remove: (path, options) => { rmSync(plainPath(path), options) },
    ...overrides,
  }
  runtime.os = overrides.os ?? windowsOperatingSystem({
    remove: (path, options) => runtime.remove(path, options),
  })
  return runtime
}

function windowsOperatingSystem(
  overrides: Partial<WindowsOperatingSystemRuntime> = {},
): OperatingSystem {
  return createWindowsOperatingSystem({
    spawn: () => {},
    listProcesses: () => [{ pid: 12345, parentPid: 0 }],
    probeProcess: () => { throw gone() },
    remove: () => {},
    now: Date.now,
    sleep: () => {},
    ...overrides,
  })
}

function posixOperatingSystem(
  overrides: Partial<PosixOperatingSystemRuntime> = {},
): OperatingSystem {
  return createPosixOperatingSystem({
    signalProcessGroup: () => {},
    probeProcess: () => { throw gone() },
    remove: () => {},
    now: Date.now,
    sleep: () => {},
    groupHasRunningMember: () => undefined,
    ...overrides,
  })
}

function gone(): NodeJS.ErrnoException {
  const error = new Error('process is gone') as NodeJS.ErrnoException
  error.code = 'ESRCH'
  return error
}

function expectTaskStateToExist(): void {
  expect(existsSync(statusFile(paths, taskId))).toBe(true)
  expect(existsSync(finalMessageFile(paths, taskId))).toBe(true)
  expect(existsSync(join(paths.queueDir, 'scanned', taskId))).toBe(true)
  expect(existsSync(join(paths.queueDir, 'scanned', `${taskId}.failed`))).toBe(true)
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-cleanup-'))
  paths = orchPaths(repoRoot)
  taskId = '20260808_150907_119_auto-cleanup'
  worktree = worktreeDir(paths, taskId)
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('cleanupTask', () => {
  it('retains task state when taskkill does not stop the process', () => {
    seedTask(12345)
    let now = 0
    const spawn = vi.fn()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const runtime = makeRuntime({ os: windowsOperatingSystem({
      spawn,
      probeProcess: () => {},
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
    }) })

    expect(() => cleanupTask(paths, taskId, runtime))
      .toThrow('Could not stop process 12345; task state was retained.')

    expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', '12345', '/T', '/F'])
    expectTaskStateToExist()
    expect(existsSync(worktree)).toBe(true)
    expect(log).not.toHaveBeenCalledWith(`Cleaned up ${taskId}.`)
  })

  it('signals and verifies the detached process group on POSIX', () => {
    seedTask(12345)
    let groupAlive = true
    const signalProcessGroup = vi.fn((target: number, signal?: NodeJS.Signals | number) => {
      expect(target).toBe(12345)
      if (signal !== 0) groupAlive = false
      if (!groupAlive && signal === 0) throw gone()
    })
    const runtime = makeRuntime({ os: posixOperatingSystem({ signalProcessGroup }) })

    cleanupTask(paths, taskId, runtime)

    expect(signalProcessGroup).toHaveBeenCalledWith(12345)
    expect(signalProcessGroup).toHaveBeenCalledWith(12345, 0)
    expect(existsSync(statusFile(paths, taskId))).toBe(false)
  })

  it('retains task state while POSIX process-group descendants remain alive', () => {
    seedTask(12345)
    let now = 0
    const signalProcessGroup = vi.fn((target: number) => {
      expect(target).toBe(12345)
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const runtime = makeRuntime({ os: posixOperatingSystem({
      signalProcessGroup,
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
    }) })

    expect(() => cleanupTask(paths, taskId, runtime))
      .toThrow('Could not stop process 12345; task state was retained.')

    expect(signalProcessGroup).toHaveBeenCalledWith(12345)
    expectTaskStateToExist()
    expect(existsSync(worktree)).toBe(true)
    expect(log).not.toHaveBeenCalledWith(`Cleaned up ${taskId}.`)
  })

  it('retains task state when the worktree remains after both removal attempts', () => {
    seedTask(null)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const runtime = makeRuntime({
      execFile: () => { throw new Error('git failed') },
      remove: () => { throw new Error('directory is locked') },
    })

    expect(() => cleanupTask(paths, taskId, runtime))
      .toThrow(`Could not remove worktree ${worktree}; task state was retained.`)

    expectTaskStateToExist()
    expect(existsSync(worktree)).toBe(true)
    expect(log).not.toHaveBeenCalledWith(`Cleaned up ${taskId}.`)
  })

  it('uses the Windows long-path fallback when git cannot remove the worktree', () => {
    seedTask(null)
    const runtime = makeRuntime()
    const execFile = runtime.execFile
    runtime.execFile = vi.fn((command, args, options) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('Filename too long')
      }
      return execFile(command, args, options)
    })
    runtime.remove = vi.fn((path, options) => {
      if (path.startsWith('\\\\?\\')) {
        rmSync(worktree, { recursive: true, force: true })
        return
      }
      rmSync(path, options)
    })

    cleanupTask(paths, taskId, runtime)

    expect(runtime.remove).toHaveBeenCalledWith(
      `\\\\?\\${worktree.replaceAll('/', '\\')}`,
      { recursive: true, force: true, maxRetries: 3 },
    )
    expect(runtime.execFile).toHaveBeenCalledWith(
      'git', ['worktree', 'prune'], expect.anything(),
    )
    expect(existsSync(worktree)).toBe(false)
    expect(existsSync(statusFile(paths, taskId))).toBe(false)
  })

  it('retains task state when direct removal leaves the worktree registered', () => {
    seedTask(null)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const execFile = vi.fn((_command: string, args: readonly string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('git failed')
      if (args[0] === 'worktree' && args[1] === 'list') {
        return `worktree ${worktree}\0HEAD abc123\0branch refs/heads/task/${taskId}\0\0`
      }
      return ''
    })
    const runtime = makeRuntime({ execFile })

    expect(() => cleanupTask(paths, taskId, runtime))
      .toThrow(`Worktree ${worktree} is still registered; task state was retained.`)

    expect(execFile).toHaveBeenCalledWith('git', ['worktree', 'prune', '--expire', 'now'], expect.anything())
    expectTaskStateToExist()
    expect(existsSync(worktree)).toBe(false)
    expect(log).not.toHaveBeenCalledWith(`Cleaned up ${taskId}.`)
  })

  it('retains task state when the branch remains after deletion fails', () => {
    seedTask(null)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const execFile = vi.fn((_command: string, args: readonly string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('git failed')
      if (args[0] === 'branch') throw new Error('branch is locked')
      if (args[0] === 'for-each-ref') return `refs/heads/task/${taskId}\n`
      return ''
    })
    const runtime = makeRuntime({ execFile })

    expect(() => cleanupTask(paths, taskId, runtime))
      .toThrow(`Could not remove branch task/${taskId}; task state was retained.`)

    expect(execFile).toHaveBeenCalledWith('git', ['worktree', 'prune', '--expire', 'now'], expect.anything())
    expectTaskStateToExist()
    expect(existsSync(worktree)).toBe(false)
    expect(log).not.toHaveBeenCalledWith(`Cleaned up ${taskId}.`)
  })

  it('clears task state only after process, worktree and branch removal are verified', () => {
    seedTask(12345)
    let processAlive = true
    const runtime = makeRuntime({ os: windowsOperatingSystem({
      spawn: () => { processAlive = false },
      probeProcess: () => {
        if (processAlive) return
        throw gone()
      },
    }) })
    const execFile = vi.spyOn(runtime, 'execFile')

    cleanupTask(paths, taskId, runtime)

    expect(existsSync(worktree)).toBe(false)
    expect(existsSync(statusFile(paths, taskId))).toBe(false)
    expect(existsSync(finalMessageFile(paths, taskId))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'scanned', taskId))).toBe(false)
    expect(existsSync(join(paths.queueDir, 'scanned', `${taskId}.failed`))).toBe(false)
    expect(execFile).toHaveBeenCalledWith('git', ['worktree', 'list', '--porcelain', '-z'], expect.anything())
    expect(execFile).toHaveBeenCalledWith('git', ['for-each-ref', '--format=%(refname)', 'refs/heads'], expect.anything())
  })
})
