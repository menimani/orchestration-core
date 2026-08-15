import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import type {
  DaemonLaunchOptions, DaemonProcess, OperatingSystem,
} from '../src/adapters/os.ts'
import {
  LOOP_RESTART_PREDECESSOR_PID_ENV, LOOP_RESTART_READY_FILE_ENV,
  publishLoopReplacementPid, signalLoopRestartReady, startLoopReplacement,
} from '../src/restart.ts'
import { WINDOWS_PROCESS_ROOT_PID_ENV } from '../src/adapters/windows-process.ts'
import { processMarker, processMarkerText } from '../src/processMarker.ts'

const fixtureRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fakeChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    kill: vi.fn(() => true),
    unref: vi.fn(),
  }) as unknown as ChildProcess
}

function fakeOperatingSystem(
  child: ChildProcess,
  onLaunch: (options: DaemonLaunchOptions) => void = () => {},
): OperatingSystem {
  const daemon: DaemonProcess = {
    pid: child.pid!,
    isAlive: () => child.exitCode === null,
    terminate: () => { child.kill() },
    release: () => { child.unref() },
    onError: (listener) => { child.on('error', listener) },
    offError: (listener) => { child.off('error', listener) },
    onExit: (listener) => { child.on('exit', listener) },
    offExit: (listener) => { child.off('exit', listener) },
  }
  return {
    launchDaemon: async (options: DaemonLaunchOptions) => {
      onLaunch(options)
      return daemon
    },
    processTreeRootPid: () => process.pid,
  } as unknown as OperatingSystem
}

/**
 * A daemon started through the hidden-console wrapper identifies itself by the wrapper's
 * PID, and every descendant inherits the variable that says so. The suite runs as one of
 * those descendants at a merge gate, where inheriting it made these tests assert the
 * daemon's PID against their own. The premise is stated here instead of inherited.
 */
function environmentWithoutWrapper(): NodeJS.ProcessEnv {
  const { [WINDOWS_PROCESS_ROOT_PID_ENV]: wrapper, ...rest } = process.env
  void wrapper
  return rest
}

describe('loop replacement startup', () => {
  it('keeps the predecessor PID until the replacement publishes readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-restart-'))
    fixtureRoots.push(root)
    const readyFile = join(root, 'ready')
    const pidFile = join(root, 'loop.pid')
    vi.spyOn(operatingSystem, 'processStartIdentity')
      .mockImplementation((pid) => `start-${pid}`)
    const predecessorMarker = processMarkerText(processMarker(process.pid))
    writeFileSync(pidFile, predecessorMarker)
    const child = fakeChild(43210)
    const os = fakeOperatingSystem(child, (options) => {
      const env = options.env as NodeJS.ProcessEnv
      expect(env[LOOP_RESTART_READY_FILE_ENV]).toBe(readyFile)
      expect(env[LOOP_RESTART_PREDECESSOR_PID_ENV]).toBe(`${process.pid}`)
      // The predecessor exits as soon as this process is ready, and an attached child
      // dies with it: a Windows consumer's loop ended at its first core auto-update.
      expect(options.outputFile).toBe(join(root, 'loop.log'))
      expect(readFileSync(pidFile, 'utf8')).toBe(predecessorMarker)
      setTimeout(() => writeFileSync(readyFile, '43210\n'), 0)
    })

    await expect(startLoopReplacement(readyFile, {
      env: environmentWithoutWrapper(),
      operatingSystem: os,
      outputFile: join(root, 'loop.log'),
      packageRoot: root,
      onReady: (pid) => publishLoopReplacementPid(pidFile, process.pid, pid),
      startupTimeoutMs: 1_000,
    })).resolves.toEqual({ ok: true, pid: 43210 })
    expect(readFileSync(pidFile, 'utf8'))
      .toBe(processMarkerText({ pid: 43210, startIdentity: 'start-43210' }))
    expect(child.unref).toHaveBeenCalled()
  })

  it('keeps the predecessor PID when the replacement exits before readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-restart-'))
    fixtureRoots.push(root)
    const pidFile = join(root, 'loop.pid')
    vi.spyOn(operatingSystem, 'processStartIdentity')
      .mockImplementation((pid) => `start-${pid}`)
    const predecessorMarker = processMarkerText(processMarker(process.pid))
    writeFileSync(pidFile, predecessorMarker)
    const child = fakeChild(43211)
    const os = fakeOperatingSystem(child, () => {
      setTimeout(() => {
        Object.assign(child, { exitCode: 1 })
        child.emit('exit', 1, null)
      }, 0)
    })

    await expect(startLoopReplacement(join(root, 'ready'), {
      env: environmentWithoutWrapper(),
      operatingSystem: os,
      outputFile: join(root, 'loop.log'),
      packageRoot: root,
      onReady: (pid) => publishLoopReplacementPid(pidFile, process.pid, pid),
      startupTimeoutMs: 1_000,
    })).resolves.toEqual({
      ok: false,
      pid: 43211,
      error: 'replacement exited before becoming ready (exit code 1)',
    })
    expect(readFileSync(pidFile, 'utf8')).toBe(predecessorMarker)
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('delegates replacement launch details to the operating-system adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-restart-'))
    fixtureRoots.push(root)
    const readyFile = join(root, 'ready')
    const outputFile = join(root, 'loop.log')
    const child = fakeChild(43212)
    const launchDaemon = vi.fn((options: DaemonLaunchOptions) => {
      expect(options.outputFile).toBe(outputFile)
      expect(options.env?.[LOOP_RESTART_READY_FILE_ENV]).toBe(readyFile)
      expect(options.env?.[LOOP_RESTART_PREDECESSOR_PID_ENV]).toBe(`${process.pid}`)
      setTimeout(() => writeFileSync(readyFile, '43212\n'), 0)
    })
    const os = fakeOperatingSystem(child, launchDaemon)

    await expect(startLoopReplacement(readyFile, {
      env: environmentWithoutWrapper(),
      operatingSystem: os,
      outputFile,
      packageRoot: root,
      startupTimeoutMs: 1_000,
    })).resolves.toEqual({ ok: true, pid: 43212 })
    expect(launchDaemon).toHaveBeenCalledOnce()
  })

  it('returns replacement cleanup failures after the startup timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-restart-'))
    fixtureRoots.push(root)
    const child = fakeChild(43213)
    child.kill = vi.fn(() => { throw new Error('access denied while stopping replacement') })

    await expect(startLoopReplacement(join(root, 'ready'), {
      env: environmentWithoutWrapper(),
      operatingSystem: fakeOperatingSystem(child),
      outputFile: join(root, 'loop.log'),
      packageRoot: root,
      startupTimeoutMs: 1,
    })).resolves.toEqual({
      ok: false,
      pid: 43213,
      error: 'replacement did not become ready before the startup timeout; '
        + 'replacement cleanup failed: access denied while stopping replacement',
    })
  })

  it('signals the wrapper process as the Windows restart owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-restart-'))
    fixtureRoots.push(root)
    const readyFile = join(root, 'ready')

    signalLoopRestartReady({
      [LOOP_RESTART_READY_FILE_ENV]: readyFile,
      [WINDOWS_PROCESS_ROOT_PID_ENV]: '43213',
    }, {
      processTreeRootPid: (env?: NodeJS.ProcessEnv) => (
        Number(env?.[WINDOWS_PROCESS_ROOT_PID_ENV])
      ),
    } as unknown as OperatingSystem)

    expect(readFileSync(readyFile, 'utf8')).toBe('43213\n')
  })
})
