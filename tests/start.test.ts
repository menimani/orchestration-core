import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Runner } from '../src/adapters/runner.ts'
import {
  branchName, logFile, orchPaths, statusFile, worktreeDir, type OrchPaths,
} from '../src/paths.ts'
import { startTask, worktreeAddArgs } from '../src/start.ts'
import { readStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'

let repoRoot: string
let paths: OrchPaths

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-start-'))
  paths = orchPaths(repoRoot)
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test'])
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'chore: initial commit'])
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('startTask', () => {
  it('uses quiet worktree creation so checkout progress stays out of daemon output', () => {
    expect(worktreeAddArgs('task-worktree', 'task/task-id')).toEqual([
      'worktree', 'add', '--quiet', 'task-worktree', '-b', 'task/task-id',
    ])
  })

  it('preserves a stale worktree and its unrecovered commits until explicit cleanup', async () => {
    const taskId = '20260809_000000_001_auto-stale-worktree'
    const worktree = worktreeDir(paths, taskId)
    writeFileSync(specFile(paths, taskId), '# stale worktree task\n')
    git(['worktree', 'add', '-q', worktree, '-b', branchName(taskId)])
    writeFileSync(join(worktree, 'recovered.txt'), 'runner work\n')
    execFileSync('git', ['add', 'recovered.txt'], { cwd: worktree, windowsHide: true })
    execFileSync('git', ['commit', '-qm', 'fix: preserve runner work'], {
      cwd: worktree, windowsHide: true,
    })
    const recoveredHead = git(['rev-parse', branchName(taskId)]).trim()
    writeFileSync(statusFile(paths, taskId), JSON.stringify({
      task_id: taskId, status: 'running', pid: null,
    }))
    const start = vi.fn(async () => process.pid)

    await expect(startTask(paths, { start }, taskId, { effort: 'medium' }))
      .rejects.toThrow('then run cleanup explicitly')

    expect(start).not.toHaveBeenCalled()
    expect(readFileSync(join(worktree, 'recovered.txt'), 'utf8')).toBe('runner work\n')
    expect(git(['rev-parse', branchName(taskId)]).trim()).toBe(recoveredHead)
    expect(readStatus(paths, taskId)?.status).toBe('running')
  })

  it('does not reclaim a worktree owned by a live process', async () => {
    const taskId = '20260809_000000_002_auto-live-worktree'
    const worktree = worktreeDir(paths, taskId)
    writeFileSync(specFile(paths, taskId), '# live worktree task\n')
    mkdirSync(worktree, { recursive: true })
    writeFileSync(join(worktree, 'owned.txt'), 'still running\n')
    writeFileSync(statusFile(paths, taskId), JSON.stringify({
      task_id: taskId, status: 'running', pid: process.pid,
    }))
    const start = vi.fn(async () => process.pid)

    await expect(startTask(paths, { start }, taskId, { effort: 'medium' }))
      .resolves.toEqual({ outcome: 'already-running' })

    expect(start).not.toHaveBeenCalled()
    expect(existsSync(join(worktree, 'owned.txt'))).toBe(true)
  })

  it('records and preserves a worktree setup failure before the runner starts', async () => {
    const taskId = '20260809_000000_001_scan'
    writeFileSync(specFile(paths, taskId), '# scan\n')
    const start = vi.fn(async () => process.pid)
    const runner: Runner = { start }
    const previousError = process.env['ORCH_TEST_SETUP_ERROR']
    process.env['ORCH_TEST_SETUP_ERROR'] = 'setup exploded'

    try {
      await expect(startTask(paths, runner, taskId, {
        effort: 'high',
        setup: [{
          label: 'Failing setup',
          cwd: '',
          command: 'node -e "process.stderr.write(process.env.ORCH_TEST_SETUP_ERROR); process.exit(1)"',
        }],
      })).rejects.toThrow()
    } finally {
      if (previousError === undefined) delete process.env['ORCH_TEST_SETUP_ERROR']
      else process.env['ORCH_TEST_SETUP_ERROR'] = previousError
    }

    expect(start).not.toHaveBeenCalled()
    expect(readStatus(paths, taskId)?.status).toBe('failed')
    expect(readFileSync(logFile(paths, taskId), 'utf8')).toContain('setup exploded')
  })
})
