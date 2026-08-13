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

  it('answers with the process it recorded', () => {
    recordTaskProcess(paths, taskId, 4321)

    expect(taskProcessPid(paths, taskId)).toBe(4321)
  })

  it('answers with nothing for a task it never recorded', () => {
    expect(taskProcessPid(paths, taskId)).toBeUndefined()
  })

  it('releases the process on stop', () => {
    recordTaskProcess(paths, taskId, 4321)

    forgetTaskProcess(paths, taskId)

    expect(taskProcessPid(paths, taskId)).toBeUndefined()
    expect(existsSync(registryFile())).toBe(false)
  })

  it('forgetting a task that was never recorded is not an error', () => {
    expect(() => forgetTaskProcess(paths, taskId)).not.toThrow()
  })

  it('releases a process recorded before this boot, and drops the entry as it reads', () => {
    recordTaskProcess(paths, taskId, 4321)
    // The operating system reassigns identifiers across a restart, so a number written
    // before the machine came up cannot name the process it was written for.
    const beforeBoot = new Date(Date.now() - 60 * 60 * 1000)
    utimesSync(registryFile(), beforeBoot, beforeBoot)
    const bootedAnHourAfterThat = (): number => Date.now() - 30 * 60 * 1000

    expect(taskProcessPid(paths, taskId, bootedAnHourAfterThat)).toBeUndefined()
    expect(existsSync(registryFile())).toBe(false)
  })

  it('keeps a process recorded after this boot', () => {
    recordTaskProcess(paths, taskId, 4321)
    const bootedAnHourAgo = (): number => Date.now() - 60 * 60 * 1000

    expect(taskProcessPid(paths, taskId, bootedAnHourAgo)).toBe(4321)
  })

  it('drops an entry that does not name a process', () => {
    recordTaskProcess(paths, taskId, 4321)
    writeFileSync(registryFile(), 'not-a-pid\n')

    expect(taskProcessPid(paths, taskId)).toBeUndefined()
    expect(existsSync(registryFile())).toBe(false)
  })

  it('derives the boot time from how long the system has been up', () => {
    const now = (): number => 1_000_000
    const upFiveMinutes = (): number => 300

    expect(bootedAt(now, upFiveMinutes)).toBe(1_000_000 - 300_000)
  })
})
