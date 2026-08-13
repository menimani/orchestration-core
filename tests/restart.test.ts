import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OperatingSystem } from '../src/adapters/os.ts'
import {
  LOOP_RESTART_PREDECESSOR_PID_ENV, LOOP_RESTART_READY_FILE_ENV,
  publishLoopReplacementPid, signalLoopRestartReady, startLoopReplacement,
} from '../src/restart.ts'
import { WINDOWS_PROCESS_ROOT_PID_ENV } from '../src/adapters/windows-process.ts'

const fixtureRoots: string[] = []

afterEach(() => {
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

describe('loop replacement startup', () => {
  it('keeps the predecessor PID until the replacement publishes readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-restart-'))
    fixtureRoots.push(root)
    const readyFile = join(root, 'ready')
    const pidFile = join(root, 'loop.pid')
    writeFileSync(pidFile, `${process.pid}\n`)
    const child = fakeChild(43210)
    const spawnProcess = vi.fn((_executable, _args, options) => {
      const env = options.env as NodeJS.ProcessEnv
      expect(env[LOOP_RESTART_READY_FILE_ENV]).toBe(readyFile)
      expect(env[LOOP_RESTART_PREDECESSOR_PID_ENV]).toBe(`${process.pid}`)
      // The predecessor exits as soon as this process is ready, and an attached child
      // dies with it: a Windows consumer's loop ended at its first core auto-update.
      expect(options.detached).toBe(true)
      expect(readFileSync(pidFile, 'utf8')).toBe(`${process.pid}\n`)
      setTimeout(() => writeFileSync(readyFile, '43210\n'), 0)
      return child
    }) as unknown as typeof spawn

    await expect(startLoopReplacement(readyFile, {
      packageRoot: root,
      onReady: (pid) => publishLoopReplacementPid(pidFile, process.pid, pid),
      spawn: spawnProcess,
      startupTimeoutMs: 1_000,
      stdio: 'ignore',
    })).resolves.toEqual({ ok: true, pid: 43210 })
    expect(readFileSync(pidFile, 'utf8')).toBe('43210\n')
    expect(child.unref).toHaveBeenCalled()
  })

  it('keeps the predecessor PID when the replacement exits before readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-restart-'))
    fixtureRoots.push(root)
    const pidFile = join(root, 'loop.pid')
    writeFileSync(pidFile, `${process.pid}\n`)
    const child = fakeChild(43211)
    const spawnProcess = vi.fn(() => {
      setTimeout(() => {
        Object.assign(child, { exitCode: 1 })
        child.emit('exit', 1, null)
      }, 0)
      return child
    }) as unknown as typeof spawn

    await expect(startLoopReplacement(join(root, 'ready'), {
      packageRoot: root,
      onReady: (pid) => publishLoopReplacementPid(pidFile, process.pid, pid),
      spawn: spawnProcess,
      startupTimeoutMs: 1_000,
      stdio: 'ignore',
    })).resolves.toEqual({
      ok: false,
      pid: 43211,
      error: 'replacement exited before becoming ready (exit code 1)',
    })
    expect(readFileSync(pidFile, 'utf8')).toBe(`${process.pid}\n`)
    expect(child.unref).not.toHaveBeenCalled()
  })

  it('uses the independent hidden-console launcher for a Windows replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-restart-'))
    fixtureRoots.push(root)
    const readyFile = join(root, 'ready')
    const outputFile = join(root, 'loop.log')
    const startWindowsProcess = vi.fn(async (options) => {
      expect(options.outputFile).toBe(outputFile)
      expect(options.env[LOOP_RESTART_READY_FILE_ENV]).toBe(readyFile)
      expect(options.env[LOOP_RESTART_PREDECESSOR_PID_ENV]).toBe(`${process.pid}`)
      setTimeout(() => writeFileSync(readyFile, '43212\n'), 0)
      return 43212
    })
    const os = {
      processIsAlive: vi.fn(() => true),
    } as unknown as OperatingSystem

    await expect(startLoopReplacement(readyFile, {
      operatingSystem: os,
      outputFile,
      packageRoot: root,
      platform: 'win32',
      startWindowsProcess,
      startupTimeoutMs: 1_000,
    })).resolves.toEqual({ ok: true, pid: 43212 })
    expect(startWindowsProcess).toHaveBeenCalledOnce()
  })

  it('signals the wrapper process as the Windows restart owner', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-restart-'))
    fixtureRoots.push(root)
    const readyFile = join(root, 'ready')

    signalLoopRestartReady({
      [LOOP_RESTART_READY_FILE_ENV]: readyFile,
      [WINDOWS_PROCESS_ROOT_PID_ENV]: '43213',
    })

    expect(readFileSync(readyFile, 'utf8')).toBe('43213\n')
  })
})
