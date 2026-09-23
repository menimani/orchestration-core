import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { orchPaths } from '../src/paths.ts'
import { recordInterruptedScans } from '../src/scanRecovery.ts'

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-scan-recovery-'))
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('recordInterruptedScans', () => {
  it.each([
    ['', 'positive integer'],
    ['0\n', 'positive integer'],
    ['not-a-cycle\n', 'positive integer'],
    ['9007199254740992\n', 'safe integer'],
  ])('rejects an invalid active cycle counter %j', (counter, expected) => {
    const paths = orchPaths(repoRoot)
    mkdirSync(paths.queueDir, { recursive: true })
    writeFileSync(join(paths.queueDir, 'scan-count.txt'), counter)

    expect(() => recordInterruptedScans(paths, [{
      taskId: '20260812_010203_040_scan',
      pid: 123,
    }])).toThrow(expected)
    expect(existsSync(join(paths.queueDir, 'stop-interrupted-scans'))).toBe(false)
  })

  it('rejects a missing active cycle counter', () => {
    const paths = orchPaths(repoRoot)
    mkdirSync(paths.queueDir, { recursive: true })

    expect(() => recordInterruptedScans(paths, [{
      taskId: '20260812_010203_040_scan',
      pid: 123,
    }])).toThrow('queue/scan-count.txt is missing')
    expect(existsSync(join(paths.queueDir, 'stop-interrupted-scans'))).toBe(false)
  })
})
