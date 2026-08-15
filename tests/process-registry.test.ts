import {
  existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import {
  bootedAt, forgetTaskProcess, recordTaskProcess, taskProcessPid, terminableTaskProcessPid,
} from '../src/processRegistry.ts'

describe('task process registry', () => {
  let repoRoot = ''
  let paths: OrchPaths
  const taskId = '20260813_120000_001_auto-registry'

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'orch process-registry-'))
    paths = orchPaths(repoRoot)
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  const registryFile = (): string => join(paths.queueDir, 'pids', taskId)
  const identity = (pid: number): string => `started:${pid}`

  it('answers with the process it recorded', () => {
    recordTaskProcess(paths, taskId, 4321, identity)

    expect(taskProcessPid(paths, taskId, undefined, identity)).toBe(4321)
  })

  it('answers with nothing for a task it never recorded', () => {
    expect(taskProcessPid(paths, taskId)).toBeUndefined()
  })

  it('releases the process on stop', () => {
    recordTaskProcess(paths, taskId, 4321, identity)

    forgetTaskProcess(paths, taskId)

    expect(taskProcessPid(paths, taskId)).toBeUndefined()
    expect(existsSync(registryFile())).toBe(false)
  })

  it('forgetting a task that was never recorded is not an error', () => {
    expect(() => forgetTaskProcess(paths, taskId)).not.toThrow()
  })

  it('releases a process recorded before this boot, and drops the entry as it reads', () => {
    recordTaskProcess(paths, taskId, 4321, identity)
    // The operating system reassigns identifiers across a restart, so a number written
    // before the machine came up cannot name the process it was written for.
    const beforeBoot = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(registryFile(), beforeBoot, beforeBoot)
    const bootedAnHourAfterThat = (): number => Date.now() - 30 * 60 * 1000

    expect(taskProcessPid(paths, taskId, bootedAnHourAfterThat, identity)).toBeUndefined()
    expect(existsSync(registryFile())).toBe(false)
  })

  it('keeps a process recorded after this boot', () => {
    recordTaskProcess(paths, taskId, 4321, identity)
    const bootedAnHourAgo = (): number => Date.now() - 60 * 60 * 1000

    expect(taskProcessPid(paths, taskId, bootedAnHourAgo, identity)).toBe(4321)
  })

  it('keeps an unavailable probe but drops a later confirmed identity mismatch', () => {
    recordTaskProcess(paths, taskId, 4321, identity)

    expect(taskProcessPid(paths, taskId, undefined, () => undefined, () => true)).toBe(4321)
    expect(existsSync(registryFile())).toBe(true)
    expect(taskProcessPid(paths, taskId, undefined, () => 'started:replacement'))
      .toBeUndefined()
    expect(existsSync(registryFile())).toBe(false)
  })

  it('keeps ownership when the identity probe is unavailable, then verifies on recovery', () => {
    recordTaskProcess(paths, taskId, 4321, identity)

    expect(taskProcessPid(paths, taskId, undefined, () => undefined, () => true)).toBe(4321)
    expect(existsSync(registryFile())).toBe(true)
    expect(terminableTaskProcessPid(
      paths, taskId, undefined, () => undefined, () => true,
    )).toBeUndefined()
    expect(taskProcessPid(paths, taskId, undefined, identity, () => true)).toBe(4321)
    expect(existsSync(registryFile())).toBe(true)
  })

  it('never adopts a recovered identity for ownership that was unverified at launch', () => {
    recordTaskProcess(paths, taskId, 4321, () => undefined, () => true)

    expect(existsSync(registryFile())).toBe(true)
    expect(taskProcessPid(paths, taskId, undefined, identity, () => true)).toBe(4321)
    expect(JSON.parse(readFileSync(registryFile(), 'utf8'))).toEqual({
      pid: 4321, startIdentity: null,
    })
    expect(terminableTaskProcessPid(paths, taskId, undefined, identity, () => true))
      .toBeUndefined()
  })

  it('drops unverifiable ownership only when the process is confirmed gone', () => {
    recordTaskProcess(paths, taskId, 4321, identity)

    expect(taskProcessPid(paths, taskId, undefined, () => undefined, () => false))
      .toBeUndefined()
    expect(existsSync(registryFile())).toBe(false)
  })

  it('drops a legacy bare-PID entry because it has no process-start identity', () => {
    recordTaskProcess(paths, taskId, 4321, identity)
    writeFileSync(registryFile(), '4321\n')

    expect(taskProcessPid(paths, taskId, undefined, identity)).toBeUndefined()
    expect(existsSync(registryFile())).toBe(false)
  })

  it('drops an entry that does not name a process', () => {
    recordTaskProcess(paths, taskId, 4321, identity)
    writeFileSync(registryFile(), 'not-a-pid\n')

    expect(taskProcessPid(paths, taskId)).toBeUndefined()
    expect(existsSync(registryFile())).toBe(false)
  })

  it('drops a JSON entry that is not a registry object', () => {
    recordTaskProcess(paths, taskId, 4321, identity)
    writeFileSync(registryFile(), 'null\n')

    expect(taskProcessPid(paths, taskId, undefined, identity)).toBeUndefined()
    expect(existsSync(registryFile())).toBe(false)
  })

  it('derives the boot time from how long the system has been up', () => {
    const now = (): number => 1_000_000
    const upFiveMinutes = (): number => 300

    expect(bootedAt(now, upFiveMinutes)).toBe(1_000_000 - 300_000)
  })
})
