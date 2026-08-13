import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { operatingSystem } from '../src/adapters/os.ts'

const PROCESS_EXIT_TIMEOUT_MS = 5_000
const PROCESS_EXIT_POLL_MS = 10

interface TrackedProcess {
  child?: ChildProcess
  pid: () => number | undefined
  tree: boolean
}

/**
 * Child-process prelude that publishes when backlog-lock contention is observed and
 * keeps that retry from consuming its time budget until the fixture releases the lock.
 */
export function lockContentionProbeScript(lockArg: number, readyArg: number): string {
  return [
    "const { existsSync: probeLockExists, writeFileSync: publishLockContention } = await import('node:fs')",
    'const originalAtomicsWait = Atomics.wait',
    'const probeSleep = new Int32Array(new SharedArrayBuffer(4))',
    'Atomics.wait = function (...args) {',
    `  publishLockContention(process.argv[${readyArg}], '')`,
    `  while (probeLockExists(process.argv[${lockArg}])) {`,
    '    originalAtomicsWait(probeSleep, 0, 0, 10)',
    '  }',
    "  return 'timed-out'",
    '}',
  ].join('\n')
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
  while (operatingSystem.processIsAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`Test process ${pid} did not stop.`)
    await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS))
  }
}

/** Registers real child processes at spawn time for failure-safe afterEach cleanup. */
export class TestProcessRegistry {
  private readonly processes: TrackedProcess[] = []

  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    const child = spawn(command, args, options)
    this.processes.push({ child, pid: () => child.pid, tree: options.detached === true })
    return child
  }

  trackPid(pid: number | (() => number | undefined), options: { tree?: boolean } = {}): void {
    this.processes.push({
      pid: typeof pid === 'function' ? pid : () => pid,
      tree: options.tree === true,
    })
  }

  async cleanup(): Promise<void> {
    const processes = this.processes.splice(0).reverse()
    const cleanedPids = new Set<number>()
    for (const tracked of processes) {
      const pid = tracked.pid()
      if (pid === undefined || pid <= 0 || cleanedPids.has(pid)) continue
      cleanedPids.add(pid)
      if (tracked.child?.exitCode !== null && tracked.child?.exitCode !== undefined) continue

      if (tracked.tree) {
        if (operatingSystem.processTreeIsAlive(pid)) operatingSystem.terminateProcessTree(pid)
        continue
      }
      if (!operatingSystem.processIsAlive(pid)) continue

      if (tracked.child !== undefined) tracked.child.kill('SIGKILL')
      else {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          if (operatingSystem.processIsAlive(pid)) throw error
        }
      }
      await waitForExit(pid)
    }
  }
}
