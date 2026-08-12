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
import {
  orphanedWorktreeDirectories, terminateLiveTaskProcesses, worktreeHolderHint,
} from '../src/taskProcesses.ts'

let repoRoot: string
let paths: OrchPaths

function writeRunningTask(taskId: string, pid: number): void {
  writeFileSync(statusFile(paths, taskId), JSON.stringify({ task_id: taskId, status: 'running', pid }))
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
      probeProcess: (pid) => {
        if (!alive.has(pid)) throw gone()
      },
      remove: () => {},
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
    })

    const result = terminateLiveTaskProcesses(paths, os)

    expect(spawn).toHaveBeenNthCalledWith(1, 'taskkill', ['/PID', '101', '/T', '/F'])
    expect(spawn).toHaveBeenNthCalledWith(2, 'taskkill', ['/PID', '102', '/T', '/F'])
    expect(result.terminated).toEqual([{ taskId: 'second-task', pid: 102 }])
    expect(result.failures).toEqual([{
      taskId: 'first-task', pid: 101, error: 'Could not stop process tree 101.',
    }])
  })
})

describe('orphanedWorktreeDirectories', () => {
  it('reports only directories that have no corresponding status file', () => {
    const owned = join(paths.worktreesDir, 'owned-task')
    const orphan = join(paths.worktreesDir, 'orphan-task')
    mkdirSync(owned)
    mkdirSync(orphan)
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
      probeProcess: () => {},
      remove: () => {},
      now: Date.now,
      sleep: () => {},
    }

    expect(createWindowsOperatingSystem(runtime).processTreeIsAlive(4321)).toBe(true)
  })
})
