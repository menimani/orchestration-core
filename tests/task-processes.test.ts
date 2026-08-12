import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { orchPaths, statusFile, type OrchPaths } from '../src/paths.ts'
import { processTreeIsAlive, type ProcessTreeRuntime } from '../src/processTree.ts'
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
    const runtime: ProcessTreeRuntime = {
      platform: 'win32',
      spawn,
      kill: (pid) => {
        if (!alive.has(pid)) throw gone()
      },
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
    }

    const result = terminateLiveTaskProcesses(paths, runtime)

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
    expect(worktreeHolderHint(orphan, 'win32')).toContain('handle.exe')
    expect(worktreeHolderHint("/tmp/orphan's worktree", 'linux'))
      .toBe("Find holder: lsof +D -- '/tmp/orphan'\\''s worktree'")
  })
})

describe('process-group liveness', () => {
  // A signal-0 probe cannot tell a running process from one that has exited and is
  // waiting to be reaped. Believing the probe made a successful termination look like a
  // failure: the exit wait ran to its five-second timeout and the stop reported an
  // error, on Linux only, where the leader stayed a zombie until its parent collected it.
  function runtime(overrides: Partial<ProcessTreeRuntime> = {}): ProcessTreeRuntime {
    return {
      platform: 'linux',
      spawn: () => {},
      kill: () => {},
      now: Date.now,
      sleep: () => {},
      ...overrides,
    }
  }

  it('treats a group whose only member is a zombie as stopped', () => {
    expect(processTreeIsAlive(4321, runtime({
      groupHasRunningMember: () => false,
    }))).toBe(false)
  })

  it('treats a group with a running member as alive', () => {
    expect(processTreeIsAlive(4321, runtime({
      groupHasRunningMember: () => true,
    }))).toBe(true)
  })

  it('keeps the probe answer where the platform cannot tell', () => {
    expect(processTreeIsAlive(4321, runtime({
      groupHasRunningMember: () => undefined,
    }))).toBe(true)
    expect(processTreeIsAlive(4321, runtime())).toBe(true)
  })

  it('does not consult the group state on Windows, where a killed tree disappears', () => {
    const groupHasRunningMember = vi.fn(() => false)

    expect(processTreeIsAlive(4321, runtime({ platform: 'win32', groupHasRunningMember })))
      .toBe(true)
    expect(groupHasRunningMember).not.toHaveBeenCalled()
  })

  it('still reports a stopped process group as stopped', () => {
    expect(processTreeIsAlive(4321, runtime({
      kill: () => { throw gone() },
      groupHasRunningMember: () => true,
    }))).toBe(false)
  })
})
