import type { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createOperatingSystem as createPosixOperatingSystem } from '../src/adapters/os-posix.ts'
import {
  createOperatingSystem as createWindowsOperatingSystem, worktreeProcessPids,
} from '../src/adapters/os-windows.ts'
import { WINDOWS_PROCESS_ROOT_PID_ENV } from '../src/internalEnvironment.ts'
import { operatingSystem } from '../src/adapters/os.ts'

describe('operating-system adapters', () => {
  it('returns a stable start identity for the current process', () => {
    const identity = operatingSystem.processStartIdentity(process.pid)

    expect(identity).toBeTruthy()
    expect(operatingSystem.processStartIdentity(process.pid)).toBe(identity)
  })

  it('exposes behavior without a platform field', () => {
    expect(createWindowsOperatingSystem()).not.toHaveProperty('platform')
    expect(createPosixOperatingSystem()).not.toHaveProperty('platform')
  })

  it('labels the local verification environment without exposing the platform selector', () => {
    expect(createWindowsOperatingSystem().verificationEnvironmentLabel()).toBe('Windows')
    expect(createPosixOperatingSystem().verificationEnvironmentLabel()).toBe(
      process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'Linux' : process.platform,
    )
  })

  it('launches a POSIX daemon without exposing the platform choice to callers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-os-'))
    const child = Object.assign(new EventEmitter(), {
      pid: 43210,
      exitCode: null,
      kill: vi.fn(() => true),
      unref: vi.fn(),
    }) as unknown as ChildProcess
    const spawnDaemon = vi.fn(() => child) as unknown as typeof spawn
    const os = createPosixOperatingSystem({
      signalProcessGroup: () => {}, probeProcess: () => {}, remove: () => {},
      now: Date.now, sleep: () => {}, groupHasRunningMember: () => undefined,
      spawnDaemon,
    })

    try {
      const daemon = await os.launchDaemon({
        args: ['src/cli.ts', 'loop'],
        command: process.execPath,
        cwd: root,
        outputFile: join(root, 'loop.log'),
      })
      daemon.release()

      expect(daemon.pid).toBe(43210)
      expect(spawnDaemon).toHaveBeenCalledWith(
        process.execPath,
        ['src/cli.ts', 'loop'],
        expect.objectContaining({ cwd: root, detached: true, windowsHide: true }),
      )
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('terminates and verifies the entire POSIX daemon process group', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-os-'))
    const child = Object.assign(new EventEmitter(), {
      pid: 43210,
      exitCode: null,
      kill: vi.fn(() => true),
      unref: vi.fn(),
    }) as unknown as ChildProcess
    const spawnDaemon = vi.fn(() => child) as unknown as typeof spawn
    let now = 0
    let probesAfterSignal = 0
    let signalled = false
    const signalProcessGroup = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === undefined) signalled = true
    })
    const os = createPosixOperatingSystem({
      signalProcessGroup,
      probeProcess: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
      remove: () => {},
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
      // The first probe after SIGTERM represents a surviving descendant. The second
      // proves that the full group has stopped, independently of the detached leader.
      groupHasRunningMember: () => !signalled || probesAfterSignal++ === 0,
      spawnDaemon,
    })

    try {
      const daemon = await os.launchDaemon({
        args: ['src/cli.ts', 'loop'],
        command: process.execPath,
        cwd: root,
        outputFile: join(root, 'loop.log'),
      })

      daemon.terminate()

      expect(signalProcessGroup).toHaveBeenCalledWith(43210)
      expect(signalProcessGroup).toHaveBeenCalledWith(43210, 0)
      expect(child.kill).not.toHaveBeenCalled()
      expect(now).toBe(50)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the hidden process launcher for a Windows daemon', async () => {
    const startDaemon = vi.fn(async () => 43211)
    const os = createWindowsOperatingSystem({
      spawn: () => {}, listProcesses: () => [], probeProcess: () => {}, remove: () => {},
      now: Date.now, sleep: () => {}, startDaemon,
    })
    const options = {
      args: ['src/cli.ts', 'loop'], command: process.execPath, cwd: 'C:\\repo',
      outputFile: 'C:\\repo\\loop.log',
    }

    await expect(os.launchDaemon(options)).resolves.toMatchObject({ pid: 43211 })
    expect(startDaemon).toHaveBeenCalledWith(options)
  })

  it('owns process-tree root selection inside each adapter', () => {
    const env = { [WINDOWS_PROCESS_ROOT_PID_ENV]: '43212' }

    expect(createWindowsOperatingSystem().processTreeRootPid(env)).toBe(43212)
    expect(createPosixOperatingSystem().processTreeRootPid(env)).toBe(process.pid)
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

  it('selects Windows processes that name the worktree in either case or slash direction', () => {
    const worktree = 'C:\\Fleet\\worktrees\\task-1'
    const processes = [
      { pid: 101, commandLine: 'bash.exe -c "cd c:/fleet/WORKTREES/task-1 && npm test"', executablePath: 'C:\\Git\\bin\\bash.exe' },
      { pid: 102, commandLine: null, executablePath: 'c:\\FLEET\\worktrees\\task-1\\node_modules\\.bin\\vitest.exe' },
      { pid: 103, commandLine: '"C:\\Program Files\\nodejs\\node.exe" C:/Fleet/worktrees/Task-1/scripts/run-tests.mjs', executablePath: null },
      { pid: 104, commandLine: 'node C:\\Fleet\\worktrees\\task-10\\scripts\\run-tests.mjs', executablePath: null },
      { pid: 105, commandLine: 'mvn test', executablePath: 'C:\\maven\\bin\\mvn.cmd' },
      { pid: 106, commandLine: null, executablePath: null },
      { pid: process.pid, commandLine: `node ${worktree}\\src\\cli.ts cleanup`, executablePath: null },
    ]

    expect(worktreeProcessPids(processes, worktree)).toEqual([101, 102, 103])
    expect(worktreeProcessPids(processes, `\\\\?\\${worktree}\\`)).toEqual([101, 102, 103])
  })

  it('terminates each Windows process tree holding a worktree and tolerates a survivor', () => {
    let now = 0
    const alive = new Set([201, 202])
    const spawn = vi.fn((_command: string, args: readonly string[]) => {
      // 202 ignores taskkill, as a process the account cannot stop would.
      if (args[1] === '201') alive.delete(201)
    })
    const os = createWindowsOperatingSystem({
      spawn,
      listProcesses: () => [{ pid: 201, parentPid: 1 }, { pid: 202, parentPid: 1 }],
      listProcessCommands: () => [
        { pid: 201, commandLine: 'bash.exe -c "cd C:/Fleet/worktrees/task-2"', executablePath: null },
        { pid: 202, commandLine: 'cmd.exe /c mvn test -f C:\\Fleet\\worktrees\\task-2\\pom.xml', executablePath: null },
        { pid: 203, commandLine: 'node C:\\Fleet\\worktrees\\task-2\\run.mjs', executablePath: null },
      ],
      probeProcess: (pid) => {
        if (alive.has(pid)) return
        const error = new Error('gone') as NodeJS.ErrnoException
        error.code = 'ESRCH'
        throw error
      },
      remove: () => {},
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
    })

    expect(() => os.terminateWorktreeProcesses('C:\\Fleet\\worktrees\\task-2')).not.toThrow()

    expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', '201', '/T', '/F'])
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', '202', '/T', '/F'])
    // 203 had already exited, so there was nothing to terminate.
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('leaves worktree processes alone on POSIX', () => {
    const signalProcessGroup = vi.fn()
    const os = createPosixOperatingSystem({
      signalProcessGroup, probeProcess: () => {}, remove: () => {},
      now: Date.now, sleep: () => {}, groupHasRunningMember: () => true,
    })

    os.terminateWorktreeProcesses('/fleet/worktrees/task-3')

    expect(signalProcessGroup).not.toHaveBeenCalled()
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
