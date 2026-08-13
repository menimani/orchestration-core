import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { win32 } from 'node:path'
import type { OperatingSystem } from './os.ts'

const PROCESS_EXIT_TIMEOUT_MS = 5_000
const PROCESS_EXIT_POLL_MS = 50

export interface WindowsOperatingSystemRuntime {
  spawn(command: string, args: readonly string[]): void
  listProcesses(): readonly WindowsProcess[]
  probeProcess(pid: number): void
  remove(path: string, options: {
    force: true
    maxRetries?: 3
    recursive: true
  }): void
  now(): number
  sleep(milliseconds: number): void
}

export interface WindowsProcess {
  pid: number
  parentPid: number
}

const systemRuntime: WindowsOperatingSystemRuntime = {
  spawn: (command, args) => {
    spawnSync(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  },
  listProcesses: () => {
    // Measured on Windows (2026-08-13), five launches of the original full-property query
    // took 1,040 ms at the median. Selecting these two properties took 1,017 ms;
    // PowerShell startup dominates, so terminateProcessTree snapshots once and polls the
    // captured PIDs instead of launching this command again during its exit wait.
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { '{0},{1}' -f $_.ProcessId,$_.ParentProcessId }",
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error('Could not inspect the Windows process tree.')
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const match = /^(\d+),(\d+)$/.exec(line)
      if (match === null) throw new Error('Could not parse the Windows process tree.')
      return { pid: Number(match[1]), parentPid: Number(match[2]) }
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

function processTreePids(
  runtime: WindowsOperatingSystemRuntime,
  rootPid: number,
): ReadonlySet<number> | undefined {
  let processes: readonly WindowsProcess[]
  try {
    processes = runtime.listProcesses()
  } catch {
    // An inspection failure does not prove that the tree has stopped.
    return undefined
  }

  const runningPids = new Set(processes.map(({ pid }) => pid))
  const childrenByParent = new Map<number, number[]>()
  for (const { pid, parentPid } of processes) {
    const children = childrenByParent.get(parentPid) ?? []
    children.push(pid)
    childrenByParent.set(parentPid, children)
  }

  const treePids = new Set<number>()
  const visited = new Set<number>()
  const pending = [rootPid]
  while (pending.length > 0) {
    const pid = pending.pop()!
    if (visited.has(pid)) continue
    visited.add(pid)
    if (runningPids.has(pid)) treePids.add(pid)
    pending.push(...(childrenByParent.get(pid) ?? []))
  }
  return treePids
}

function anyProcessIsAlive(
  runtime: WindowsOperatingSystemRuntime,
  pids: ReadonlySet<number> | undefined,
): boolean {
  if (pids === undefined) return true
  return [...pids].some((pid) => isAlive(runtime, pid))
}

export function createOperatingSystem(
  runtime: WindowsOperatingSystemRuntime = systemRuntime,
): OperatingSystem {
  const processTreeIsAlive = (pid: number): boolean => (
    anyProcessIsAlive(runtime, processTreePids(runtime, pid))
  )

  return {
    processIsAlive: (pid) => isAlive(runtime, pid),
    processTreeIsAlive,
    terminateProcessTree(pid): boolean {
      const trackedPids = processTreePids(runtime, pid)
      if (!anyProcessIsAlive(runtime, trackedPids)) return false

      try {
        runtime.spawn('taskkill', ['/PID', String(pid), '/T', '/F'])
      } catch {
        // The command result is not authoritative: verify the process tree below.
      }

      const deadline = runtime.now() + PROCESS_EXIT_TIMEOUT_MS
      while (anyProcessIsAlive(runtime, trackedPids) && runtime.now() < deadline) {
        runtime.sleep(PROCESS_EXIT_POLL_MS)
      }
      if (anyProcessIsAlive(runtime, trackedPids)) {
        throw new Error(`Could not stop process tree ${pid}.`)
      }
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
