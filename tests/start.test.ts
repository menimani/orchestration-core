import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Runner } from '../src/adapters/runner.ts'
import { logFile, orchPaths, type OrchPaths } from '../src/paths.ts'
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
