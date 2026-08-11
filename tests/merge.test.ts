import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import {
  MergeError, mergeRemoteTask, mergeTask, removeMergedWorktree,
} from '../src/merge.ts'
import { branchName, orchPaths, worktreeDir, type OrchPaths } from '../src/paths.ts'
import { readStatus, writeStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'
import { stubProject } from './stubProject.ts'

let repoRoot: string
let paths: OrchPaths

const installProject: ProjectAdapter = {
  ...stubProject,
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

const noCheckProject: ProjectAdapter = {
  ...stubProject,
  name: 'no-check',
  mergeChecks: () => [],
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
  it('uses the Windows UNC namespace for a UNC worktree fallback', () => {
    const worktree = '\\\\server\\share\\orchestration\\worktrees\\task'
    const remove = vi.fn()
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('Removal failed')
      return ''
    })

    removeMergedWorktree(paths, worktree, vi.fn(), {
      platform: 'win32', remove, git: gitRuntime,
    })

    expect(remove).toHaveBeenCalledWith(
      '\\\\?\\UNC\\server\\share\\orchestration\\worktrees\\task',
      { recursive: true, force: true, maxRetries: 3 },
    )
  })

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
      paths, taskId, { taskGate: 'light', project: stubProject },
    )

    expect(mergeCommit).toBe(git(repoRoot, ['rev-parse', 'HEAD']).trim())
    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via orchestration`,
    )
    expect(existsSync(join(repoRoot, `${taskId}.txt`))).toBe(true)
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('leaves linked-issue closing syntax to the forge adapter', async () => {
    const taskId = '20260808_000000_015_user-linked-issue'
    await makeCompletedTask(taskId, { commit: true })

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: stubProject,
      closesIssue: 317,
      forge: {
        issueClosingCommitMessage: (message, issueNumber) =>
          `${message} (resolves ticket ${issueNumber})`,
      },
    })

    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via orchestration (resolves ticket 317)`,
    )
  })

  it('stops on uncommitted changes and keeps the worktree', async () => {
    const taskId = '20260808_000000_002_user-forgot-commit'
    const worktree = await makeCompletedTask(taskId, { commit: true, dirty: true })
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .rejects.toThrow(/uncommitted changes/)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('stops a non-inspection task that produced no commits', async () => {
    const taskId = '20260808_000000_003_user-empty-handed'
    const worktree = await makeCompletedTask(taskId)
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .rejects.toThrow(/no new commits/)
    expect(existsSync(worktree)).toBe(true)
  })

  it('lets a scan through without commits', async () => {
    const taskId = '20260808_000000_004_scan'
    await makeCompletedTask(taskId)
    await mergeTask(paths, taskId, { taskGate: 'light', project: stubProject })
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('refuses a task that is not completed', async () => {
    const taskId = '20260808_000000_005_user-still-going'
    await makeCompletedTask(taskId, { commit: true })
    await writeStatus(paths, taskId, 'running', process.pid)
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .rejects.toThrow(/not 'completed'/)
  })

  it('aborts the merge when the explicit test command fails', async () => {
    const taskId = '20260808_000000_006_user-tests-fail'
    await makeCompletedTask(taskId, { commit: true })
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject, testCmd: 'node -e "process.exit(1)"' }))
      .rejects.toThrow(/Tests failed/)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('runs checks against the task merged with intervening run-branch commits', async () => {
    const taskId = '20260808_000000_014_user-combined-check'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(repoRoot, 'run.txt'), 'newer run work\n')
    git(repoRoot, ['add', 'run.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add newer run work'])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'full',
      project: stubProject,
      testCmd: 'node -e "const fs=require(\'node:fs\'); process.exit(fs.existsSync(\'run.txt\') && fs.existsSync(\'20260808_000000_014_user-combined-check.txt\') ? 1 : 0)"',
    })).rejects.toThrow(/Tests failed/)

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(join(repoRoot, `${taskId}.txt`))).toBe(false)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('throws MergeError instances so callers can count merge failures', async () => {
    const taskId = '20260808_000000_007_user-error-type'
    await makeCompletedTask(taskId)
    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
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

  it('installs orchestration dependencies once when the merge changes package.json', async () => {
    const taskId = '20260808_000000_010_user-adds-orchestration-dependency'
    const worktree = await makeCompletedTask(taskId)
    mkdirSync(join(worktree, 'orchestration', 'ts'), { recursive: true })
    writeFileSync(join(worktree, 'orchestration', 'ts', 'package.json'), '{"dependencies":{}}\n')
    git(worktree, ['add', 'orchestration/ts/package.json'])
    git(worktree, ['commit', '-qm', 'feat: add orchestration dependency'])
    const install = vi.fn()
    const event = vi.fn()

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: { install, packageRoot: join(repoRoot, 'orchestration', 'ts') },
      onOrchestrationDepsEvent: event,
    })

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(join(repoRoot, 'orchestration', 'ts'))
    expect(event).toHaveBeenCalledWith(
      'Installed', ' orchestration deps  after 010_user',
    )
  })

  it('installs orchestration dependencies when the package is at the repository root', async () => {
    const taskId = '20260808_000000_013_user-updates-root-dependency'
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(join(worktree, 'package.json'), '{"dependencies":{}}\n')
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'fix: update root dependency'])
    const install = vi.fn()

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: { install, packageRoot: repoRoot },
    })

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(repoRoot)
  })

  it('does not install orchestration dependencies when the merge leaves manifests unchanged', async () => {
    const taskId = '20260808_000000_011_user-changes-source'
    await makeCompletedTask(taskId, { commit: true })
    const install = vi.fn()

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: { install, packageRoot: join(repoRoot, 'orchestration', 'ts') },
    })

    expect(install).not.toHaveBeenCalled()
  })

  it('warns without failing the merge when orchestration dependency installation fails', async () => {
    const taskId = '20260808_000000_012_user-adds-broken-dependency'
    const worktree = await makeCompletedTask(taskId)
    mkdirSync(join(worktree, 'orchestration', 'ts'), { recursive: true })
    writeFileSync(join(worktree, 'orchestration', 'ts', 'package-lock.json'), '{}\n')
    git(worktree, ['add', 'orchestration/ts/package-lock.json'])
    git(worktree, ['commit', '-qm', 'feat: update orchestration lockfile'])
    const event = vi.fn()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: {
        install: () => { throw new Error('registry unavailable') },
        packageRoot: join(repoRoot, 'orchestration', 'ts'),
      },
      onOrchestrationDepsEvent: event,
    })).resolves.toBe(git(repoRoot, ['rev-parse', 'HEAD']).trim())

    expect(event).toHaveBeenCalledWith(
      'WARN', expect.stringContaining('registry unavailable'),
    )
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })
})

describe('mergeRemoteTask', () => {
  it('leaves issue-closing syntax to the forge adapter', async () => {
    const branch = 'task/remote-runner-neutral-message'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/shared/${branch}`, expectedHead])

    await mergeRemoteTask(paths, 219, 'shared', branch, expectedHead, {
      taskGate: 'light', project: noCheckProject,
      forge: {
        issueClosingCommitMessage: (message, issueNumber) =>
          `${message} (resolves ticket ${issueNumber})`,
      },
    })

    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      'Merge remote-runner-neutral-message via orchestration (resolves ticket 219)',
    )
  })

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

    await expect(mergeRemoteTask(paths, 220, 'origin', branch, expectedHead, {
      taskGate: 'light',
      project: stubProject,
      forge: { issueClosingCommitMessage: (message) => message },
      testCmd: 'node -e "const fs=require(\'node:fs\'); process.exit(fs.existsSync(\'run.txt\') && fs.existsSync(\'task.txt\') ? 1 : 0)"',
    })).rejects.toThrow(/Tests failed/)

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(join(repoRoot, 'run.txt'))).toBe(true)
    expect(existsSync(join(repoRoot, 'task.txt'))).toBe(false)
  })
})
