import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { operatingSystem } from '../src/adapters/os.ts'

export const PROCESS_TEST_TIMEOUT_MS = 30_000

const PROCESS_EXIT_TIMEOUT_MS = PROCESS_TEST_TIMEOUT_MS
const PROCESS_EXIT_POLL_MS = 10
const PARENT_EXIT_POLL_MS = 100

const fixtureStderr = new WeakMap<ChildProcess, string>()

interface FixtureProcessDescriptor {
  args: string[]
  command: string
}

/** What a wrapper publishes about the fixture it started, for the registry to stop. */
interface PublishedFixture {
  pid: number
  startIdentity?: string
}

interface TrackedProcess {
  child?: ChildProcess
  /** Where the wrapper publishes its fixture, when the fixture leaves the wrapper's tree. */
  fixturePublication?: string
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

/**
 * Describe a fixture child for a timeout message: whether it is still running, how it
 * exited, and what it has written to stderr so far.
 */
export function describeFixtureChild(child: ChildProcess): string {
  const state = child.exitCode === null && child.signalCode === null
    ? 'still running'
    : `exited with code ${child.exitCode} and signal ${child.signalCode}`
  return `${state}, stderr ${JSON.stringify(fixtureStderr.get(child) ?? '')}`
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
function runFixtureProcessWrapper(
  parentPid: number, encodedDescriptor: string, publication: string | undefined,
): void {
  const descriptor = JSON.parse(
    Buffer.from(encodedDescriptor, 'base64').toString('utf8'),
  ) as FixtureProcessDescriptor
  let fixture: ChildProcess | undefined
  let settled = false

  const stopFixture = (): void => {
    if (!settled && fixture?.pid !== undefined) {
      settled = true
      try {
        operatingSystem.terminateProcessTree(fixture.pid)
      } catch {
        // Exit regardless: the registry stops a published fixture itself and reports one
        // it cannot end. A fixture whose registry has exited as well goes unreported.
      }
    }
    process.exit(1)
  }

  // Where the fixture leads its own process group, a signal the registry sends to this
  // wrapper's group no longer reaches it, so the wrapper passes the stop on. The handlers
  // come first: from here on a stop waits for the event loop, so it cannot end this
  // wrapper between starting the fixture and publishing it.
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM'] as const) process.once(signal, stopFixture)

  // The adapter's own spawn options keep the fixture's tree reachable by the same
  // terminateProcessTree the core uses, so this cleanup inherits every fix made there.
  fixture = spawn(descriptor.command, descriptor.args, {
    ...operatingSystem.terminableSpawnOptions(),
    stdio: 'inherit',
    windowsHide: true,
  })
  if (publication !== undefined && fixture.pid !== undefined) {
    // This wrapper has not reaped the fixture yet, so the identity read is the fixture's.
    const published: PublishedFixture = {
      pid: fixture.pid,
      startIdentity: operatingSystem.processStartIdentity(fixture.pid),
    }
    // Renamed into place, so a reader never sees half a record.
    writeFileSync(`${publication}.tmp`, JSON.stringify(published))
    renameSync(`${publication}.tmp`, publication)
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

/**
 * Stop the fixture a wrapper published, through the adapter. Called once the wrapper is
 * gone, when the record can no longer change; a survivor makes terminateProcessTree throw.
 */
function stopPublishedFixture(publication: string): void {
  let published: PublishedFixture
  try {
    published = JSON.parse(readFileSync(publication, 'utf8')) as PublishedFixture
  } catch (error) {
    // A wrapper that never started its fixture published nothing.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (operatingSystem.processTreeIsAlive(published.pid, published.startIdentity)) {
    operatingSystem.terminateProcessTree(published.pid)
  }
}

/** Registers real child processes at spawn time for failure-safe afterEach cleanup. */
export class TestProcessRegistry {
  private readonly processes: TrackedProcess[] = []
  private publications: string | undefined

  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
    const descriptor: FixtureProcessDescriptor = { command, args: [...args] }
    const encodedDescriptor = Buffer.from(JSON.stringify(descriptor)).toString('base64')
    // Where the adapter detaches the fixture from the wrapper's tree, stopping that tree
    // does not reach the fixture, and the registry's kill of the wrapper can land before
    // the wrapper's own stop of the fixture does. The wrapper then publishes the fixture,
    // and cleanup stops it directly once the wrapper is gone. Waiting longer for the
    // wrapper instead would still miss a fixture whose wrapper died before stopping it.
    // Where the fixture stays in the wrapper's tree, stopping the tree ends it and reports
    // a survivor, so nothing is published.
    let fixturePublication: string | undefined
    if (operatingSystem.terminableSpawnOptions().detached) {
      this.publications ??= mkdtempSync(join(tmpdir(), 'orch-test-process-fixtures-'))
      fixturePublication = join(this.publications, `${this.processes.length}.json`)
    }
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url), '--fixture-process-wrapper',
      String(process.pid), encodedDescriptor,
      ...(fixturePublication === undefined ? [] : [fixturePublication]),
    ], {
      ...options,
      // A dedicated process group lets cleanup stop descendants, not only the immediate
      // fixture. It also keeps a failed Vitest worker from taking the watchdog with it.
      detached: true,
    })
    // A timeout report needs what the child printed even when nothing awaits its exit.
    fixtureStderr.set(child, '')
    child.stderr?.on('data', (chunk: Buffer) => {
      fixtureStderr.set(child, `${fixtureStderr.get(child) ?? ''}${chunk.toString()}`)
    })
    this.processes.push({ child, fixturePublication, pid: () => child.pid, tree: true })
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
    const publications = this.publications
    this.publications = undefined
    try {
      await this.cleanupProcesses(processes)
    } finally {
      if (publications !== undefined) rmSync(publications, { recursive: true, force: true })
    }
  }

  private async cleanupProcesses(processes: TrackedProcess[]): Promise<void> {
    const cleanedPids = new Set<number>()
    for (const tracked of processes) {
      const pid = tracked.pid()
      if (pid === undefined || pid <= 0 || cleanedPids.has(pid)) continue
      cleanedPids.add(pid)
      // The watchdog does not exit until its fixture has exited, so a reaped wrapper is
      // proof that it saw the fixture go or tried to stop it. A published fixture is
      // checked regardless, since the wrapper's stop may have failed or been cut short.
      const wrapperExited = tracked.child?.exitCode !== null && tracked.child?.exitCode !== undefined
      if (tracked.fixturePublication !== undefined) {
        if (!wrapperExited && operatingSystem.processTreeIsAlive(pid)) {
          operatingSystem.terminateProcessTree(pid)
        }
        stopPublishedFixture(tracked.fixturePublication)
        continue
      }
      if (wrapperExited) continue
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
    runFixtureProcessWrapper(parentPid, descriptor, process.argv[5])
  }
}
