import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shioraProject } from '../src/adapters/project-shiora.ts'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import {
  MergeError, mergeRemoteTask, mergeTask, removeMergedWorktree,
} from '../src/merge.ts'
import { branchName, orchPaths, worktreeDir, type OrchPaths } from '../src/paths.ts'
import { readStatus, writeStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'

let repoRoot: string
let paths: OrchPaths

const installProject: ProjectAdapter = {
  name: 'install-test',
  mergeChecks: () => [{
    label: 'Fixture check',
    cwd: '',
    command: 'node -e "console.error(\'check warning\'); console.log(\'check ran\')"',
    installWhenMissing: {
      path: 'dependency-ready',
      command: 'node -e "console.log(\'install ran\')"',
    },
  }],
  cycleSuite: () => [],
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function makeCompletedTask(taskId: string, options: { commit?: boolean; dirty?: boolean } = {}): Promise<string> {
  writeFileSync(specFile(paths, taskId), '# spec\n')
  const worktree = worktreeDir(paths, taskId)
  git(repoRoot, ['worktree', 'add', worktree, '-b', branchName(taskId)])
  if (options.commit === true) {
    writeFileSync(join(worktree, `${taskId}.txt`), 'work\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'feat: add task work'])
  }
  if (options.dirty === true) {
    writeFileSync(join(worktree, 'uncommitted.txt'), 'left behind\n')
  }
  await writeStatus(paths, taskId, 'completed')
  return worktree
}

beforeEach(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-merge-'))
  paths = orchPaths(repoRoot)
  git(repoRoot, ['init', '-q', '-b', 'main'])
  git(repoRoot, ['config', 'user.email', 'test@example.com'])
  git(repoRoot, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoRoot, 'README.md'), '# repo\n')
  git(repoRoot, ['add', '-A'])
  git(repoRoot, ['commit', '-qm', 'chore: initial commit'])
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(repoRoot, { recursive: true, force: true })
})

describe('removeMergedWorktree', () => {
  it('uses the Windows long-path fallback and prunes after git removal fails', () => {
    const worktree = worktreeDir(paths, '20260809_102500_100_auto-long-path')
    const remove = vi.fn()
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw Object.assign(new Error('git command failed'), {
          stderr: 'error: failed to delete: Filename too long\n',
        })
      }
      return ''
    })
    const log = vi.fn()

    removeMergedWorktree(paths, worktree, log, {
      platform: 'win32', remove, git: gitRuntime,
    })

    expect(remove).toHaveBeenCalledWith(
      `\\\\?\\${worktree.replaceAll('/', '\\')}`,
      { recursive: true, force: true, maxRetries: 3 },
    )
    expect(gitRuntime).toHaveBeenNthCalledWith(
      2, paths.repoRoot, ['worktree', 'prune'],
    )
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(
      `Worktree removal needed the Windows long-path fallback: ${worktree} (error: failed to delete: Filename too long)`,
    )
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('WARN:'))
  })

  it('prunes after direct removal succeeds on non-Windows platforms', () => {
    const worktree = worktreeDir(paths, '20260809_102500_100_auto-stale-registration')
    const remove = vi.fn()
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('Removal failed')
      return ''
    })
    const log = vi.fn()

    removeMergedWorktree(paths, worktree, log, {
      platform: 'linux', remove, git: gitRuntime,
    })

    expect(remove).toHaveBeenCalledWith(worktree, { recursive: true, force: true })
    expect(gitRuntime).toHaveBeenNthCalledWith(
      2, paths.repoRoot, ['worktree', 'prune'],
    )
    expect(log).toHaveBeenCalledWith(
      `Worktree removal needed the direct-removal fallback: ${worktree} (Removal failed)`,
    )
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('WARN:'))
  })

  it('keeps the existing warning when the Windows fallback also fails', () => {
    const worktree = worktreeDir(paths, '20260809_102500_100_auto-long-path')
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        throw Object.assign(new Error('git command failed'), {
          stderr: 'error: failed to delete: Filename too long\n',
        })
      }
      return ''
    })
    const log = vi.fn()

    removeMergedWorktree(paths, worktree, log, {
      platform: 'win32',
      remove: () => { throw new Error('Filename too long') },
      git: gitRuntime,
    })

    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(
      `WARN: merged, but the worktree is still there and has to go by hand: ${worktree} (error: failed to delete: Filename too long)`,
    )
    expect(gitRuntime).toHaveBeenNthCalledWith(
      2, paths.repoRoot, ['worktree', 'prune'],
    )
  })
})

describe('mergeTask', () => {
  it('merges a committed task, removes its worktree and branch, and records merged', async () => {
    const taskId = '20260808_000000_001_user-adds-a-file'
    const worktree = await makeCompletedTask(taskId, { commit: true })

    const mergeCommit = await mergeTask(
      paths, taskId, { taskGate: 'light', project: shioraProject },
    )

    expect(mergeCommit).toBe(git(repoRoot, ['rev-parse', 'HEAD']).trim())
    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(`Merge ${taskId} via Codex`)
    expect(existsSync(join(repoRoot, `${taskId}.txt`))).toBe(true)
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('stops on uncommitted changes and keeps the worktree', async () => {
    const taskId = '20260808_000000_002_user-forgot-commit'
    const worktree = await makeCompletedTask(taskId, { commit: true, dirty: true })
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: shioraProject }))
      .rejects.toThrow(/uncommitted changes/)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('stops a non-inspection task that produced no commits', async () => {
    const taskId = '20260808_000000_003_user-empty-handed'
    const worktree = await makeCompletedTask(taskId)
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: shioraProject }))
      .rejects.toThrow(/no new commits/)
    expect(existsSync(worktree)).toBe(true)
  })

  it('lets a scan through without commits', async () => {
    const taskId = '20260808_000000_004_scan'
    await makeCompletedTask(taskId)
    await mergeTask(paths, taskId, { taskGate: 'light', project: shioraProject })
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('refuses a task that is not completed', async () => {
    const taskId = '20260808_000000_005_user-still-going'
    await makeCompletedTask(taskId, { commit: true })
    await writeStatus(paths, taskId, 'running', process.pid)
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: shioraProject }))
      .rejects.toThrow(/not 'completed'/)
  })

  it('aborts the merge when the explicit test command fails', async () => {
    const taskId = '20260808_000000_006_user-tests-fail'
    await makeCompletedTask(taskId, { commit: true })
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: shioraProject, testCmd: 'node -e "process.exit(1)"' }))
      .rejects.toThrow(/Tests failed/)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('throws MergeError instances so callers can count merge failures', async () => {
    const taskId = '20260808_000000_007_user-error-type'
    await makeCompletedTask(taskId)
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: shioraProject }))
      .rejects.toBeInstanceOf(MergeError)
  })

  it('installs before a merge check when its dependency path is absent', async () => {
    const taskId = '20260808_000000_008_user-needs-install'
    await makeCompletedTask(taskId, { commit: true })
    const outputFile = join(repoRoot, 'merge-check.log')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
    })

    const output = readFileSync(outputFile, 'utf8')
    const outputLines = output.split(/\r?\n/)
    expect(outputLines.filter((line) => line === 'install ran')).toHaveLength(1)
    expect(outputLines.indexOf('install ran')).toBeLessThan(outputLines.indexOf('check ran'))
    expect(outputLines).toContain('check warning')
  })

  it('skips installation when the merge check dependency path is present', async () => {
    const taskId = '20260808_000000_009_user-has-dependency'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'dependency-ready'), 'ready\n')
    git(worktree, ['add', 'dependency-ready'])
    git(worktree, ['commit', '-qm', 'test: add dependency fixture'])
    const outputFile = join(repoRoot, 'merge-check.log')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
    })

    const output = readFileSync(outputFile, 'utf8')
    expect(output).not.toContain('install ran')
    expect(output.split(/\r?\n/).filter((line) => line === 'check ran')).toHaveLength(1)
  })
})

describe('mergeRemoteTask', () => {
  it('runs checks against the worker branch merged with the current branch', async () => {
    const branch = 'task/remote-combined-check'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    writeFileSync(join(repoRoot, 'run.txt'), 'newer run work\n')
    git(repoRoot, ['add', 'run.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add newer run work'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expect(mergeRemoteTask(paths, 220, branch, expectedHead, {
      taskGate: 'light',
      project: shioraProject,
      testCmd: 'node -e "const fs=require(\'node:fs\'); process.exit(fs.existsSync(\'run.txt\') && fs.existsSync(\'task.txt\') ? 1 : 0)"',
    })).rejects.toThrow(/Tests failed/)

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(join(repoRoot, 'run.txt'))).toBe(true)
    expect(existsSync(join(repoRoot, 'task.txt'))).toBe(false)
  })
})
