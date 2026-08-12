import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

const PROCESS_EXIT_TIMEOUT_MS = 5_000
const PROCESS_EXIT_POLL_MS = 50

export interface ProcessTreeRuntime {
  platform: NodeJS.Platform
  spawn(command: string, args: readonly string[]): void
  kill(pid: number, signal?: NodeJS.Signals | number): void
  now(): number
  sleep(milliseconds: number): void
  /**
   * Whether any process in the group is running rather than merely existing, or
   * `undefined` where the platform cannot say.
   */
  groupHasRunningMember?(processGroupId: number): boolean | undefined
}

/**
 * A signal-0 probe answers for a zombie exactly as it does for a running process, so a
 * terminated leader waiting to be reaped reads as alive until its parent collects it —
 * long enough to spend the whole exit timeout and report a failure that already
 * succeeded. `/proc` is the only place that distinguishes the two.
 */
function linuxGroupHasRunningMember(processGroupId: number): boolean | undefined {
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return undefined
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let stat: string
    try {
      stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
    } catch {
      // The process exited between listing and reading; it is not a running member.
      continue
    }
    // `comm` is parenthesised and may contain spaces, so fields are counted from the
    // last ')': state is the first after it, process group the third.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const state = fields[0]
    const group = Number(fields[2])
    if (group === processGroupId && state !== 'Z') return true
  }
  return false
}

export const systemProcessTreeRuntime: ProcessTreeRuntime = {
  platform: process.platform,
  spawn: (command, args) => {
    spawnSync(command, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  },
  kill: (pid, signal) => {
    process.kill(pid, signal)
  },
  now: Date.now,
  sleep: (milliseconds) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  },
  groupHasRunningMember: (processGroupId) => (
    process.platform === 'linux' ? linuxGroupHasRunningMember(processGroupId) : undefined
  ),
}

function processTreeTarget(runtime: ProcessTreeRuntime, pid: number): number {
  // Runners are detached, so on POSIX their PID is also the process-group ID.
  return runtime.platform === 'win32' ? pid : -pid
}

export function processIsAlive(
  pid: number,
  runtime: ProcessTreeRuntime = systemProcessTreeRuntime,
): boolean {
  try {
    runtime.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export function processTreeIsAlive(
  pid: number,
  runtime: ProcessTreeRuntime = systemProcessTreeRuntime,
): boolean {
  try {
    runtime.kill(processTreeTarget(runtime, pid), 0)
  } catch (error) {
    // A permission or other probe failure does not prove that the process stopped.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }

  if (runtime.platform === 'win32') return true
  // The probe cannot tell a running member from one waiting to be reaped. Where the
  // platform can, believe it; where it cannot, keep the probe's answer.
  return runtime.groupHasRunningMember?.(pid) ?? true
}

/** Terminate a detached runner and every process in its tree. */
export function terminateProcessTree(
  pid: number,
  runtime: ProcessTreeRuntime = systemProcessTreeRuntime,
): boolean {
  const target = processTreeTarget(runtime, pid)
  if (!processTreeIsAlive(pid, runtime)) {
    if (runtime.platform !== 'win32' && processIsAlive(pid, runtime)) {
      throw new Error(`Process ${pid} is alive but its detached process group cannot be found.`)
    }
    return false
  }

  try {
    if (runtime.platform === 'win32') {
      runtime.spawn('taskkill', ['/PID', String(pid), '/T', '/F'])
    } else {
      runtime.kill(target)
    }
  } catch {
    // The command result is not authoritative: verify the process tree below.
  }

  const deadline = runtime.now() + PROCESS_EXIT_TIMEOUT_MS
  while (processTreeIsAlive(pid, runtime) && runtime.now() < deadline) {
    runtime.sleep(PROCESS_EXIT_POLL_MS)
  }
  if (processTreeIsAlive(pid, runtime)) {
    throw new Error(`Could not stop process tree ${pid}.`)
  }
  return true
}
