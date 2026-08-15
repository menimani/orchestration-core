import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { orchPaths, statusFile, type OrchPaths } from '../src/paths.ts'
import { recordTaskProcess, taskProcessPid } from '../src/processRegistry.ts'
import {
  orphanedWorktreeDirectories, terminateLiveTaskProcesses, worktreeHolderHint,
} from '../src/taskProcesses.ts'

let repoRoot: string
let paths: OrchPaths

function writeRunningTask(taskId: string, pid: number): void {
  writeFileSync(statusFile(paths, taskId), JSON.stringify({ task_id: taskId, status: 'running', pid }))
  recordTaskProcess(paths, taskId, pid, () => `started:${pid}`)
}

function gone(): NodeJS.ErrnoException {
  const error = new Error('process is gone') as NodeJS.ErrnoException
  error.code = 'ESRCH'
  return error
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-task-processes-'))
  paths = orchPaths(repoRoot)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('terminateLiveTaskProcesses', () => {
  it('attempts every live task tree even when one cannot be terminated', () => {
    writeRunningTask('first-task', 101)
    writeRunningTask('second-task', 102)
    const alive = new Set([101, 102])
    let now = 0
    const spawn = vi.fn((_command: string, args: readonly string[]) => {
      const pid = Number(args[1])
      if (pid === 102) alive.delete(pid)
    })
    const os = createWindowsOperatingSystem({
      spawn,
      listProcesses: () => [...alive].map((pid) => ({ pid, parentPid: 0 })),
      probeProcess: (pid) => {
        if (!alive.has(pid)) throw gone()
      },
      remove: () => {},
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
      processStartIdentity: (pid) => alive.has(pid) ? `started:${pid}` : undefined,
    })

    const result = terminateLiveTaskProcesses(paths, os)

    expect(spawn).toHaveBeenNthCalledWith(1, 'taskkill', ['/PID', '101', '/T', '/F'])
    expect(spawn).toHaveBeenNthCalledWith(2, 'taskkill', ['/PID', '102', '/T', '/F'])
    expect(result.terminated).toEqual([{ taskId: 'second-task', pid: 102 }])
    expect(result.failures).toEqual([{
      taskId: 'first-task', pid: 101, error: 'Could not stop process tree 101.',
    }])
    // Stopping is what makes a recorded identifier false, so a stopped task releases it
    // and one that resisted keeps it: something is still running under that number.
    expect(taskProcessPid(paths, 'second-task')).toBeUndefined()
    expect(taskProcessPid(paths, 'first-task', undefined, () => 'started:101')).toBe(101)
  })

  it('keeps an initially unverified PID as a non-terminable blocker', () => {
    writeFileSync(
      statusFile(paths, 'blocked-task'),
      JSON.stringify({ task_id: 'blocked-task', status: 'running', pid: 101 }),
    )
    recordTaskProcess(paths, 'blocked-task', 101, () => undefined, () => true)
    const terminateProcessTree = vi.fn(() => true)
    const os = {
      processStartIdentity: () => 'started:possibly-reused',
      processIsAlive: () => true,
      terminateProcessTree,
    } as unknown as OperatingSystem

    const result = terminateLiveTaskProcesses(paths, os)

    expect(terminateProcessTree).not.toHaveBeenCalled()
    expect(result.terminated).toEqual([])
    expect(result.failures).toEqual([{
      taskId: 'blocked-task',
      pid: 101,
      error: 'process identity was not captured at launch or is currently unavailable',
    }])
    expect(taskProcessPid(paths, 'blocked-task', undefined, () => 'started:possibly-reused'))
      .toBe(101)
  })
})

describe('orphanedWorktreeDirectories', () => {
  it('reports only directories that have no corresponding status file', () => {
    const owned = join(paths.worktreesDir, 'owned-task')
    const orphan = join(paths.worktreesDir, 'orphan-task')
    const integration = join(paths.worktreesDir, '.integration')
    mkdirSync(owned)
    mkdirSync(orphan)
    mkdirSync(integration)
    writeRunningTask('owned-task', 123)

    expect(orphanedWorktreeDirectories(paths)).toEqual([orphan])
    expect(worktreeHolderHint(orphan, createWindowsOperatingSystem())).toContain('handle.exe')
    expect(worktreeHolderHint("/tmp/orphan's worktree", createPosixOperatingSystem()))
      .toBe("Find holder: lsof +D -- '/tmp/orphan'\\''s worktree'")
  })
})

describe('process-group liveness', () => {
  // A signal-0 probe cannot tell a running process from one that has exited and is
  // waiting to be reaped. Believing the probe made a successful termination look like a
  // failure: the exit wait ran to its five-second timeout and the stop reported an
  // error, on Linux only, where the leader stayed a zombie until its parent collected it.
  function os(overrides: Partial<PosixOperatingSystemRuntime> = {}): OperatingSystem {
    return createPosixOperatingSystem({
      signalProcessGroup: () => {},
      probeProcess: () => {},
      remove: () => {},
      now: Date.now,
      sleep: () => {},
      groupHasRunningMember: () => undefined,
      ...overrides,
    })
  }

  it('treats a group whose only member is a zombie as stopped', () => {
    expect(os({
      groupHasRunningMember: () => false,
    }).processTreeIsAlive(4321)).toBe(false)
  })

  it('treats a group with a running member as alive', () => {
    expect(os({
      groupHasRunningMember: () => true,
    }).processTreeIsAlive(4321)).toBe(true)
  })

  it('keeps the probe answer where the platform cannot tell', () => {
    expect(os({
      groupHasRunningMember: () => undefined,
    }).processTreeIsAlive(4321)).toBe(true)
    expect(os().processTreeIsAlive(4321)).toBe(true)
  })

  it('still reports a stopped process group as stopped', () => {
    expect(os({
      signalProcessGroup: () => { throw gone() },
      groupHasRunningMember: () => true,
    }).processTreeIsAlive(4321)).toBe(false)
  })

  it('selects the Windows implementation when group state must not be consulted', () => {
    const runtime: WindowsOperatingSystemRuntime = {
      spawn: () => {},
      listProcesses: () => [{ pid: 4321, parentPid: 0 }],
      probeProcess: () => {},
      remove: () => {},
      now: Date.now,
      sleep: () => {},
    }

    expect(createWindowsOperatingSystem(runtime).processTreeIsAlive(4321)).toBe(true)
  })

  it('reports a Windows tree as alive while an orphaned descendant remains', () => {
    const runtime: WindowsOperatingSystemRuntime = {
      spawn: () => {},
      listProcesses: () => [
        { pid: 4322, parentPid: 4321 },
        { pid: 4323, parentPid: 4322 },
      ],
      probeProcess: (pid) => {
        if (pid !== 4323) throw gone()
      },
      remove: () => {},
      now: Date.now,
      sleep: () => {},
    }

    expect(createWindowsOperatingSystem(runtime).processTreeIsAlive(4321)).toBe(true)
  })

  it('verifies captured Windows descendants after taskkill stops the parent', () => {
    const alive = new Set([4321, 4322])
    let now = 0
    const listProcesses = vi.fn(() => [
      { pid: 4321, parentPid: 1 },
      { pid: 4322, parentPid: 4321 },
    ])
    const runtime: WindowsOperatingSystemRuntime = {
      spawn: () => { alive.delete(4321) },
      listProcesses,
      probeProcess: (pid) => {
        if (!alive.has(pid)) throw gone()
      },
      remove: () => {},
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
    }

    expect(() => createWindowsOperatingSystem(runtime).terminateProcessTree(4321))
      .toThrow('Could not stop process tree 4321.')
    expect(listProcesses).toHaveBeenCalledTimes(1)
  })
})
