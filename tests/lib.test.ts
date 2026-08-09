import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { descSlug, newTaskId, shortTaskId, taskIdForDesc } from '../src/ids.ts'
import {
  branchName, finalMessageFile, isInspectionTaskId, isReviewTaskId, isScanTaskId,
  orchPaths, statusFile, type OrchPaths,
} from '../src/paths.ts'
import { readStatus, transitionStatus, writeStatus } from '../src/status.ts'

let repoRoot: string
let paths: OrchPaths

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-lib-'))
  paths = orchPaths(repoRoot)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('status files', () => {
  it('round-trips task id, status and pid', async () => {
    await writeStatus(paths, 'task-alpha', 'running', 12345)
    const status = readStatus(paths, 'task-alpha')
    expect(status?.task_id).toBe('task-alpha')
    expect(status?.status).toBe('running')
    expect(status?.pid).toBe(12345)
  })

  it('stores an unset pid as null', async () => {
    await writeStatus(paths, 'task-nopid', 'completed')
    expect(readStatus(paths, 'task-nopid')?.pid).toBeNull()
  })

  it('preserves started_at across rewrites', async () => {
    await writeStatus(paths, 'task-repeat', 'running', 1)
    const first = readStatus(paths, 'task-repeat')?.started_at
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await writeStatus(paths, 'task-repeat', 'completed')
    expect(readStatus(paths, 'task-repeat')?.started_at).toBe(first)
  })

  it('makes a waiting writer block until the lock is released', async () => {
    await writeStatus(paths, 'task-locked', 'running', 1)
    const lockDir = join(paths.statusDir, '.task-locked.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'pid'), `${process.pid}\n`)

    let finished = false
    const writer = writeStatus(paths, 'task-locked', 'merged').then(() => { finished = true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(finished).toBe(false)
    expect(readStatus(paths, 'task-locked')?.status).toBe('running')

    rmSync(join(lockDir, 'pid'))
    rmSync(lockDir, { recursive: true })
    await writer
    expect(readStatus(paths, 'task-locked')?.status).toBe('merged')
  })

  it('reclaims a lock whose recorded owner is dead', async () => {
    const lockDir = join(paths.statusDir, '.task-stale.lock')
    mkdirSync(lockDir)
    // PID 1 on Windows and near-max PIDs generally are not spawnable by us; use a PID
    // from a process we started and already reaped so liveness is provably false.
    const { spawnSync } = await import('node:child_process')
    const dead = spawnSync('node', ['-e', 'process.exit(0)']).pid ?? 99999
    writeFileSync(join(lockDir, 'pid'), `${dead}\n`)
    await writeStatus(paths, 'task-stale', 'completed')
    expect(readStatus(paths, 'task-stale')?.status).toBe('completed')
  })

  it('reclaims an aged lock that never published a pid', async () => {
    const lockDir = join(paths.statusDir, '.task-pidless.lock')
    mkdirSync(lockDir)
    const past = (Date.now() - 60_000) / 1000
    utimesSync(lockDir, past, past)
    await writeStatus(paths, 'task-pidless', 'completed')
    expect(readStatus(paths, 'task-pidless')?.status).toBe('completed')
  })

  it('refuses a transition whose expected state is stale', async () => {
    await writeStatus(paths, 'task-cas', 'merged')
    expect(await transitionStatus(paths, 'task-cas', 'running', 'completed')).toBe(false)
    expect(readStatus(paths, 'task-cas')?.status).toBe('merged')
  })

  it('reads an absent status file as undefined', () => {
    expect(readStatus(paths, 'task-absent')).toBeUndefined()
  })

  it('derives the final message path from the log path', () => {
    expect(finalMessageFile(paths, 'task-alpha'))
      .toBe(join(paths.logsDir, 'task-alpha.final'))
  })
})

describe('task ids', () => {
  it.each([
    ['20260810_024957_030_scan', '030_scan'],
    ['20260810_024957_031_auto-redesign-looplog', '031_auto'],
    ['20260810_024957_005_user-add-export', '005_user'],
    ['20260810_024957_012_ci-fix-c4', '012_ci-fix'],
    ['20260810_024957_227_review-c4', '227_review'],
  ])('derives the run-local id from %s', (full, short) => {
    expect(shortTaskId(full)).toBe(short)
  })

  it('mints ids as timestamp, per-day sequence and name', () => {
    const now = new Date(2026, 7, 8, 9, 30, 5)
    expect(newTaskId(paths, 'auto-fix-something', now))
      .toBe('20260808_093005_001_auto-fix-something')
    expect(newTaskId(paths, 'user-second', now))
      .toBe('20260808_093005_002_user-second')
  })

  it('resets the sequence on a new day', () => {
    newTaskId(paths, 'a', new Date(2026, 7, 8, 9, 0, 0))
    const next = newTaskId(paths, 'b', new Date(2026, 7, 9, 9, 0, 0))
    expect(next).toBe('20260809_090000_001_b')
  })

  it('slugs descriptions to lowercase alphanumerics capped at 30', () => {
    expect(descSlug('Fix the Header LAYOUT (mobile)')).toBe('fix-the-header-layout-mobile')
    expect(descSlug('x'.repeat(50)).length).toBe(30)
  })

  it('resolves the same description to the existing task', () => {
    const first = taskIdForDesc(paths, 'auto', 'fix the flaky calendar test')
    writeFileSync(join(paths.tasksDir, `${first}.md`), '# spec\n')
    const second = taskIdForDesc(paths, 'auto', 'fix the flaky calendar test')
    expect(second).toBe(first)
  })

  it('mints a fresh id when the indexed spec is gone', () => {
    const first = taskIdForDesc(paths, 'auto', 'a finding whose spec was pruned')
    const second = taskIdForDesc(paths, 'auto', 'a finding whose spec was pruned')
    expect(second).not.toBe(first)
  })
})

describe('task id classes', () => {
  it('matches both scan id shapes', () => {
    expect(isScanTaskId('scan-20250101')).toBe(true)
    expect(isScanTaskId('20260808_093005_001_scan')).toBe(true)
    expect(isScanTaskId('20260808_093005_001_auto-fix')).toBe(false)
  })

  it('matches review ids', () => {
    expect(isReviewTaskId('20260808_093005_001_review-c2')).toBe(true)
    expect(isReviewTaskId('20260808_093005_001_auto-review-page')).toBe(false)
  })

  it('treats a delegated task with the inspect marker as inspection', () => {
    const id = '20260808_093005_001_user-report-only'
    expect(isInspectionTaskId(paths, id)).toBe(false)
    mkdirSync(join(paths.queueDir, 'inspect'), { recursive: true })
    writeFileSync(join(paths.queueDir, 'inspect', id), '')
    expect(isInspectionTaskId(paths, id)).toBe(true)
  })
})

describe('branch names', () => {
  it('prefixes task branches', () => {
    expect(branchName('20260808_093005_001_auto-fix')).toBe('task/20260808_093005_001_auto-fix')
  })

  it('places status files in the status directory', () => {
    expect(statusFile(paths, 'x')).toBe(join(paths.statusDir, 'x.json'))
  })
})
