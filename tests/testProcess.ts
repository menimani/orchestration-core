import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { operatingSystem } from '../src/adapters/os.ts'

export const PROCESS_TEST_TIMEOUT_MS = 30_000

const PROCESS_EXIT_TIMEOUT_MS = PROCESS_TEST_TIMEOUT_MS
const PROCESS_EXIT_POLL_MS = 10
const PARENT_EXIT_POLL_MS = 100

interface FixtureProcessDescriptor {
  args: string[]
  command: string
}

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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Keep the fixture's process tree subordinate to the Vitest worker even when the worker
 * is terminated before afterEach can run. The wrapper is a detached process-group root;
 * it stays alive for the fixture's lifetime and tears the fixture down if its parent
 * disappears.
 */
function runFixtureProcessWrapper(parentPid: number, encodedDescriptor: string): void {
  const descriptor = JSON.parse(
    Buffer.from(encodedDescriptor, 'base64').toString('utf8'),
  ) as FixtureProcessDescriptor
  const fixture = spawn(descriptor.command, descriptor.args, {
    detached: false,
    stdio: 'inherit',
    windowsHide: true,
  })
  let settled = false

  const stopFixture = (): void => {
    if (settled) return
    settled = true
    if (process.platform === 'win32') {
      if (fixture.pid !== undefined) {
        spawnSync('taskkill', ['/PID', String(fixture.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      }
      process.exit(1)
    }
    try {
      process.kill(-process.pid, 'SIGKILL')
    } catch {
      process.exit(1)
    }
  }

  const parentMonitor = setInterval(() => {
    if (!processIsAlive(parentPid)) stopFixture()
  }, PARENT_EXIT_POLL_MS)
  parentMonitor.unref()
  fixture.once('error', () => {
    settled = true
    clearInterval(parentMonitor)
    process.exitCode = 1
  })
  fixture.once('exit', (code, signal) => {
    settled = true
    clearInterval(parentMonitor)
    process.exitCode = signal === null ? (code ?? 1) : 1
  })
}

/** Registers real child processes at spawn time for failure-safe afterEach cleanup. */
export class TestProcessRegistry {
  private readonly processes: TrackedProcess[] = []

  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    const descriptor: FixtureProcessDescriptor = { command, args: [...args] }
    const encodedDescriptor = Buffer.from(JSON.stringify(descriptor)).toString('base64')
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url), '--fixture-process-wrapper',
      String(process.pid), encodedDescriptor,
    ], {
      ...options,
      // A dedicated process group lets cleanup stop descendants, not only the immediate
      // fixture. It also keeps a failed Vitest worker from taking the watchdog with it.
      detached: true,
    })
    this.processes.push({ child, pid: () => child.pid, tree: true })
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
      // The watchdog does not exit until its fixture has exited, so a reaped wrapper is
      // proof that the whole fixture tree completed normally.
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

if (process.argv[2] === '--fixture-process-wrapper') {
  const parentPid = Number(process.argv[3])
  const descriptor = process.argv[4]
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || descriptor === undefined) {
    process.exitCode = 1
  } else {
    runFixtureProcessWrapper(parentPid, descriptor)
  }
}
