import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import {
  bootedAt, forgetTaskProcess, recordTaskProcess, taskProcessPid,
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

  it('drops a PID that now belongs to a different process', () => {
    recordTaskProcess(paths, taskId, 4321, identity)

    expect(taskProcessPid(paths, taskId, undefined, () => 'started:replacement'))
      .toBeUndefined()
    expect(existsSync(registryFile())).toBe(false)
  })

  it('drops a PID whose process-start identity cannot be verified', () => {
    recordTaskProcess(paths, taskId, 4321, identity)

    expect(taskProcessPid(paths, taskId, undefined, () => undefined)).toBeUndefined()
    expect(existsSync(registryFile())).toBe(false)
  })

  it('does not record a PID whose process-start identity cannot be read', () => {
    recordTaskProcess(paths, taskId, 4321, () => undefined)

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
