import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { win32 } from 'node:path'
import type { OperatingSystem } from './os.ts'

const PROCESS_EXIT_TIMEOUT_MS = 5_000
const PROCESS_EXIT_POLL_MS = 50

export interface WindowsOperatingSystemRuntime {
  spawn(command: string, args: readonly string[]): void
  probeProcess(pid: number): void
  remove(path: string, options: {
    force: true
    maxRetries?: 3
    recursive: true
  }): void
  now(): number
  sleep(milliseconds: number): void
}

const systemRuntime: WindowsOperatingSystemRuntime = {
  spawn: (command, args) => {
    spawnSync(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  },
  probeProcess: (pid) => {
    process.kill(pid, 0)
  },
  remove: rmSync,
  now: Date.now,
  sleep: (milliseconds) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  },
}

function extendedLengthPath(path: string): string {
  const absolutePath = win32.resolve(path)
  if (absolutePath.startsWith('\\\\?\\')) return absolutePath
  if (absolutePath.startsWith('\\\\')) return `\\\\?\\UNC\\${absolutePath.slice(2)}`
  return `\\\\?\\${absolutePath}`
}

function isAlive(runtime: WindowsOperatingSystemRuntime, pid: number): boolean {
  try {
    runtime.probeProcess(pid)
    return true
  } catch (error) {
    // A permission or other probe failure does not prove that the process stopped.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export function createOperatingSystem(
  runtime: WindowsOperatingSystemRuntime = systemRuntime,
): OperatingSystem {
  const processTreeIsAlive = (pid: number): boolean => isAlive(runtime, pid)

  return {
    processTreeIsAlive,
    terminateProcessTree(pid): boolean {
      if (!processTreeIsAlive(pid)) return false

      try {
        runtime.spawn('taskkill', ['/PID', String(pid), '/T', '/F'])
      } catch {
        // The command result is not authoritative: verify the process tree below.
      }

      const deadline = runtime.now() + PROCESS_EXIT_TIMEOUT_MS
      while (processTreeIsAlive(pid) && runtime.now() < deadline) {
        runtime.sleep(PROCESS_EXIT_POLL_MS)
      }
      if (processTreeIsAlive(pid)) throw new Error(`Could not stop process tree ${pid}.`)
      return true
    },
    removeDirectory(path): void {
      if (path.startsWith('\\\\?\\')) {
        runtime.remove(path, { recursive: true, force: true, maxRetries: 3 })
        return
      }
      try {
        runtime.remove(path, { recursive: true, force: true })
      } catch {
        runtime.remove(extendedLengthPath(path), { recursive: true, force: true })
      }
    },
    worktreePathFor(path) {
      return {
        comparisonKey: win32.resolve(path).toLowerCase(),
        removalPath: extendedLengthPath(path),
        removalFallback: 'Windows long-path fallback',
        holderHint: `Find holder: handle.exe "${path}" (Sysinternals)`,
      }
    },
  }
}
