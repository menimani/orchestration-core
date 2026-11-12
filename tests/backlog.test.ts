import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dequeueBacklog, withBacklogLock } from '../src/backlog.ts'
import { operatingSystem } from '../src/adapters/os.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { specFile } from '../src/tasks.ts'
import { describeFixtureChild, lockContentionProbeScript, TestProcessRegistry } from './testProcess.ts'

let repoRoot: string
let paths: OrchPaths
const testProcesses = new TestProcessRegistry()

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-backlog-'))
  paths = orchPaths(repoRoot)
})

afterEach(async () => {
  await testProcesses.cleanup()
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})

function completion(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`child exited ${code}: ${stderr}`))
    })
  })
}

async function waitForFiles(files: string[], children: ChildProcess[]): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!files.every((file) => existsSync(file))) {
    if (Date.now() >= deadline) {
      const missing = files.flatMap((file, index) => existsSync(file)
        ? []
        : [`child ${index} (${describeFixtureChild(children[index]!)})`])
      throw new Error(`children did not reach the backlog mutation: ${missing.join('; ')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Replace the wall clock with one that only moves when a retry sleeps or a test advances it. */
function simulateClock(
  onSleep: (now: number) => void = () => undefined,
): { advance: (ms: number) => void, sleeps: () => number } {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const wait = vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
    now += timeout ?? 0
    onSleep(now)
    return 'timed-out'
  })
  return { advance: (ms) => { now += ms }, sleeps: () => wait.mock.calls.length }
}

describe('backlog process lock', () => {
  it.each([
    ['without owner metadata', undefined],
    ['with malformed owner metadata', `${process.pid}\n`],
  ])('reclaims an aged lock %s', (_description, owner) => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    if (owner !== undefined) writeFileSync(join(lockDir, 'owner'), owner)
    const old = new Date(Date.now() - 31_000)
    utimesSync(lockDir, old, old)

    expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
    expect(existsSync(lockDir)).toBe(false)
  })

  it('bounds acquisition when a live owner keeps the lock', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()}\n`)
    simulateClock()

    expect(() => withBacklogLock(backlog, () => undefined))
      .toThrow(`Timed out waiting for the backlog lock: ${backlog}`)
  })

  it('backs off against a live owner and still times out at the grace deadline', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()}\n`)
    const clock = simulateClock()
    const started = Date.now()

    expect(() => withBacklogLock(backlog, () => undefined))
      .toThrow(`Timed out waiting for the backlog lock: ${backlog}`)
    // One attempt precedes each sleep and one follows the last.
    expect(clock.sleeps() + 1).toBeLessThan(200)
    expect(Date.now() - started).toBe(30_000)
    expect(existsSync(lockDir)).toBe(true)
  })

  it('acquires a lock released shortly after the first attempt', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()}\n`)
    const started = Date.now()
    simulateClock((now) => {
      if (now - started >= 25) rmSync(lockDir, { recursive: true, force: true })
    })

    expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
    expect(Date.now() - started).toBeLessThanOrEqual(50)
    expect(existsSync(lockDir)).toBe(false)
  })

  it('bounds acquisition by elapsed time when identity lookups are slow', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    const identity = Buffer.from('owner-start').toString('base64url')
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()} v2.token.${identity}\n`)
    const clock = simulateClock()
    const started = Date.now()
    const lookup = vi.spyOn(operatingSystem, 'processStartIdentity').mockImplementation(() => {
      clock.advance(1_000)
      return 'owner-start'
    })

    expect(() => withBacklogLock(backlog, () => undefined))
      .toThrow(`Timed out waiting for the backlog lock: ${backlog}`)
    // Each attempt costs about two simulated seconds, so the wait ends near the
    // 30-second grace period instead of after thousands of attempts.
    expect(Date.now() - started).toBeLessThan(35_000)
    expect(lookup.mock.calls.length).toBeLessThan(40)
    expect(existsSync(lockDir)).toBe(true)
  })

  /** Record when each identity query for one of the given holder PIDs ran. */
  function recordHolderQueries(
    identities: (pid: number) => string | undefined,
  ): { at: Array<{ pid: number, now: number }> } {
    const queries = { at: [] as Array<{ pid: number, now: number }> }
    vi.spyOn(operatingSystem, 'processStartIdentity').mockImplementation((pid) => {
      if (pid === process.pid) return 'waiter-start'
      queries.at.push({ pid, now: Date.now() })
      return identities(pid)
    })
    return queries
  }

  const holderPid = 2_000_001
  const replacementPid = 2_000_002
  const encoded = (identity: string): string => Buffer.from(identity).toString('base64url')

  it('queries an unchanged live owner at most once per second while waiting', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    writeFileSync(
      join(lockDir, 'owner'),
      `${holderPid} ${Date.now()} v2.token.${encoded('holder-start')}\n`,
    )
    const clock = simulateClock()
    const started = Date.now()
    const queries = recordHolderQueries(() => 'holder-start')

    expect(() => withBacklogLock(backlog, () => undefined))
      .toThrow(`Timed out waiting for the backlog lock: ${backlog}`)
    expect(Date.now() - started).toBe(30_000)
    expect(clock.sleeps()).toBeGreaterThan(100)
    expect(queries.at.length).toBeLessThanOrEqual(31)
    for (let index = 1; index < queries.at.length; index += 1) {
      expect(queries.at[index]!.now - queries.at[index - 1]!.now).toBeGreaterThanOrEqual(1_000)
    }
    expect(existsSync(lockDir)).toBe(true)
  })

  it('reclaims a lock whose verified owner dies, from a fresh query after the grace period', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    const started = Date.now()
    writeFileSync(
      join(lockDir, 'owner'),
      `${holderPid} ${started - 20_000} v2.token.${encoded('holder-start')}\n`,
    )
    let holderAlive = true
    simulateClock((now) => {
      if (now - started >= 5_000) holderAlive = false
    })
    const queries = recordHolderQueries(() => holderAlive ? 'holder-start' : undefined)
    const processIsAlive = vi.spyOn(operatingSystem, 'processIsAlive')
      .mockImplementation(() => holderAlive)

    expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
    const reclaimedAt = Date.now() - started
    expect(reclaimedAt).toBeGreaterThanOrEqual(10_000)
    expect(reclaimedAt).toBeLessThan(10_500)
    expect(queries.at.at(-1)!.now - started).toBe(reclaimedAt)
    expect(processIsAlive).toHaveBeenCalledWith(holderPid)
    expect(existsSync(lockDir)).toBe(false)
  })

  it('verifies a changed owner record at once', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    const started = Date.now()
    writeFileSync(
      join(lockDir, 'owner'),
      `${holderPid} ${started} v2.first.${encoded('holder-start')}\n`,
    )
    let replacedAt: number | undefined
    simulateClock((now) => {
      if (replacedAt === undefined && now - started >= 100) {
        replacedAt = now
        writeFileSync(
          join(lockDir, 'owner'),
          `${replacementPid} ${now} v2.second.${encoded('replacement-start')}\n`,
        )
      }
    })
    const queries = recordHolderQueries((pid) => (
      pid === holderPid ? 'holder-start' : 'replacement-start'
    ))

    expect(() => withBacklogLock(backlog, () => undefined))
      .toThrow(`Timed out waiting for the backlog lock: ${backlog}`)
    const firstReplacementQuery = queries.at.find(({ pid }) => pid === replacementPid)
    expect(queries.at.filter(({ pid }) => pid === holderPid)).toHaveLength(1)
    expect(firstReplacementQuery?.now).toBe(replacedAt)
    expect(existsSync(lockDir)).toBe(true)
  })

  it('permits a later acquisition when released-lock removal fails', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    const removeDirectory = operatingSystem.removeDirectory.bind(operatingSystem)
    let removalFailed = false
    vi.spyOn(operatingSystem, 'removeDirectory').mockImplementation((path) => {
      if (!removalFailed && path.startsWith(`${lockDir}.released.`)) {
        removalFailed = true
        throw new Error('removal failed')
      }
      removeDirectory(path)
    })

    expect(withBacklogLock(backlog, () => 'first')).toBe('first')
    expect(removalFailed).toBe(true)
    expect(withBacklogLock(backlog, () => 'second')).toBe('second')
    expect(existsSync(lockDir)).toBe(false)
  })

  it('returns dequeued work and recovers when owned-lock release fails', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    writeFileSync(backlog, 'first-task:0\nsecond-task:0\n')
    const originalRename = fs.renameSync
    let releaseFailed = false
    fs.renameSync = function (source, destination) {
      if (!releaseFailed && source === lockDir) {
        releaseFailed = true
        const error = new Error('release failed') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return originalRename(source, destination)
    }
    syncBuiltinESMExports()

    try {
      expect(dequeueBacklog(backlog)).toBe('first-task:0')
      expect(releaseFailed).toBe(true)
      expect(dequeueBacklog(backlog)).toBe('second-task:0')
      expect(readFileSync(backlog, 'utf8')).toBe('')
      expect(existsSync(lockDir)).toBe(false)
    } finally {
      fs.renameSync = originalRename
      syncBuiltinESMExports()
    }
  })

  it('publishes failed lock release so another process can acquire it', async () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    const acquired = join(repoRoot, 'acquired-by-child')
    const originalRename = fs.renameSync
    let releaseFailed = false
    fs.renameSync = function (source, destination) {
      if (!releaseFailed && source === lockDir) {
        releaseFailed = true
        const error = new Error('release failed') as NodeJS.ErrnoException
        error.code = 'EPERM'
        throw error
      }
      return originalRename(source, destination)
    }
    syncBuiltinESMExports()

    try {
      expect(withBacklogLock(backlog, () => 'committed')).toBe('committed')
      expect(releaseFailed).toBe(true)
      expect(existsSync(join(lockDir, 'retired'))).toBe(true)

      const backlogModule = pathToFileURL(join(process.cwd(), 'src', 'backlog.ts')).href
      const child = testProcesses.spawn(process.execPath, [
        '--input-type=module', '--eval',
        [
          "import { writeFileSync } from 'node:fs'",
          `const { withBacklogLock } = await import(${JSON.stringify(backlogModule)})`,
          "withBacklogLock(process.argv[1], () => writeFileSync(process.argv[2], 'acquired\\n'))",
        ].join('\n'),
        backlog, acquired,
      ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })

      await completion(child)
      expect(readFileSync(acquired, 'utf8')).toBe('acquired\n')
      expect(existsSync(lockDir)).toBe(false)
    } finally {
      fs.renameSync = originalRename
      syncBuiltinESMExports()
    }
  })

  it('reclaims a lock when its live PID belongs to a different process start', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    writeFileSync(
      join(lockDir, 'owner'),
      `${process.pid} ${Date.now() - 31_000} v2.old-token.${Buffer.from('previous-start').toString('base64url')}\n`,
    )
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue('current-start')
    const processIsAlive = vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)

    expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
    expect(processIsAlive).not.toHaveBeenCalledWith(process.pid)
    expect(existsSync(lockDir)).toBe(false)
  })

  it('does not reclaim an aged lock with a live PID and malformed identity token', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    const encodedIdentity = Buffer.from('previous-start').toString('base64url')
    writeFileSync(
      join(lockDir, 'owner'),
      `${process.pid} ${Date.now() - 31_000} v2.old-token.${encodedIdentity}!\n`,
    )
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue('current-start')
    const processIsAlive = vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    simulateClock()

    expect(() => withBacklogLock(backlog, () => undefined))
      .toThrow(`Timed out waiting for the backlog lock: ${backlog}`)
    expect(processIsAlive).toHaveBeenCalledWith(process.pid)
    expect(existsSync(lockDir)).toBe(true)
  })

  it('recovers an aged recovery mutex abandoned beside a stale lock', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    const recoveryDir = `${lockDir}.recovery`
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `999999999 ${Date.now() - 31_000}\n`)
    mkdirSync(recoveryDir)
    const old = new Date(Date.now() - 31_000)
    utimesSync(recoveryDir, old, old)
    simulateClock()

    expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
    expect(existsSync(lockDir)).toBe(false)
    expect(existsSync(recoveryDir)).toBe(false)
  })

  it('serializes simultaneous recovery of one stale lock', async () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    const counter = join(repoRoot, 'mutation-count')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `999999999 ${Date.now() - 31_000}\n`)
    writeFileSync(counter, '0\n')

    const backlogModule = pathToFileURL(join(process.cwd(), 'src', 'backlog.ts')).href
    const script = [
      "import fs from 'node:fs'",
      "import { syncBuiltinESMExports } from 'node:module'",
      'const originalRmSync = fs.rmSync',
      'fs.rmSync = function (file, ...args) {',
      '  if (file === process.argv[2]) {',
      '    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)',
      '  }',
      '  return originalRmSync.call(this, file, ...args)',
      '}',
      'syncBuiltinESMExports()',
      `const { withBacklogLock } = await import(${JSON.stringify(backlogModule)})`,
      'withBacklogLock(process.argv[1], () => {',
      "  const value = Number(fs.readFileSync(process.argv[3], 'utf8'))",
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)',
      "  fs.writeFileSync(process.argv[3], `${value + 1}\\n`)",
      '})',
    ].join('\n')
    const children = Array.from({ length: 2 }, () => testProcesses.spawn(process.execPath, [
      '--input-type=module', '--eval', script, backlog, lockDir, counter,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }))

    await Promise.all(children.map(completion))

    expect(readFileSync(counter, 'utf8')).toBe('2\n')
    expect(existsSync(`${lockDir}.recovery`)).toBe(false)
  })

  it('serializes a dequeue rewrite with a concurrent enqueue', async () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    writeFileSync(backlog, 'first-task:0\n')
    writeFileSync(specFile(paths, 'second-task'), '# second task\n')

    // Hold the same lock as a process already between its backlog read and write.
    const lockDir = `${backlog}.lock`
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()}\n`)

    const backlogModule = pathToFileURL(join(process.cwd(), 'src', 'backlog.ts')).href
    const tasksModule = pathToFileURL(join(process.cwd(), 'src', 'tasks.ts')).href
    const pathsModule = pathToFileURL(join(process.cwd(), 'src', 'paths.ts')).href
    const dequeueReady = join(repoRoot, 'dequeue-ready')
    const enqueueReady = join(repoRoot, 'enqueue-ready')
    const dequeue = testProcesses.spawn(process.execPath, [
      '--input-type=module', '--eval',
      [
        lockContentionProbeScript(3, 2),
        `const { dequeueBacklog } = await import(${JSON.stringify(backlogModule)})`,
        'dequeueBacklog(process.argv[1])',
      ].join('\n'),
      backlog, dequeueReady, lockDir,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    const enqueue = testProcesses.spawn(process.execPath, [
      '--input-type=module', '--eval',
      [
        lockContentionProbeScript(3, 2),
        `const [{ enqueueTask }, { orchPaths }] = await Promise.all([import(${JSON.stringify(tasksModule)}), import(${JSON.stringify(pathsModule)})])`,
        "enqueueTask(orchPaths(process.argv[1]), 'second-task')",
      ].join('\n'),
      repoRoot, enqueueReady, lockDir,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    const completions = Promise.allSettled([completion(dequeue), completion(enqueue)])

    await waitForFiles([dequeueReady, enqueueReady], [dequeue, enqueue])
    expect(dequeue.exitCode).toBeNull()
    expect(enqueue.exitCode).toBeNull()
    expect(readFileSync(backlog, 'utf8')).toBe('first-task:0\n')

    rmSync(lockDir, { recursive: true })
    const results = await completions
    expect(results.filter((result) => result.status === 'rejected')).toEqual([])

    expect(readFileSync(backlog, 'utf8')).toBe('second-task:0\n')
  })
})

describe('backlog lock races', () => {
  const originals = { renameSync: fs.renameSync, writeFileSync: fs.writeFileSync }

  afterEach(() => {
    fs.renameSync = originals.renameSync
    fs.writeFileSync = originals.writeFileSync
    syncBuiltinESMExports()
  })

  /** Run every rename through `replacement`, which calls the real one when it should happen. */
  function interceptRename(replacement: (source: string, destination: string) => void): void {
    fs.renameSync = function (source, destination) {
      replacement(String(source), String(destination))
    }
    syncBuiltinESMExports()
  }

  /** Run every file write through `replacement` before the real write. */
  function interceptWrite(replacement: (file: string) => void): void {
    fs.writeFileSync = (file, ...args) => {
      replacement(String(file))
      originals.writeFileSync(file, ...args)
    }
    syncBuiltinESMExports()
  }

  function lostRaceError(code: string): NodeJS.ErrnoException {
    const error = new Error(`simulated ${code}`) as NodeJS.ErrnoException
    error.code = code
    return error
  }

  /** A lock, its recovery mutex, or a private remnant of either still beside the backlog. */
  function lockRemnants(backlog: string): string[] {
    const name = `${basename(backlog)}.lock`
    return fs.readdirSync(dirname(backlog)).filter((entry) => entry.startsWith(name))
  }

  function writeStaleOwner(dir: string): void {
    mkdirSync(dir)
    writeFileSync(join(dir, 'owner'), `999999999 ${Date.now() - 31_000}\n`)
  }

  function ownerOf(dir: string): string {
    return readFileSync(join(dir, 'owner'), 'utf8').trim()
  }

  it.each(['ENOENT', 'EPERM', 'EEXIST', 'ENOTEMPTY', 'EBUSY'])(
    'treats %s from restoring a displaced foreign lock as a lost race',
    (code) => {
      const backlog = join(paths.queueDir, 'backlog.txt')
      const lockDir = `${backlog}.lock`
      let restoreFailed = false
      interceptRename((source, destination) => {
        if (source === lockDir && destination.startsWith(`${lockDir}.released.`)) {
          // An older core replaced the lock just before this release displaced it.
          writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()} foreign-token\n`)
        }
        if (source.startsWith(`${lockDir}.released.`) && destination === lockDir) {
          restoreFailed = true
          throw lostRaceError(code)
        }
        originals.renameSync(source, destination)
      })

      expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
      expect(restoreFailed).toBe(true)
      expect(lockRemnants(backlog)).toEqual([])
    },
  )

  it('propagates an unexpected error from restoring a displaced foreign lock', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    interceptRename((source, destination) => {
      if (source === lockDir && destination.startsWith(`${lockDir}.released.`)) {
        writeFileSync(join(lockDir, 'owner'), `${process.pid} ${Date.now()} foreign-token\n`)
      }
      if (source.startsWith(`${lockDir}.released.`) && destination === lockDir) {
        throw lostRaceError('EIO')
      }
      originals.renameSync(source, destination)
    })

    expect(() => withBacklogLock(backlog, () => 'mutated')).toThrow('simulated EIO')
  })

  it('publishes the retired marker only after the release rename fails', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    const markedAtRename: boolean[] = []
    interceptRename((source, destination) => {
      if (source === lockDir) {
        markedAtRename.push(existsSync(join(lockDir, 'retired')))
        if (markedAtRename.length === 1) throw lostRaceError('EPERM')
      }
      originals.renameSync(source, destination)
    })

    expect(withBacklogLock(backlog, () => 'first')).toBe('first')
    expect(existsSync(join(lockDir, 'retired'))).toBe(true)
    expect(withBacklogLock(backlog, () => 'second')).toBe('second')
    // The failed release came first; the second acquisition then broke the retired lock.
    expect(markedAtRename.slice(0, 2)).toEqual([false, true])
    expect(lockRemnants(backlog)).toEqual([])
  })

  it('does not let a mutex holder displaced mid-recovery break the lock', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    const mutexDir = `${lockDir}.recovery`
    writeStaleOwner(mutexDir)
    writeStaleOwner(lockDir)
    simulateClock()
    const mutations: string[] = []
    let pending: { source: string, destination: string } | undefined
    let fencedStepFailed = false
    interceptRename((source, destination) => {
      if (
        source === mutexDir && pending === undefined
        && !destination.startsWith(`${mutexDir}.released.`)
      ) {
        // This acquisition observed the stale mutex. Before its rename, another process
        // recovers that mutex and a successor acquires it and starts breaking the lock.
        rmSync(mutexDir, { recursive: true })
        pending = { source, destination }
        withBacklogLock(backlog, () => {
          expect(ownerOf(lockDir)).toMatch(new RegExp(`^${process.pid} `))
          mutations.push('successor')
        })
        return
      }
      if (
        source === lockDir && pending !== undefined && !fencedStepFailed
        && destination.startsWith(join(mutexDir, 'fence.'))
      ) {
        // The rename observed earlier lands between the successor's verdict and its step.
        originals.renameSync(pending.source, pending.destination)
        try {
          originals.renameSync(source, destination)
        } catch (error) {
          fencedStepFailed = true
          throw error
        }
        throw new Error('a displaced mutex holder broke the lock')
      }
      originals.renameSync(source, destination)
    })

    expect(withBacklogLock(backlog, () => {
      expect(ownerOf(lockDir)).toMatch(new RegExp(`^${process.pid} `))
      mutations.push('displacer')
      return 'mutated'
    })).toBe('mutated')
    expect(fencedStepFailed).toBe(true)
    expect(mutations).toEqual(['successor', 'displacer'])
    expect(lockRemnants(backlog)).toEqual([])
  })

  it('tolerates a displaced mutex removed by another process', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const mutexDir = `${backlog}.lock.recovery`
    writeStaleOwner(mutexDir)
    simulateClock()
    let removedConcurrently = false
    interceptRename((source, destination) => {
      originals.renameSync(source, destination)
      if (
        source === mutexDir && !removedConcurrently
        && !destination.startsWith(`${mutexDir}.released.`)
      ) {
        rmSync(destination, { recursive: true })
        removedConcurrently = true
      }
    })

    expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
    expect(removedConcurrently).toBe(true)
    expect(lockRemnants(backlog)).toEqual([])
  })

  it('tolerates a released lock removed by another process', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const lockDir = `${backlog}.lock`
    let removedConcurrently = false
    interceptRename((source, destination) => {
      originals.renameSync(source, destination)
      if (source === lockDir && destination.startsWith(`${lockDir}.released.`)) {
        rmSync(destination, { recursive: true })
        removedConcurrently = true
      }
    })

    expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
    expect(removedConcurrently).toBe(true)
    expect(lockRemnants(backlog)).toEqual([])
  })

  it.each(['EPERM', 'EBUSY'])(
    'treats %s from removing a recovered mutex as a lost race',
    (code) => {
      const backlog = join(paths.queueDir, 'backlog.txt')
      const mutexDir = `${backlog}.lock.recovery`
      writeStaleOwner(mutexDir)
      simulateClock()
      const removeDirectory = operatingSystem.removeDirectory.bind(operatingSystem)
      let removalFailed = false
      vi.spyOn(operatingSystem, 'removeDirectory').mockImplementation((path) => {
        if (
          !removalFailed && path.startsWith(`${mutexDir}.`)
          && !path.startsWith(`${mutexDir}.released.`)
        ) {
          removalFailed = true
          throw lostRaceError(code)
        }
        removeDirectory(path)
      })

      expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
      expect(removalFailed).toBe(true)
      expect(existsSync(`${backlog}.lock`)).toBe(false)
      expect(existsSync(mutexDir)).toBe(false)
    },
  )

  it('propagates an unexpected error from removing a recovered mutex', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const mutexDir = `${backlog}.lock.recovery`
    writeStaleOwner(mutexDir)
    vi.spyOn(operatingSystem, 'removeDirectory').mockImplementation(() => {
      throw lostRaceError('EIO')
    })

    expect(() => withBacklogLock(backlog, () => 'mutated')).toThrow('simulated EIO')
  })

  it('retries when its new lock directory is displaced before the owner is published', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const mutexDir = `${backlog}.lock.recovery`
    simulateClock()
    let displaced = false
    interceptWrite((file) => {
      if (!displaced && file === join(mutexDir, 'owner')) {
        displaced = true
        rmSync(mutexDir, { recursive: true })
      }
    })

    expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
    expect(displaced).toBe(true)
    expect(lockRemnants(backlog)).toEqual([])
  })

  it('leaves a recreated name to the successor that published its owner first', () => {
    const backlog = join(paths.queueDir, 'backlog.txt')
    const mutexDir = `${backlog}.lock.recovery`
    const successorOwner = `${process.pid} ${Date.now()} successor-token`
    const successorHeldAtSleep: boolean[] = []
    simulateClock(() => {
      if (successorHeldAtSleep.length > 0) return
      successorHeldAtSleep.push(ownerOf(mutexDir) === successorOwner)
      rmSync(mutexDir, { recursive: true })
    })
    let recreated = false
    interceptWrite((file) => {
      if (!recreated && file === join(mutexDir, 'owner')) {
        // Another process displaced the new directory and a successor recreated the name.
        recreated = true
        rmSync(mutexDir, { recursive: true })
        mkdirSync(mutexDir)
        originals.writeFileSync(join(mutexDir, 'owner'), `${successorOwner}\n`)
      }
    })

    expect(withBacklogLock(backlog, () => 'mutated')).toBe('mutated')
    expect(recreated).toBe(true)
    expect(successorHeldAtSleep).toEqual([true])
    expect(lockRemnants(backlog)).toEqual([])
  })
})
