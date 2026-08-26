import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  processTreeRootPid, quoteWindowsArgument, startWindowsProcess,
  WINDOWS_PROCESS_ROOT_PID_ENV, type WindowsProcessRuntime,
} from '../src/adapters/windows-process.ts'

// These are pure functions describing Windows conventions, so every platform runs them.
// The process-launching assertions that only Windows can make live in
// windows-console.test.ts, which vitest.config.ts collects on Windows alone.

describe('Windows process arguments', () => {
  it('quotes arguments according to the Windows argv parsing rules', () => {
    expect(quoteWindowsArgument('plain')).toBe('plain')
    expect(quoteWindowsArgument('')).toBe('""')
    expect(quoteWindowsArgument('two words')).toBe('"two words"')
    expect(quoteWindowsArgument('C:\\path with space\\')).toBe('"C:\\path with space\\\\"')
    expect(quoteWindowsArgument('say "hello"')).toBe('"say \\"hello\\""')
  })

  it('uses the wrapper PID only when it is a valid positive integer', () => {
    expect(processTreeRootPid({ [WINDOWS_PROCESS_ROOT_PID_ENV]: '43210' })).toBe(43210)
    expect(processTreeRootPid({ [WINDOWS_PROCESS_ROOT_PID_ENV]: '0' })).toBe(process.pid)
    expect(processTreeRootPid({ [WINDOWS_PROCESS_ROOT_PID_ENV]: 'not-a-pid' }))
      .toBe(process.pid)
  })
})

type Publication = (readyFile: string) => void

function testRuntime(
  publication: Publication,
  launchTimeoutMs = 100,
): WindowsProcessRuntime & {
  sleep: ReturnType<typeof vi.fn>
  requestLauncherTreeTermination: ReturnType<typeof vi.fn>
  removeDirectory: ReturnType<typeof vi.fn>
} {
  const sleep = vi.fn(
    (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  )
  const alive = new Set([43210])
  const requestLauncherTreeTermination = vi.fn(() => {
    alive.clear()
    return true
  })
  const removeDirectory = vi.fn((path: string) => rmSync(path, { recursive: true, force: true }))
  return {
    platform: 'win32',
    now: Date.now,
    sleep,
    spawnLauncher: (_command: string, _args: readonly string[], options: SpawnOptions) => {
      const errorFile = options.env?.ORCHESTRATION_WINDOWS_LAUNCH_ERROR_FILE
      if (typeof errorFile !== 'string') throw new Error('Launcher error file was not provided')
      const descriptor = JSON.parse(
        readFileSync(join(dirname(errorFile), 'descriptor.json'), 'utf8'),
      ) as { readyFile: string }
      publication(descriptor.readyFile)
      const launcher = Object.assign(new EventEmitter(), {
        pid: 43210,
        kill: vi.fn(() => true),
        unref: vi.fn(),
      }) as unknown as ChildProcess
      return launcher
    },
    listProcesses: () => [{ pid: 43210, parentPid: 1 }],
    probeProcess: (pid) => {
      if (!alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    },
    requestLauncherTreeTermination,
    removeDirectory,
    launchTimeoutMs,
    launchPollMs: 5,
  }
}

const options = {
  args: ['scan'],
  command: 'worker.exe',
  cwd: process.cwd(),
  outputFile: join(process.cwd(), 'unused-windows-process-test.log'),
}

it('waits for an empty PID file to finish publishing', async () => {
  const runtime = testRuntime((readyFile) => {
    writeFileSync(readyFile, '')
    setTimeout(() => writeFileSync(readyFile, '43211\n'), 20)
  })

  await expect(startWindowsProcess(options, runtime)).resolves.toBe(43211)
  expect(runtime.requestLauncherTreeTermination).not.toHaveBeenCalled()
})

it('times out when the PID is never published and terminates the spawned tree', async () => {
  const runtime = testRuntime(() => {}, 20)

  await expect(startWindowsProcess(options, runtime)).rejects.toThrow(
    'never published a PID before startup timed out; startup cleanup found and terminated a live process tree',
  )
  expect(runtime.requestLauncherTreeTermination).toHaveBeenCalledOnce()
})

it('rejects a malformed published PID immediately and terminates the spawned tree', async () => {
  const runtime = testRuntime((readyFile) => writeFileSync(readyFile, 'not-a-pid\n'), 10_000)

  await expect(startWindowsProcess(options, runtime)).rejects.toThrow(
    'published an invalid PID (not-a-pid); startup cleanup found and terminated a live process tree',
  )
  expect(runtime.sleep).not.toHaveBeenCalled()
  expect(runtime.requestLauncherTreeTermination).toHaveBeenCalledOnce()
})

it('rejects cleanup while any captured startup descendant remains alive', async () => {
  const runtime = testRuntime(() => {}, 20)
  const alive = new Set([43210, 43211])
  let now = 0
  runtime.listProcesses = () => [
    { pid: 43210, parentPid: 1 },
    { pid: 43211, parentPid: 43210 },
  ]
  runtime.probeProcess = (pid) => {
    if (!alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
  }
  runtime.requestLauncherTreeTermination = vi.fn(() => {
    alive.delete(43210)
    return true
  })
  runtime.now = () => now
  runtime.sleep = vi.fn(async (milliseconds: number) => { now += milliseconds })

  await expect(startWindowsProcess(options, runtime)).rejects.toThrow(
    'Could not stop Windows startup process tree 43210.',
  )
  expect(runtime.requestLauncherTreeTermination).toHaveBeenCalledOnce()
  expect(runtime.removeDirectory).not.toHaveBeenCalled()
  expect(runtime.sleep).toHaveBeenCalled()
})

it('verifies cleanup directly when startup process enumeration fails', async () => {
  const runtime = testRuntime(() => {}, 20)
  runtime.listProcesses = () => { throw new Error('process enumeration failed') }

  await expect(startWindowsProcess(options, runtime)).rejects.toThrow(
    'never published a PID before startup timed out; startup cleanup found and terminated a live process tree',
  )
  expect(runtime.requestLauncherTreeTermination).toHaveBeenCalledOnce()
  expect(runtime.removeDirectory).toHaveBeenCalledOnce()
})

it('retains startup state when direct cleanup verification cannot prove the launcher stopped', async () => {
  const runtime = testRuntime(() => {}, 20)
  let now = 0
  runtime.listProcesses = () => { throw new Error('process enumeration failed') }
  runtime.requestLauncherTreeTermination = vi.fn(() => true)
  runtime.now = () => now
  runtime.sleep = vi.fn(async (milliseconds: number) => { now += milliseconds })

  await expect(startWindowsProcess(options, runtime)).rejects.toThrow(
    /Could not stop Windows startup process tree 43210\. Startup state was retained at .+\./,
  )
  expect(runtime.requestLauncherTreeTermination).toHaveBeenCalledOnce()
  expect(runtime.removeDirectory).not.toHaveBeenCalled()
})

it('returns the published PID when temporary-directory cleanup fails', async () => {
  const runtime = testRuntime((readyFile) => writeFileSync(readyFile, '43211\n'))
  runtime.removeDirectory = vi.fn((path: string) => {
    rmSync(path, { recursive: true, force: true })
    throw new Error('temporary directory is locked')
  })

  await expect(startWindowsProcess(options, runtime)).resolves.toBe(43211)
  expect(runtime.removeDirectory).toHaveBeenCalledOnce()
  expect(runtime.requestLauncherTreeTermination).not.toHaveBeenCalled()
})
