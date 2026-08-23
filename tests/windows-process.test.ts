import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
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
  terminateLauncherTree: ReturnType<typeof vi.fn>
} {
  const sleep = vi.fn(
    (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  )
  const terminateLauncherTree = vi.fn(() => true)
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
    terminateLauncherTree,
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
  expect(runtime.terminateLauncherTree).not.toHaveBeenCalled()
})

it('times out when the PID is never published and terminates the spawned tree', async () => {
  const runtime = testRuntime(() => {}, 20)

  await expect(startWindowsProcess(options, runtime)).rejects.toThrow(
    'never published a PID before startup timed out; startup cleanup found and terminated a live process tree',
  )
  expect(runtime.terminateLauncherTree).toHaveBeenCalledOnce()
})

it('rejects a malformed published PID immediately and terminates the spawned tree', async () => {
  const runtime = testRuntime((readyFile) => writeFileSync(readyFile, 'not-a-pid\n'), 10_000)

  await expect(startWindowsProcess(options, runtime)).rejects.toThrow(
    'published an invalid PID (not-a-pid); startup cleanup found and terminated a live process tree',
  )
  expect(runtime.sleep).not.toHaveBeenCalled()
  expect(runtime.terminateLauncherTree).toHaveBeenCalledOnce()
})
