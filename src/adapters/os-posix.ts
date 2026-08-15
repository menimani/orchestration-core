import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { OperatingSystem } from './os.ts'

const PROCESS_EXIT_TIMEOUT_MS = 5_000
const PROCESS_EXIT_POLL_MS = 50

export interface PosixOperatingSystemRuntime {
  signalProcessGroup(processGroupId: number, signal?: NodeJS.Signals | number): void
  probeProcess(pid: number): void
  remove(path: string, options: { force: true; recursive: true }): void
  now(): number
  sleep(milliseconds: number): void
  /** Whether a group has a running member, or undefined where the host cannot say. */
  groupHasRunningMember(processGroupId: number): boolean | undefined
  processStartIdentity?(pid: number): string | undefined
  spawnDaemon?: typeof spawn
}

/**
 * A signal-0 probe answers for a zombie exactly as it does for a running process, so a
 * terminated leader waiting to be reaped reads as alive until its parent collects it.
 * `/proc` is the only place that distinguishes the two.
 */
function groupHasRunningMember(processGroupId: number): boolean | undefined {
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

const systemRuntime: PosixOperatingSystemRuntime = {
  signalProcessGroup: (processGroupId, signal) => {
    // Runners are detached, so their PID is also the process-group ID.
    process.kill(-processGroupId, signal)
  },
  probeProcess: (pid) => {
    process.kill(pid, 0)
  },
  remove: rmSync,
  now: Date.now,
  sleep: (milliseconds) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
  },
  groupHasRunningMember,
  processStartIdentity: (pid) => {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined
    }
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // `comm` may contain spaces and parentheses. starttime is field 22, or the
      // twentieth field after the final parenthesis.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const startTime = fields[19]
      if (/^\d+$/.test(startTime ?? '')) return `linux:${startTime}`
    } catch {
      // Hosts without procfs use the portable process listing below.
    }
    const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const startTime = result.status === 0 ? result.stdout.trim() : ''
    return startTime === '' ? undefined : `${process.platform}:${startTime}`
  },
}

function processIsAlive(runtime: PosixOperatingSystemRuntime, pid: number): boolean {
  try {
    runtime.probeProcess(pid)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function groupIsAlive(runtime: PosixOperatingSystemRuntime, pid: number): boolean {
  try {
    runtime.signalProcessGroup(pid, 0)
  } catch (error) {
    // A permission or other probe failure does not prove that the group stopped.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
  return runtime.groupHasRunningMember(pid) ?? true
}

export function createOperatingSystem(
  runtime: PosixOperatingSystemRuntime = systemRuntime,
): OperatingSystem {
  const processTreeIsAlive = (pid: number): boolean => groupIsAlive(runtime, pid)
  const terminateProcessTree = (pid: number): boolean => {
    if (!processTreeIsAlive(pid)) {
      if (processIsAlive(runtime, pid)) {
        throw new Error(`Process ${pid} is alive but its detached process group cannot be found.`)
      }
      return false
    }

    try {
      runtime.signalProcessGroup(pid)
    } catch {
      // The signal result is not authoritative: verify the process tree below.
    }

    const deadline = runtime.now() + PROCESS_EXIT_TIMEOUT_MS
    while (processTreeIsAlive(pid) && runtime.now() < deadline) {
      runtime.sleep(PROCESS_EXIT_POLL_MS)
    }
    if (processTreeIsAlive(pid)) throw new Error(`Could not stop process tree ${pid}.`)
    return true
  }

  return {
    async launchDaemon(options) {
      const output = openSync(options.outputFile, 'a')
      let child
      try {
        child = (runtime.spawnDaemon ?? spawn)(options.command, [...options.args], {
          cwd: options.cwd,
          detached: true,
          env: options.env,
          stdio: ['ignore', output, output],
          windowsHide: true,
        })
      } finally {
        closeSync(output)
      }
      const pid = child.pid
      if (pid === undefined) {
        child.kill()
        throw new Error('daemon process did not receive a PID')
      }
      return {
        pid,
        isAlive: () => child.exitCode === null,
        terminate: () => { terminateProcessTree(pid) },
        release: () => { child.unref() },
        onError: (listener) => { child.on('error', listener) },
        offError: (listener) => { child.off('error', listener) },
        onExit: (listener) => { child.on('exit', listener) },
        offExit: (listener) => { child.off('exit', listener) },
      }
    },
    processTreeRootPid: () => process.pid,
    processStartIdentity: runtime.processStartIdentity ?? systemRuntime.processStartIdentity!,
    processIsAlive: (pid) => processIsAlive(runtime, pid),
    processTreeIsAlive,
    terminateProcessTree,
    removeDirectory(path): void {
      runtime.remove(path, { recursive: true, force: true })
    },
    worktreePathFor(path) {
      const quoted = `'${path.replaceAll("'", "'\\''")}'`
      return {
        comparisonKey: resolve(path),
        removalPath: path,
        removalFallback: 'direct-removal fallback',
        holderHint: `Find holder: lsof +D -- ${quoted}`,
      }
    },
  }
}
