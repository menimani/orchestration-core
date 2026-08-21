import { spawnSync } from 'node:child_process'
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { orchPaths, statusFile } from '../src/paths.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, '..', 'src', 'cli.ts')

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-status-'))
  expect(spawnSync('git', ['init'], { cwd: repoRoot, windowsHide: true }).status).toBe(0)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('status command', () => {
  it('lists a legacy merged status without adding current merge metadata', () => {
    const taskId = '20260802_170600_021_auto-legacy-merged'
    const file = statusFile(orchPaths(repoRoot), taskId)
    const legacyRecord = `${JSON.stringify({
      task_id: taskId,
      status: 'merged',
      started_at: '2026-08-02T08:06:00Z',
      updated_at: '2026-08-02T09:06:00Z',
      worktree: join(repoRoot, 'orchestration', 'worktrees', taskId),
      branch: `task/${taskId}`,
    }, null, 2)}\n`
    writeFileSync(file, legacyRecord)

    const listing = spawnSync(process.execPath, [CLI, 'status', '--repo', repoRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    })
    const loopStatus = spawnSync(process.execPath, [CLI, 'loop-status', '--repo', repoRoot], {
      cwd: repoRoot,
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(listing.status, listing.stderr).toBe(0)
    expect(listing.stdout).toContain(taskId)
    expect(listing.stdout).toContain('merged')
    expect(loopStatus.status, loopStatus.stderr).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(legacyRecord)
  })
})
