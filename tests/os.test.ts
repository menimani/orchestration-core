import type { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createOperatingSystem as createPosixOperatingSystem } from '../src/adapters/os-posix.ts'
import {
  createOperatingSystem as createWindowsOperatingSystem, type WindowsProcess,
} from '../src/adapters/os-windows.ts'
import { WINDOWS_PROCESS_ROOT_PID_ENV } from '../src/internalEnvironment.ts'
import { operatingSystem } from '../src/adapters/os.ts'
import { formatEventLine } from '../src/loop.ts'

describe('operating-system adapters', () => {
  it('returns a stable start identity for the current process', () => {
    const identity = operatingSystem.processStartIdentity(process.pid)

    expect(identity).toBeTruthy()
    expect(operatingSystem.processStartIdentity(process.pid)).toBe(identity)
  })

  it('falls back to PID liveness when the Windows start-identity query times out', async () => {
    const spawnSync = vi.fn(() => ({
      status: null,
      stdout: '',
      error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    }))
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...await importOriginal<typeof import('node:child_process')>(),
      spawnSync,
    }))
    vi.resetModules()
    try {
      const [windows, os, processOwner] = await Promise.all([
        import('../src/adapters/os-windows.ts'),
        import('../src/adapters/os.ts'),
        import('../src/processOwner.ts'),
      ])
      const windowsOs = windows.createOperatingSystem()

      expect(windowsOs.processStartIdentity(process.pid)).toBeUndefined()
      expect(spawnSync).toHaveBeenCalledWith(
        'powershell.exe',
        expect.anything(),
        expect.objectContaining({ timeout: 5_000 }),
      )

      vi.spyOn(os.operatingSystem, 'processStartIdentity')
        .mockImplementation((pid) => windowsOs.processStartIdentity(pid))
      const processIsAlive = vi.spyOn(os.operatingSystem, 'processIsAlive').mockReturnValue(true)
      expect(processOwner.lockOwnerIsCurrent(process.pid, 'recorded-start')).toBe(true)
      processIsAlive.mockReturnValue(false)
      expect(processOwner.lockOwnerIsCurrent(process.pid, 'recorded-start')).toBe(false)
      expect(processIsAlive).toHaveBeenCalledWith(process.pid)
    } finally {
      vi.restoreAllMocks()
      vi.doUnmock('node:child_process')
      vi.resetModules()
    }
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

  it('spawns terminable children the way each adapter stops their tree', () => {
    expect(createWindowsOperatingSystem().terminableSpawnOptions()).toEqual({ detached: false })
    expect(createPosixOperatingSystem().terminableSpawnOptions()).toEqual({ detached: true })
  })

  it('launches a POSIX daemon without exposing the platform choice to callers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-os-'))
    const child = Object.assign(new EventEmitter(), {
      pid: 43210,
      exitCode: null,
      signalCode: null,
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

  it('reports a POSIX daemon killed by a signal as no longer alive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-os-'))
    const child = Object.assign(new EventEmitter(), {
      pid: 43210,
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
      unref: vi.fn(),
    })
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

      expect(daemon.isAlive()).toBe(true)
      child.signalCode = 'SIGKILL'
      expect(daemon.isAlive()).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('terminates and verifies the entire POSIX daemon process group', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-os-'))
    const child = Object.assign(new EventEmitter(), {
      pid: 43210,
      exitCode: null,
      signalCode: null,
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

  it('kills a POSIX process group that survives SIGTERM past its grace period', () => {
    let now = 0
    let killed = false
    const signalProcessGroup = vi.fn((_pid: number, signal?: NodeJS.Signals | number) => {
      // The group traps SIGTERM; only SIGKILL stops it.
      if (signal === 'SIGKILL') killed = true
    })
    const os = createPosixOperatingSystem({
      signalProcessGroup,
      probeProcess: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) },
      remove: () => {},
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
      groupHasRunningMember: () => !killed,
    })

    expect(os.terminateProcessTree(43212)).toBe(true)

    const sent = signalProcessGroup.mock.calls
      .map(([, signal]) => signal)
      .filter((signal) => signal !== 0)
    expect(sent).toEqual([undefined, 'SIGKILL'])
    expect(now).toBe(5_000)
  })

  it('reports a POSIX process group that survives SIGKILL as not stopped', () => {
    let now = 0
    const signalProcessGroup = vi.fn()
    const os = createPosixOperatingSystem({
      signalProcessGroup,
      probeProcess: () => {},
      remove: () => {},
      now: () => now,
      sleep: (milliseconds) => { now += milliseconds },
      groupHasRunningMember: () => true,
    })

    expect(() => os.terminateProcessTree(43213)).toThrow('Could not stop process tree 43213.')
    expect(signalProcessGroup).toHaveBeenCalledWith(43213)
    expect(signalProcessGroup).toHaveBeenCalledWith(43213, 'SIGKILL')
    expect(now).toBe(10_000)
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

  it('launches a POSIX agent detached with the input file as standard input', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-os-'))
    const child = Object.assign(new EventEmitter(), { pid: 43213, unref: vi.fn() })
    const spawnAgent = vi.fn(() => child) as unknown as typeof spawn
    const os = createPosixOperatingSystem({
      signalProcessGroup: () => {}, probeProcess: () => {}, remove: () => {},
      now: Date.now, sleep: () => {}, groupHasRunningMember: () => undefined,
      spawnAgent,
    })
    const inputFile = join(root, 'task.md')
    writeFileSync(inputFile, 'task specification')

    try {
      const started = os.launchAgent({
        args: ['exec', '-'],
        cwd: root,
        inputFile,
        outputFile: join(root, 'task.log'),
        program: 'codex',
      })
      child.emit('spawn')

      await expect(started).resolves.toBe(43213)
      expect(spawnAgent).toHaveBeenCalledWith('codex', ['exec', '-'], {
        cwd: root,
        detached: true,
        stdio: [expect.any(Number), expect.any(Number), expect.any(Number)],
        windowsHide: true,
      })
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a POSIX agent that failed to spawn or received no PID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-os-'))
    const children: (EventEmitter & { pid: number | undefined, unref: () => void })[] = []
    const os = createPosixOperatingSystem({
      signalProcessGroup: () => {}, probeProcess: () => {}, remove: () => {},
      now: Date.now, sleep: () => {}, groupHasRunningMember: () => undefined,
      spawnAgent: (() => {
        const child = Object.assign(new EventEmitter(), { pid: undefined, unref: vi.fn() })
        children.push(child)
        return child
      }) as unknown as typeof spawn,
    })
    const options = {
      args: [], cwd: root, inputFile: join(root, 'task.md'),
      outputFile: join(root, 'task.log'), program: 'codex',
    }

    try {
      await expect(os.launchAgent(options)).rejects.toThrow()
      expect(children).toHaveLength(0)

      writeFileSync(options.inputFile, 'task specification')
      const withoutPid = os.launchAgent(options)
      children[0]!.emit('spawn')
      await expect(withoutPid).rejects.toThrow('codex spawned without a PID')

      const error = new Error('spawn failed')
      const failed = os.launchAgent(options)
      children[1]!.emit('error', error)
      await expect(failed).rejects.toBe(error)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('spawns a POSIX agent command as named', () => {
    expect(createPosixOperatingSystem().agentCommand('claude', ['-p'])).toEqual({
      command: 'claude', args: ['-p'], verbatimArguments: false,
    })
  })

  it('routes a Windows agent named by command through cmd.exe and the hidden launcher', async () => {
    const startAgent = vi.fn(async () => 43214)
    const os = createWindowsOperatingSystem({
      spawn: () => {}, listProcesses: () => [], probeProcess: () => {}, remove: () => {},
      now: Date.now, sleep: () => {}, startAgent,
    })

    await expect(os.launchAgent({
      args: ['exec', '--output-last-message', 'final-message.txt', '-'],
      cwd: 'worktree',
      inputFile: 'task.md',
      outputFile: 'task.log',
      program: 'codex',
    })).resolves.toBe(43214)
    expect(startAgent).toHaveBeenCalledWith({
      args: [
        '/d /v:off /s /c "codex ^"exec^" ^"--output-last-message^" ^"final-message.txt^" ^"-^""',
      ],
      command: 'cmd.exe',
      cwd: 'worktree',
      inputFile: 'task.md',
      outputFile: 'task.log',
      verbatimArguments: true,
    })
  })

  it('launches a Windows agent named by absolute path without cmd.exe', async () => {
    const startAgent = vi.fn(async () => 43215)
    const os = createWindowsOperatingSystem({
      spawn: () => {}, listProcesses: () => [], probeProcess: () => {}, remove: () => {},
      now: Date.now, sleep: () => {}, startAgent,
    })

    await expect(os.launchAgent({
      args: ['runner-claude.ts', '--model', 'claude-opus-5'],
      cwd: 'worktree',
      inputFile: 'task.md',
      outputFile: 'task.log',
      program: 'C:\\Program Files\\nodejs\\node.exe',
    })).resolves.toBe(43215)
    expect(startAgent).toHaveBeenCalledWith({
      args: ['runner-claude.ts', '--model', 'claude-opus-5'],
      command: 'C:\\Program Files\\nodejs\\node.exe',
      cwd: 'worktree',
      inputFile: 'task.md',
      outputFile: 'task.log',
    })
  })

  it('escapes cmd metacharacters in a Windows agent command', () => {
    const { command, args, verbatimArguments } = createWindowsOperatingSystem()
      .agentCommand('claude', ['--model', 'opus&50%^x', 'C:\\Users\\AT&T\\final.txt'])

    expect(command).toBe('cmd.exe')
    expect(verbatimArguments).toBe(true)
    expect(args).toEqual([
      '/d /v:off /s /c "claude ^"--model^" ^"opus^&50^%^^x^" ^"C:\\Users\\AT^&T\\final.txt^""',
    ])
  })

  it('rejects a Windows agent argument cmd.exe cannot pass literally', async () => {
    const startAgent = vi.fn(async () => 43216)
    const os = createWindowsOperatingSystem({
      spawn: () => {}, listProcesses: () => [], probeProcess: () => {}, remove: () => {},
      now: Date.now, sleep: () => {}, startAgent,
    })

    expect(() => os.agentCommand('claude', ['--model', 'two\nlines']))
      .toThrow('quote or line break')
    await expect(os.launchAgent({
      args: ['--model', 'say "hi"'], cwd: 'worktree', inputFile: 'task.md',
      outputFile: 'task.log', program: 'codex',
    })).rejects.toThrow('quote or line break')
    expect(startAgent).not.toHaveBeenCalled()
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

  it('selects Windows processes that name the worktree in either case, slash direction, or drive spelling', () => {
    const worktree = 'C:\\Fleet\\worktrees\\task-1'
    const processes = [
      { pid: 101, commandLine: 'bash.exe -c "cd c:/fleet/WORKTREES/task-1 && npm test"', executablePath: 'C:\\Git\\bin\\bash.exe' },
      { pid: 102, commandLine: null, executablePath: 'c:\\FLEET\\worktrees\\task-1\\node_modules\\.bin\\vitest.exe' },
      { pid: 103, commandLine: '"C:\\Program Files\\nodejs\\node.exe" C:/Fleet/worktrees/Task-1/scripts/run-tests.mjs', executablePath: null },
      { pid: 107, commandLine: 'bash.exe -c "cd /c/Fleet/worktrees/task-1 && npm test"', executablePath: 'C:\\Git\\bin\\bash.exe' },
      { pid: 108, commandLine: 'bash.exe --login -i --cd=/cygdrive/C/fleet/worktrees/task-1', executablePath: null },
      { pid: 104, commandLine: 'node C:\\Fleet\\worktrees\\task-10\\scripts\\run-tests.mjs', executablePath: null },
      { pid: 105, commandLine: 'mvn test', executablePath: 'C:\\maven\\bin\\mvn.cmd' },
      { pid: 106, commandLine: null, executablePath: null },
      { pid: 109, commandLine: 'node /srv/c/Fleet/worktrees/task-1/run.mjs', executablePath: null },
      { pid: process.pid, commandLine: `node ${worktree}\\src\\cli.ts cleanup`, executablePath: null },
    ]

    const taskkillsFor = (path: string) => {
      const alive = new Set(processes.map(({ pid }) => pid))
      const spawn = vi.fn((_command: string, args: readonly string[]) => {
        alive.delete(Number(args[1]))
      })
      const os = createWindowsOperatingSystem({
        spawn,
        listProcesses: () => processes.map(({ pid }) => ({ pid, parentPid: 1 })),
        listProcessCommands: () => processes,
        probeProcess: (pid) => {
          if (alive.has(pid)) return
          const error = new Error('gone') as NodeJS.ErrnoException
          error.code = 'ESRCH'
          throw error
        },
        remove: () => {},
        now: () => 0,
        sleep: () => {},
      })
      os.terminateWorktreeProcesses(path, () => {})
      return spawn.mock.calls
    }
    const expected = [101, 102, 103, 107, 108].map((pid) => ['taskkill', ['/PID', `${pid}`, '/T', '/F']])

    expect(taskkillsFor(worktree)).toEqual(expected)
    expect(taskkillsFor(`\\\\?\\${worktree}\\`)).toEqual(expected)
  })

  it('terminates and reports each Windows process tree holding a worktree and tolerates a survivor', () => {
    let now = 0
    const alive = new Set([201, 202, 204])
    const spawn = vi.fn((_command: string, args: readonly string[]) => {
      // 202 ignores taskkill, as a process the account cannot stop would.
      if (args[1] === '201') {
        alive.delete(201)
        alive.delete(204)
      }
    })
    const os = createWindowsOperatingSystem({
      spawn,
      listProcesses: () => [
        { pid: 201, parentPid: 1 }, { pid: 202, parentPid: 1 }, { pid: 204, parentPid: 201 },
      ],
      listProcessCommands: () => [
        { pid: 201, name: 'bash.exe', commandLine: 'bash.exe -c "cd C:/Fleet/worktrees/task-2"', executablePath: 'C:\\Git\\bin\\bash.exe' },
        { pid: 204, commandLine: 'node C:\\Fleet\\worktrees\\task-2\\run.mjs', executablePath: 'C:\\Program Files\\nodejs\\node.exe' },
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

    const worktree = 'C:\\Fleet\\worktrees\\task-2'
    const report = vi.fn()

    expect(() => os.terminateWorktreeProcesses(worktree, report)).not.toThrow()

    expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', '201', '/T', '/F'])
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', '202', '/T', '/F'])
    // 204 ended with the tree of 201, and 203 had already exited.
    expect(spawn).toHaveBeenCalledTimes(2)
    // Only the tree that stopped is reported, once; the survivor is left to the removal.
    expect(report.mock.calls).toEqual([
      [formatEventLine('Stopped', 'PID 201', `bash.exe holding worktree ${worktree}`)],
    ])
  })

  it('reports nothing when no Windows process holds the worktree', () => {
    const spawn = vi.fn()
    const os = createWindowsOperatingSystem({
      spawn,
      listProcesses: () => [{ pid: 211, parentPid: 1 }],
      listProcessCommands: () => [
        { pid: 211, name: 'node.exe', commandLine: 'node C:\\Fleet\\worktrees\\task-20\\run.mjs', executablePath: null },
      ],
      probeProcess: () => {},
      remove: () => {},
      now: () => 0,
      sleep: () => {},
    })
    const report = vi.fn()

    os.terminateWorktreeProcesses('C:\\Fleet\\worktrees\\task-2', report)

    expect(spawn).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  function processTreeOs(
    processes: readonly WindowsProcess[],
    spawn: (command: string, args: readonly string[]) => void = () => {},
    processStartIdentity?: (pid: number) => string | undefined,
  ) {
    const alive = new Set(processes.map(({ pid }) => pid))
    let now = 0
    return {
      alive,
      os: createWindowsOperatingSystem({
        spawn: (command, args) => {
          spawn(command, args)
          if (command === 'taskkill') alive.clear()
        },
        listProcesses: () => processes,
        probeProcess: (pid) => {
          if (alive.has(pid)) return
          const error = new Error('gone') as NodeJS.ErrnoException
          error.code = 'ESRCH'
          throw error
        },
        remove: () => {},
        now: () => now,
        sleep: (milliseconds) => { now += milliseconds },
        ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
      }),
    }
  }

  it('excludes an orphan that predates the process now holding its parent PID', () => {
    // 401 is a recycled PID: 402 was started by the PID's earlier owner and 403 by 402.
    const { alive, os } = processTreeOs([
      { pid: 401, parentPid: 1, createdAt: 5_000 },
      { pid: 402, parentPid: 401, createdAt: 1_000 },
      { pid: 403, parentPid: 402, createdAt: 2_000 },
    ])
    alive.delete(401)

    expect(os.processTreeIsAlive(401)).toBe(false)
  })

  it('includes a child created after its parent', () => {
    const { alive, os } = processTreeOs([
      { pid: 411, parentPid: 1, createdAt: 1_000 },
      { pid: 412, parentPid: 411, createdAt: 1_000 },
      { pid: 413, parentPid: 412, createdAt: 3_000 },
    ])
    alive.delete(411)
    alive.delete(412)

    expect(os.processTreeIsAlive(411)).toBe(true)
  })

  it('keeps a parent link when either creation time is missing', () => {
    const { alive, os } = processTreeOs([
      { pid: 421, parentPid: 1, createdAt: 5_000 },
      { pid: 422, parentPid: 421 },
      { pid: 423, parentPid: 1 },
      { pid: 424, parentPid: 423, createdAt: 1_000 },
    ])
    alive.delete(421)
    alive.delete(423)

    expect(os.processTreeIsAlive(421)).toBe(true)
    expect(os.processTreeIsAlive(423)).toBe(true)
  })

  it('terminates a recycled PID whose stale descendants include the current process', () => {
    const spawn = vi.fn()
    const { os } = processTreeOs([
      { pid: 431, parentPid: 1, createdAt: 5_000 },
      { pid: 432, parentPid: 431, createdAt: 1_000 },
      { pid: process.pid, parentPid: 432, createdAt: 2_000 },
    ], spawn)

    expect(os.terminateProcessTree(431)).toBe(true)
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', '431', '/T', '/F'])
  })

  it('names the parent chain that linked the current process into a refused tree', () => {
    const spawn = vi.fn()
    const { os } = processTreeOs([
      { pid: 441, parentPid: 1, createdAt: 1_000 },
      { pid: 442, parentPid: 441, createdAt: 2_000 },
      { pid: process.pid, parentPid: 442, createdAt: 3_000 },
    ], spawn)

    expect(() => os.terminateProcessTree(441)).toThrow(
      `Refusing to stop process tree 441 because it contains the current process ${process.pid}`
      + ' through 441 (created 1970-01-01T00:00:01.000Z) -> 442 (created 1970-01-01T00:00:02.000Z)'
      + ` -> ${process.pid} (created 1970-01-01T00:00:03.000Z).`,
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('dates a live root the snapshot omitted before trusting links to its PID', () => {
    // 451 is alive but missing from the snapshot; 452 is an orphan of the PID's earlier owner.
    const spawn = vi.fn()
    const processStartIdentity = vi.fn((pid: number) => (
      pid === 451 ? `windows:${621_355_968_000_000_000n + 5_000n * 10_000n}` : undefined
    ))
    const { alive, os } = processTreeOs([
      { pid: 452, parentPid: 451, createdAt: 1_000 },
      { pid: process.pid, parentPid: 452, createdAt: 2_000 },
    ], spawn, processStartIdentity)
    alive.add(451)

    expect(os.terminateProcessTree(451)).toBe(true)
    expect(processStartIdentity).toHaveBeenCalledWith(451)
    expect(spawn).toHaveBeenCalledWith('taskkill', ['/PID', '451', '/T', '/F'])
  })

  it('keeps links to an omitted root whose start time cannot be read', () => {
    const { alive, os } = processTreeOs([
      { pid: 462, parentPid: 461, createdAt: 1_000 },
    ], () => {}, () => undefined)

    expect(alive.has(461)).toBe(false)
    expect(os.processTreeIsAlive(461)).toBe(true)
  })

  it('leaves an orphan alone when stopping an omitted root whose start time cannot be read', () => {
    // 471 is alive but omitted and its identity query timed out; 472 is a dated orphan of
    // the PID's earlier owner, while 473 lost its creation time and 474 descends from it.
    const processes: readonly WindowsProcess[] = [
      { pid: 472, parentPid: 471, createdAt: 1_000 },
      { pid: 473, parentPid: 471 },
      { pid: 474, parentPid: 473, createdAt: 3_000 },
    ]
    const stoppedOs = (killed: readonly number[]) => {
      const alive = new Set([471, 472, 473, 474])
      let now = 0
      const spawn = vi.fn((command: string) => {
        if (command === 'taskkill') killed.forEach((pid) => alive.delete(pid))
      })
      const os = createWindowsOperatingSystem({
        spawn,
        listProcesses: () => processes,
        probeProcess: (pid) => {
          if (alive.has(pid)) return
          const error = new Error('gone') as NodeJS.ErrnoException
          error.code = 'ESRCH'
          throw error
        },
        remove: () => {},
        now: () => now,
        sleep: (milliseconds) => { now += milliseconds },
        processStartIdentity: () => undefined,
      })
      return { alive, os, spawn }
    }

    const stopped = stoppedOs([471, 473, 474])
    expect(stopped.os.terminateProcessTree(471)).toBe(true)
    expect(stopped.spawn).toHaveBeenCalledWith('taskkill', ['/PID', '471', '/T', '/F'])
    expect(stopped.alive).toEqual(new Set([472]))

    const survivor = stoppedOs([471, 473])
    expect(() => survivor.os.terminateProcessTree(471))
      .toThrow('Could not stop process tree 471. Still running: PID 474.')
  })

  /** A Windows start identity for a process created `milliseconds` after the epoch. */
  const windowsIdentity = (milliseconds: number): string => (
    `windows:${621_355_968_000_000_000n + BigInt(milliseconds) * 10_000n}`
  )

  it('answers for no tree when a newer process holds a recorded PID and no orphan remains', () => {
    // 481 was recorded for a process created at 1 s; the holder was created at 5 s.
    const { os } = processTreeOs([
      { pid: 481, parentPid: 1, createdAt: 5_000 },
    ], () => {}, (pid) => (pid === 481 ? windowsIdentity(5_000) : undefined))

    expect(os.processTreeIsAlive(481)).toBe(true)
    expect(os.processTreeIsAlive(481, windowsIdentity(1_000))).toBe(false)
  })

  it('leaves the children of the process now holding a recorded PID out of its tree', () => {
    const { os } = processTreeOs([
      { pid: 491, parentPid: 1, createdAt: 5_000 },
      { pid: 492, parentPid: 491, createdAt: 6_000 },
      { pid: 493, parentPid: 492, createdAt: 7_000 },
    ], () => {}, (pid) => (pid === 491 ? windowsIdentity(5_000) : undefined))

    expect(os.processTreeIsAlive(491, windowsIdentity(1_000))).toBe(false)
  })

  it('answers alive while an orphan of the recorded process or its descendant lives', () => {
    // 502 names the reused PID and predates its holder; 503 descends from 502.
    const { alive, os } = processTreeOs([
      { pid: 501, parentPid: 1, createdAt: 5_000 },
      { pid: 502, parentPid: 501, createdAt: 2_000 },
      { pid: 503, parentPid: 502, createdAt: 3_000 },
    ], () => {}, (pid) => (pid === 501 ? windowsIdentity(5_000) : undefined))

    expect(os.processTreeIsAlive(501, windowsIdentity(1_000))).toBe(true)
    alive.delete(502)
    expect(os.processTreeIsAlive(501, windowsIdentity(1_000))).toBe(true)
    alive.delete(503)
    expect(os.processTreeIsAlive(501, windowsIdentity(1_000))).toBe(false)
    expect(os.processTreeIsAlive(501)).toBe(true)
  })

  it('counts an undated child of a reused recorded PID as a possible orphan', () => {
    const { os } = processTreeOs([
      { pid: 511, parentPid: 1, createdAt: 5_000 },
      { pid: 512, parentPid: 511 },
    ], () => {}, (pid) => (pid === 511 ? windowsIdentity(5_000) : undefined))

    expect(os.processTreeIsAlive(511, windowsIdentity(1_000))).toBe(true)
  })

  it('keeps the whole-tree answer when the holder identity is unreadable or matches', () => {
    const unreadable = processTreeOs([
      { pid: 521, parentPid: 1, createdAt: 5_000 },
    ], () => {}, () => undefined)
    const matching = processTreeOs([
      { pid: 531, parentPid: 1, createdAt: 1_000 },
    ], () => {}, (pid) => (pid === 531 ? windowsIdentity(1_000) : undefined))

    expect(unreadable.os.processTreeIsAlive(521, windowsIdentity(1_000))).toBe(true)
    expect(matching.os.processTreeIsAlive(531, windowsIdentity(1_000))).toBe(true)
  })

  it('answers no recorded group on POSIX once a process with another identity holds its ID', () => {
    const signalProcessGroup = vi.fn()
    const posixOs = (identity: string | undefined) => createPosixOperatingSystem({
      signalProcessGroup, probeProcess: () => {}, remove: () => {},
      now: Date.now, sleep: () => {}, groupHasRunningMember: () => true,
      processStartIdentity: () => identity,
    })

    expect(posixOs('linux:500').processTreeIsAlive(541, 'linux:100')).toBe(false)
    expect(signalProcessGroup).not.toHaveBeenCalled()
    expect(posixOs(undefined).processTreeIsAlive(541, 'linux:100')).toBe(true)
    expect(posixOs('linux:100').processTreeIsAlive(541, 'linux:100')).toBe(true)
    expect(posixOs('linux:500').processTreeIsAlive(541)).toBe(true)
  })

  it('leaves worktree processes alone on POSIX', () => {
    const signalProcessGroup = vi.fn()
    const os = createPosixOperatingSystem({
      signalProcessGroup, probeProcess: () => {}, remove: () => {},
      now: Date.now, sleep: () => {}, groupHasRunningMember: () => true,
    })

    const report = vi.fn()

    os.terminateWorktreeProcesses('/fleet/worktrees/task-3', report)

    expect(signalProcessGroup).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
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
