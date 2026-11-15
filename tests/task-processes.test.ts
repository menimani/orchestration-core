import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OperatingSystem } from '../src/adapters/os.ts'
import type { WorktreeRemovalRuntime } from '../src/worktree.ts'
import {
  createOperatingSystem as createPosixOperatingSystem,
  type PosixOperatingSystemRuntime,
} from '../src/adapters/os-posix.ts'
import {
  createOperatingSystem as createWindowsOperatingSystem,
  type WindowsOperatingSystemRuntime,
} from '../src/adapters/os-windows.ts'
import { fleetPaths, orchPaths, statusFile, type OrchPaths } from '../src/paths.ts'
import { recordTaskProcess, taskProcessPid } from '../src/processRegistry.ts'
import {
  orphanedWorktreeDirectories, orphanedWorktreeReport, sweepAbandonedTemporaryWorktrees,
  terminateLiveTaskProcesses, worktreeHolderHint,
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
  it('finds and terminates a registry-only process retained after startup failure', () => {
    recordTaskProcess(paths, 'retained-startup', 101, () => 'started:101')
    const alive = new Set([101])
    const terminateProcessTree = vi.fn((pid: number) => {
      alive.delete(pid)
      return true
    })
    const os = {
      processStartIdentity: (pid: number) => alive.has(pid) ? `started:${pid}` : undefined,
      processIsAlive: (pid: number) => alive.has(pid),
      processTreeIsAlive: (pid: number) => alive.has(pid),
      terminateProcessTree,
    } as unknown as OperatingSystem

    const result = terminateLiveTaskProcesses(paths, os)

    expect(terminateProcessTree).toHaveBeenCalledWith(101)
    expect(result).toEqual({
      terminated: [{ taskId: 'retained-startup', pid: 101 }],
      failures: [],
    })
    expect(taskProcessPid(paths, 'retained-startup')).toBeUndefined()
  })

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
      taskId: 'first-task', pid: 101, error: 'Could not stop process tree 101. Still running: PID 101.',
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
      processTreeIsAlive: () => true,
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

  it('retains registry state when termination is not verified', () => {
    writeRunningTask('still-live', 101)
    const os = {
      processStartIdentity: () => 'started:101',
      processIsAlive: () => true,
      processTreeIsAlive: () => true,
      terminateProcessTree: () => false,
    } as unknown as OperatingSystem

    const result = terminateLiveTaskProcesses(paths, os)

    expect(result).toEqual({
      terminated: [],
      failures: [{
        taskId: 'still-live', pid: 101, error: 'process tree termination could not be verified',
      }],
    })
    expect(taskProcessPid(paths, 'still-live', undefined, () => 'started:101')).toBe(101)
  })

  it('finds an orphaned tree after its runner root exits and retains failed cleanup', () => {
    writeRunningTask('orphaned-tree', 101)
    const terminateProcessTree = vi.fn(() => false)
    const os = {
      processStartIdentity: () => undefined,
      processIsAlive: () => false,
      processTreeIsAlive: () => true,
      terminateProcessTree,
    } as unknown as OperatingSystem

    const result = terminateLiveTaskProcesses(paths, os)

    expect(terminateProcessTree).not.toHaveBeenCalled()
    expect(result.failures).toEqual([{
      taskId: 'orphaned-tree', pid: 101,
      error: 'process identity was not captured at launch or is currently unavailable',
    }])
    expect(taskProcessPid(
      paths, 'orphaned-tree', undefined, () => undefined, () => true,
    )).toBe(101)
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
      .toBe("Find holder: lsof +D '/tmp/orphan'\\''s worktree'")
  })

  it('gives the holder lookup the absolute path of a fleet worktree outside the checkout', () => {
    const fleet = fleetPaths(
      { dir: join(repoRoot, 'fleet'), project: 'example', repository: 'owner/example' },
      join(repoRoot, 'checkout'),
    )
    const orphan = join(fleet.worktreesDir, 'orphan-task')
    mkdirSync(orphan)
    const looked: string[] = []
    const os = {
      worktreePathFor(path: string) {
        looked.push(path)
        return { holderHint: `Find holder: ${path}` }
      },
    } as unknown as OperatingSystem

    const report = orphanedWorktreeReport(fleet, orphan, os)

    expect(report.displayed).toBe(join('..', 'fleet', 'state', 'example', 'worktrees', 'orphan-task'))
    expect(looked).toEqual([orphan])
    expect(isAbsolute(orphan)).toBe(true)
    expect(report.holderHint).toContain(orphan)
  })
})

describe('sweepAbandonedTemporaryWorktrees', () => {
  function runtime(alive: Set<number>, removable = true): {
    runtime: WorktreeRemovalRuntime
    gitCalls: string[][]
  } {
    const gitCalls: string[][] = []
    return {
      gitCalls,
      runtime: {
        os: {
          processIsAlive: (pid: number) => alive.has(pid),
          terminateWorktreeProcesses: () => {},
          worktreePathFor: (path: string) => ({ removalPath: path, removalFallback: 'rm' }),
          removeDirectory: (path: string) => {
            if (!removable) throw new Error('EBUSY: still held')
            rmSync(path, { recursive: true, force: true })
          },
        } as unknown as OperatingSystem,
        git: (_cwd, args) => {
          gitCalls.push(args)
          if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('not a working tree')
          return ''
        },
      },
    }
  }

  it('removes only gate worktrees whose owner is gone, then prunes the registration', () => {
    const abandonedMerge = join(paths.worktreesDir, '.merge-0101_task-111-1700000000000')
    const abandonedAdopt = join(paths.worktreesDir, '.adopt-42-222-1700000000000')
    const liveMerge = join(paths.worktreesDir, '.merge-0101_task-333-1700000000000')
    const task = join(paths.worktreesDir, 'task-without-status')
    for (const directory of [abandonedMerge, abandonedAdopt, liveMerge, task]) {
      mkdirSync(directory, { recursive: true })
    }
    const fake = runtime(new Set([333]))

    const sweep = sweepAbandonedTemporaryWorktrees(paths, () => {}, undefined, fake.runtime)

    expect(sweep).toEqual({ removed: [abandonedAdopt, abandonedMerge], failures: [] })
    expect(existsSync(liveMerge)).toBe(true)
    expect(existsSync(task)).toBe(true)
    expect(fake.gitCalls).toContainEqual(['worktree', 'prune'])
    expect(orphanedWorktreeDirectories(paths)).toEqual([liveMerge, task])
  })

  it('treats the restart predecessor as settled even while it is still alive', () => {
    const predecessorMerge = join(paths.worktreesDir, '.merge-0101_task-444-1700000000000')
    mkdirSync(predecessorMerge, { recursive: true })

    const sweep = sweepAbandonedTemporaryWorktrees(
      paths, () => {}, 444, runtime(new Set([444])).runtime,
    )

    expect(sweep.removed).toEqual([predecessorMerge])
    expect(existsSync(predecessorMerge)).toBe(false)
  })

  // Behind the Windows wrapper the predecessor's tree root is the wrapper, while the gate
  // worktree carries the PID of the Node process inside it.
  it('treats a predecessor whose tree root differs from its own PID as settled', () => {
    const predecessorMerge = join(paths.worktreesDir, '.merge-0101_task-601-1700000000000')
    mkdirSync(predecessorMerge, { recursive: true })

    const sweep = sweepAbandonedTemporaryWorktrees(
      paths, () => {}, [600, 601], runtime(new Set([600, 601])).runtime,
    )

    expect(sweep).toEqual({ removed: [predecessorMerge], failures: [] })
    expect(existsSync(predecessorMerge)).toBe(false)
  })

  it('keeps a wrapped daemon worktree while that daemon lives and is not the predecessor', () => {
    const liveMerge = join(paths.worktreesDir, '.merge-0101_task-601-1700000000000')
    mkdirSync(liveMerge, { recursive: true })

    const unsettled = sweepAbandonedTemporaryWorktrees(
      paths, () => {}, undefined, runtime(new Set([600, 601])).runtime,
    )
    const rootOnly = sweepAbandonedTemporaryWorktrees(
      paths, () => {}, 600, runtime(new Set([600, 601])).runtime,
    )

    expect(unsettled).toEqual({ removed: [], failures: [] })
    expect(rootOnly).toEqual({ removed: [], failures: [] })
    expect(existsSync(liveMerge)).toBe(true)
  })

  it('keeps a worktree naming an unrelated live PID at a wrapped handover', () => {
    const unrelated = join(paths.worktreesDir, '.adopt-42-777-1700000000000')
    mkdirSync(unrelated, { recursive: true })

    const sweep = sweepAbandonedTemporaryWorktrees(
      paths, () => {}, [600, 601], runtime(new Set([600, 601, 777])).runtime,
    )

    expect(sweep).toEqual({ removed: [], failures: [] })
    expect(orphanedWorktreeDirectories(paths)).toEqual([unrelated])
  })

  it('reports a worktree it cannot remove and leaves it for the orphan check', () => {
    const held = join(paths.worktreesDir, '.adopt-42-555-1700000000000')
    mkdirSync(held, { recursive: true })

    const sweep = sweepAbandonedTemporaryWorktrees(
      paths, () => {}, undefined, runtime(new Set(), false).runtime,
    )

    expect(sweep.removed).toEqual([])
    expect(sweep.failures).toEqual([{
      worktree: held, error: 'git: not a working tree; fallback: EBUSY: still held',
    }])
    expect(orphanedWorktreeDirectories(paths)).toEqual([held])
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

  it('probes a live Windows root omitted from the CIM snapshot', () => {
    const runtime: WindowsOperatingSystemRuntime = {
      spawn: () => {},
      listProcesses: () => [],
      probeProcess: () => {},
      remove: () => {},
      now: Date.now,
      sleep: () => {},
    }

    expect(createWindowsOperatingSystem(runtime).processTreeIsAlive(4321)).toBe(true)
  })

  it('terminates a live Windows root omitted from the CIM snapshot', () => {
    let alive = true
    const spawn = vi.fn(() => { alive = false })
    const runtime: WindowsOperatingSystemRuntime = {
      spawn,
      listProcesses: () => [],
      probeProcess: () => {
        if (!alive) throw gone()
      },
      remove: () => {},
      now: Date.now,
      sleep: () => {},
    }

    expect(createWindowsOperatingSystem(runtime).terminateProcessTree(4321)).toBe(true)
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', '4321', '/T', '/F'])
  })

  it('refuses to terminate a Windows tree containing the test runner', () => {
    const spawn = vi.fn()
    const runtime: WindowsOperatingSystemRuntime = {
      spawn,
      listProcesses: () => [
        { pid: 4321, parentPid: 0 },
        { pid: process.pid, parentPid: 4321 },
      ],
      probeProcess: () => {},
      remove: () => {},
      now: Date.now,
      sleep: () => {},
    }

    expect(() => createWindowsOperatingSystem(runtime).terminateProcessTree(4321))
      .toThrow(
        `Refusing to stop process tree 4321 because it contains the current process ${process.pid}`
        + ` through 4321 (creation time unknown) -> ${process.pid} (creation time unknown).`,
      )
    expect(spawn).not.toHaveBeenCalled()
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
      .toThrow(new Error('Could not stop process tree 4321. Still running: PID 4322.'))
    expect(listProcesses).toHaveBeenCalledTimes(1)
  })

  it('lists a Windows tree again when its first snapshot failed', () => {
    let alive = true
    let now = 0
    const listProcesses = vi.fn((): { pid: number, parentPid: number }[] => {
      if (listProcesses.mock.calls.length === 1) throw new Error('CIM query failed')
      return alive ? [{ pid: 4321, parentPid: 1 }] : []
    })
    const spawn = vi.fn(() => { alive = false })
    const runtime: WindowsOperatingSystemRuntime = {
      spawn,
      listProcesses,
      probeProcess: () => {
        if (!alive) throw gone()
      },
      remove: () => {},
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
    }

    expect(createWindowsOperatingSystem(runtime).terminateProcessTree(4321)).toBe(true)
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', '4321', '/T', '/F'])
    expect(listProcesses).toHaveBeenCalledTimes(2)
    expect(now).toBe(50)
  })

  it('reports a Windows tree that could never be listed as not stopped', () => {
    let now = 0
    const runtime: WindowsOperatingSystemRuntime = {
      spawn: () => {},
      listProcesses: () => { throw new Error('CIM query failed') },
      probeProcess: () => { throw gone() },
      remove: () => {},
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
    }

    expect(() => createWindowsOperatingSystem(runtime).terminateProcessTree(4321))
      .toThrow(new Error('Could not stop process tree 4321. Its processes could not be listed.'))
    expect(now).toBe(5_000)
  })
})
