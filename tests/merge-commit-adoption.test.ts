import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  MergeBaseMovedError, MergeError, MergeRecoveryError, mergeRemoteTask, mergeTask,
} from '../src/merge.ts'
import { branchName } from '../src/paths.ts'
import { readStatus } from '../src/status.ts'
import {
  expectNoTemporaryWorktree, git, makeCompletedTask, noCheckProject, paths, repoRoot,
  repositoryState,
} from './mergeHarness.ts'
import { stubProject } from './stubProject.ts'

describe('mergeTask with commits left off the task branch', () => {
  const branchOf = (cwd: string): string => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const tipOf = (ref: string): string => git(repoRoot, ['rev-parse', ref]).trim()

  function commitInWorktree(worktree: string, file: string): string {
    writeFileSync(join(worktree, file), 'work\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-qm', 'feat: add work on another branch'])
    return git(worktree, ['rev-parse', 'HEAD']).trim()
  }

  it('adopts commits the agent made on a branch it created', async () => {
    const taskId = '20261111_000000_001_user-feature-branch'
    const worktree = await makeCompletedTask(taskId)
    git(worktree, ['switch', '-q', '-c', 'feature/x'])
    const agentCommit = commitInWorktree(worktree, 'feature.txt')
    const outputFile = join(repoRoot, 'adopt-branch.log')

    const result = await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
    })

    expect(result.outcome).toBe('merged')
    const mergeCommit = tipOf('main')
    expect(git(repoRoot, ['log', '-1', '--format=%s', mergeCommit]).trim())
      .toBe(`Merge ${taskId} via orchestration`)
    git(repoRoot, ['merge-base', '--is-ancestor', agentCommit, mergeCommit])
    expect(readFileSync(join(repoRoot, 'feature.txt'), 'utf8')).toBe('work\n')
    expect(readFileSync(outputFile, 'utf8')).toContain(
      `=== Adopted task commits from feature/x onto ${branchName(taskId)} ===`,
    )
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(readStatus(paths, taskId)?.merge_commit).toBe(mergeCommit)
    expect(tipOf('feature/x')).toBe(agentCommit)
  })

  it('adopts commits the agent made on a detached HEAD', async () => {
    const taskId = '20261111_000000_002_user-detached-head'
    const worktree = await makeCompletedTask(taskId)
    git(worktree, ['switch', '-q', '--detach'])
    const agentCommit = commitInWorktree(worktree, 'detached.txt')
    const outputFile = join(repoRoot, 'adopt-detached.log')

    const result = await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
    })

    expect(result.outcome).toBe('merged')
    git(repoRoot, ['merge-base', '--is-ancestor', agentCommit, tipOf('main')])
    expect(readFileSync(outputFile, 'utf8')).toContain(
      `=== Adopted task commits from detached HEAD ${agentCommit} onto ${branchName(taskId)} ===`,
    )
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('keeps detached commits on the task branch when the switch to it fails', async () => {
    const taskId = '20261111_000000_006_user-detached-switch-fails'
    const worktree = await makeCompletedTask(taskId)
    git(worktree, ['switch', '-q', '--detach'])
    const agentCommit = commitInWorktree(worktree, 'detached.txt')
    const indexLock = git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index.lock']).trim()
    writeFileSync(indexLock, '')
    const outputFile = join(repoRoot, 'adopt-switch-fails.log')

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
    })).rejects.toThrow()

    expect(tipOf(branchName(taskId))).toBe(agentCommit)
    expect(branchOf(worktree)).toBe('HEAD')
    expect(readStatus(paths, taskId)?.status).toBe('completed')

    rmSync(indexLock)
    const result = await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
    })

    expect(result.outcome).toBe('merged')
    git(repoRoot, ['merge-base', '--is-ancestor', agentCommit, tipOf('main')])
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('leaves a branch that diverged from the task branch to the ordinary checks', async () => {
    const taskId = '20261111_000000_003_user-diverged-branch'
    writeFileSync(join(repoRoot, 'second.txt'), 'second\n')
    git(repoRoot, ['add', 'second.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: second commit'])
    const worktree = await makeCompletedTask(taskId)
    const taskTip = tipOf(branchName(taskId))
    git(worktree, ['switch', '-q', '-c', 'feature/x', 'HEAD~1'])
    commitInWorktree(worktree, 'diverged.txt')
    const runHead = tipOf('main')
    const outputFile = join(repoRoot, 'adopt-diverged.log')

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
    })).rejects.toThrow(`Merging ${branchName(taskId)} created no commit on main.`)

    expect(readFileSync(outputFile, 'utf8')).not.toContain('Adopted task commits')
    expect(tipOf(branchName(taskId))).toBe(taskTip)
    expect(branchOf(worktree)).toBe('feature/x')
    expect(tipOf('main')).toBe(runHead)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('leaves a dirty worktree on another branch to the uncommitted-changes check', async () => {
    const taskId = '20261111_000000_004_user-dirty-branch'
    const worktree = await makeCompletedTask(taskId)
    const taskTip = tipOf(branchName(taskId))
    git(worktree, ['switch', '-q', '-c', 'feature/x'])
    commitInWorktree(worktree, 'feature.txt')
    writeFileSync(join(worktree, 'uncommitted.txt'), 'left behind\n')
    const outputFile = join(repoRoot, 'adopt-dirty.log')

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
    })).rejects.toThrow('The worktree has uncommitted changes')

    expect(existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : '')
      .not.toContain('Adopted task commits')
    expect(tipOf(branchName(taskId))).toBe(taskTip)
    expect(branchOf(worktree)).toBe('feature/x')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('still refuses a merge that created no commit when nothing needed adopting', async () => {
    const taskId = '20261111_000000_005_user-no-work-anywhere'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const taskTip = tipOf(branchName(taskId))
    git(worktree, ['switch', '-q', '-c', 'feature/x'])
    const runHead = tipOf('main')
    const outputFile = join(repoRoot, 'adopt-nothing.log')
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string =>
        cwd === paths.repoRoot && args[0] === 'merge' && args[1] === '--quiet' ? '' : git(cwd, args),
    }

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile, mergeRuntime,
    })).rejects.toThrow(`Merging ${branchName(taskId)} created no commit on main.`)

    expect(readFileSync(outputFile, 'utf8')).not.toContain('Adopted task commits')
    expect(tipOf(branchName(taskId))).toBe(taskTip)
    expect(tipOf('main')).toBe(runHead)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })
})

describe('mergeRemoteTask', () => {
  it('rejects a malformed task branch without changing HEAD or worktree state', async () => {
    const before = repositoryState()

    await expect(mergeRemoteTask(
      paths,
      222,
      'origin',
      'task/../outside',
      before.head,
      {
        taskGate: 'light',
        project: noCheckProject,
        forge: { issueClosingCommitMessage: (message) => message },
      },
    )).rejects.toThrow('Issue #222 reported an invalid task branch: task/../outside')

    expect(repositoryState()).toEqual(before)
  })

  it('rejects a malformed reported head without changing HEAD or worktree state', async () => {
    const before = repositoryState()

    await expect(mergeRemoteTask(
      paths,
      223,
      'origin',
      'task/remote-malformed-head',
      'not-a-commit',
      {
        taskGate: 'light',
        project: noCheckProject,
        forge: { issueClosingCommitMessage: (message) => message },
      },
    )).rejects.toThrow('Issue #223 reported an invalid head commit: not-a-commit')

    expect(repositoryState()).toEqual(before)
  })

  it('rejects a mismatched reported head without changing HEAD or worktree state', async () => {
    const branch = 'task/remote-mismatched-head'
    const reportedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const fetchedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, fetchedHead])
    git(repoRoot, ['branch', '-D', branch])
    const before = repositoryState()

    await expect(mergeRemoteTask(paths, 224, 'origin', branch, reportedHead, {
      taskGate: 'light',
      project: noCheckProject,
      forge: { issueClosingCommitMessage: (message) => message },
    })).rejects.toThrow(
      `Remote branch ${branch} is at ${fetchedHead}, not the reported ${reportedHead}.`,
    )

    expect(repositoryState()).toEqual(before)
  })

  it('rejects an already-merged branch without changing HEAD or worktree state', async () => {
    const branch = 'task/remote-already-merged'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['merge', '--ff-only', branch])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    git(repoRoot, ['branch', '-D', branch])
    const before = repositoryState()

    await expect(mergeRemoteTask(paths, 225, 'origin', branch, expectedHead, {
      taskGate: 'light',
      project: noCheckProject,
      forge: { issueClosingCommitMessage: (message) => message },
    })).rejects.toThrow(`${branch} has no new commits relative to main.`)

    expect(repositoryState()).toEqual(before)
  })

  it('replays persistence when the prior remote merge callback failed', async () => {
    const branch = 'task/remote-retries-persistence'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    const onMerged = vi.fn()
      .mockImplementationOnce(() => { throw new Error('persistence unavailable') })
    const options = {
      taskGate: 'light' as const,
      project: noCheckProject,
      forge: { issueClosingCommitMessage: (message: string) => message },
      onMerged,
    }

    await expect(mergeRemoteTask(
      paths, 227, 'origin', branch, expectedHead, options,
    )).rejects.toThrow('persistence unavailable')
    const appliedCommit = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expect(mergeRemoteTask(
      paths, 227, 'origin', branch, expectedHead, options,
    )).resolves.toBe(appliedCommit)

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(appliedCommit)
    expect(onMerged).toHaveBeenCalledTimes(2)
    expect(onMerged).toHaveBeenLastCalledWith(appliedCommit)
  })

  it('keeps a recorded adoption when the dependency check cannot read it', async () => {
    const branch = 'task/remote-unreadable-merge'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    const install = vi.fn()
    const events: Array<[string, string]> = []
    const previousGitDir = process.env.GIT_DIR
    const restoreGitDir = (): void => {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
    }

    let mergeCommit: string
    try {
      mergeCommit = await mergeRemoteTask(paths, 232, 'origin', branch, expectedHead, {
        taskGate: 'light',
        project: noCheckProject,
        forge: { issueClosingCommitMessage: (message) => message },
        orchestrationDepsRuntime: { install, packageRoot: join(repoRoot, 'orchestration', 'ts') },
        // Every git call the dependency check makes now fails; the warning restores git.
        onMerged: () => { process.env.GIT_DIR = join(repoRoot, 'missing-git-dir') },
        onOrchestrationDepsEvent: (name, subject) => {
          restoreGitDir()
          events.push([name, subject])
        },
      })
    } finally {
      restoreGitDir()
    }

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(mergeCommit)
    expect(git(repoRoot, ['rev-parse', `${mergeCommit}^2`]).trim()).toBe(expectedHead)
    expect(install).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0]?.[0]).toBe('WARN')
    expect(events[0]?.[1]).toMatch(/^could not check .+ for orchestration dependency changes: /)
  })

  it('keeps a replayed adoption when the dependency check cannot read it', async () => {
    const branch = 'task/remote-unreadable-replay'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    const events: Array<[string, string]> = []
    const previousGitDir = process.env.GIT_DIR
    const restoreGitDir = (): void => {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
    }
    const onMerged = vi.fn()
      .mockImplementationOnce(() => { throw new Error('persistence unavailable') })
      .mockImplementationOnce(() => { process.env.GIT_DIR = join(repoRoot, 'missing-git-dir') })
    const options = {
      taskGate: 'light' as const,
      project: noCheckProject,
      forge: { issueClosingCommitMessage: (message: string) => message },
      onMerged,
      onOrchestrationDepsEvent: (name: 'Installed' | 'Skipped' | 'WARN', subject: string) => {
        restoreGitDir()
        events.push([name, subject])
      },
    }

    await expect(mergeRemoteTask(
      paths, 233, 'origin', branch, expectedHead, options,
    )).rejects.toThrow('persistence unavailable')
    const appliedCommit = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    try {
      await expect(mergeRemoteTask(
        paths, 233, 'origin', branch, expectedHead, options,
      )).resolves.toBe(appliedCommit)
    } finally {
      restoreGitDir()
    }

    expect(onMerged).toHaveBeenLastCalledWith(appliedCommit)
    expect(events).toHaveLength(1)
    expect(events[0]?.[0]).toBe('WARN')
    expect(events[0]?.[1]).toMatch(/^could not check .+ for orchestration dependency changes: /)
  })

  it('refuses to record an adoption that left the run branch where it was', async () => {
    const branch = 'task/remote-merge-without-commit'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    git(repoRoot, ['branch', '-D', branch])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string =>
        cwd === paths.repoRoot && args[0] === 'merge' && args[1] === '--quiet' ? '' : git(cwd, args),
    }
    const onMerged = vi.fn()

    await expect(mergeRemoteTask(paths, 230, 'origin', branch, expectedHead, {
      taskGate: 'light', project: noCheckProject, mergeRuntime, onMerged,
      forge: { issueClosingCommitMessage: (message) => message },
    })).rejects.toThrow(`Adopting ${branch} created no commit on main.`)

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(onMerged).not.toHaveBeenCalled()
  })

  it('adopts the branch when the inspection diff cannot be produced', async () => {
    const branch = 'task/remote-inspection-diff-fails'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    // A failing external diff driver makes every patch-producing `git diff` exit non-zero.
    git(repoRoot, ['config', 'diff.external', 'false'])
    const onMerged = vi.fn()

    const mergeCommit = await mergeRemoteTask(paths, 231, 'origin', branch, expectedHead, {
      taskGate: 'light', project: noCheckProject, onMerged,
      forge: { issueClosingCommitMessage: (message) => message },
    })

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(mergeCommit)
    expect(git(repoRoot, ['rev-parse', `${mergeCommit}^2`]).trim()).toBe(expectedHead)
    expect(onMerged).toHaveBeenCalledWith(mergeCommit)
  })

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

  it('removes the checked worktree before applying the remote merge', async () => {
    const branch = 'task/remote-clean-before-merge'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    const onMerged = vi.fn(() => expectNoTemporaryWorktree('.adopt-'))

    await mergeRemoteTask(paths, 226, 'origin', branch, expectedHead, {
      taskGate: 'light', project: noCheckProject, onMerged,
      forge: { issueClosingCommitMessage: (message) => message },
    })

    expect(onMerged).toHaveBeenCalledOnce()
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

  it('merges the reported head even when the remote ref moves while the gate runs', async () => {
    const branch = 'task/remote-ref-moves-during-gate'
    const remoteRef = `refs/remotes/origin/${branch}`
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repoRoot, 'unverified.txt'), 'pushed after the report\n')
    git(repoRoot, ['add', 'unverified.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add work nobody reported'])
    const laterHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['branch', '-D', branch])
    git(repoRoot, ['update-ref', remoteRef, expectedHead])
    const refetch: typeof noCheckProject = {
      ...noCheckProject,
      name: 'refetch-during-gate',
      mergeChecks: () => {
        git(repoRoot, ['update-ref', remoteRef, laterHead])
        return []
      },
    }

    const mergeCommit = await mergeRemoteTask(paths, 230, 'origin', branch, expectedHead, {
      taskGate: 'light', project: refetch,
      forge: { issueClosingCommitMessage: (message) => message },
    })

    expect(git(repoRoot, ['rev-parse', `${mergeCommit}^2`]).trim()).toBe(expectedHead)
    expect(existsSync(join(repoRoot, 'task.txt'))).toBe(true)
    expect(existsSync(join(repoRoot, 'unverified.txt'))).toBe(false)
  })

  it('defers an adoption whose run branch received a hand merge while the gate ran', async () => {
    const branch = 'task/remote-run-branch-moved'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote task work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['branch', '-D', branch])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    const handMerge: typeof noCheckProject = {
      ...noCheckProject,
      name: 'hand-merge-during-adoption-gate',
      mergeChecks: () => {
        git(repoRoot, ['commit', '-q', '--allow-empty', '-m', 'chore: land a hand merge'])
        return []
      },
    }
    const onMerged = vi.fn()

    const deferred = mergeRemoteTask(paths, 231, 'origin', branch, expectedHead, {
      taskGate: 'light', project: handMerge, onMerged,
      forge: { issueClosingCommitMessage: (message) => message },
    })

    await expect(deferred).rejects.toBeInstanceOf(MergeBaseMovedError)
    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe('chore: land a hand merge')
    expect(existsSync(join(repoRoot, 'task.txt'))).toBe(false)
    expect(onMerged).not.toHaveBeenCalled()
    expectNoTemporaryWorktree('.adopt-')
  })

  it('aborts a conflicting adoption without changing the run branch or remote state', async () => {
    const branch = 'task/remote-conflicting-change'
    const remoteRef = `refs/remotes/origin/${branch}`
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'README.md'), '# remote version\n')
    git(repoRoot, ['add', 'README.md'])
    git(repoRoot, ['commit', '-qm', 'feat: change README remotely'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', remoteRef, expectedHead])
    git(repoRoot, ['branch', '-D', branch])

    writeFileSync(join(repoRoot, 'README.md'), '# run version\n')
    git(repoRoot, ['add', 'README.md'])
    git(repoRoot, ['commit', '-qm', 'feat: change README on run branch'])
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const runStatus = git(repoRoot, ['status', '--porcelain'])

    await expect(mergeRemoteTask(paths, 221, 'origin', branch, expectedHead, {
      taskGate: 'light',
      project: noCheckProject,
      forge: { issueClosingCommitMessage: (message) => message },
    })).rejects.toThrow(`A merge conflict occurred while adopting ${branch}.`)

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(git(repoRoot, ['status', '--porcelain'])).toBe(runStatus)
    expect(readFileSync(join(repoRoot, 'README.md'), 'utf8')).toBe('# run version\n')
    expect(git(repoRoot, ['rev-parse', remoteRef]).trim()).toBe(expectedHead)
    expect(git(repoRoot, ['show', `${remoteRef}:README.md`])).toBe('# remote version\n')
    expectNoTemporaryWorktree('.adopt-')
  })

  it('stops when abort leaves a remote adoption merge in progress', async () => {
    const branch = 'task/remote-unrecoverable-conflict'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'remote recovery work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote recovery work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    let mergeCalls = 0
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string => {
        if (args[0] === 'merge' && args[1] === '--quiet') {
          mergeCalls += 1
          if (mergeCalls === 2) {
            git(cwd, ['merge', '--no-commit', '--no-ff', args[3]!])
            throw new Error('merge result was not reported')
          }
        }
        if (args[0] === 'merge' && args[1] === '--abort') throw new Error('abort is blocked')
        return git(cwd, args)
      },
    }

    await expect(mergeRemoteTask(paths, 228, 'origin', branch, expectedHead, {
      taskGate: 'light', project: noCheckProject, mergeRuntime,
      forge: { issueClosingCommitMessage: (message) => message },
    })).rejects.toThrow('merge is still in progress; merge abort failed: abort is blocked')

    expectNoTemporaryWorktree('.adopt-')
  })

  it('returns a retryable conflict when a failed abort is proven harmless', async () => {
    const branch = 'task/remote-safe-abort-failure'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'task.txt'), 'task work\n')
    git(repoRoot, ['add', 'task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add safe abort fixture'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string => {
        if (args[0] === 'merge' && args[1] === '--quiet') throw new Error('merge did not start')
        if (args[0] === 'merge' && args[1] === '--abort') throw new Error('nothing to abort')
        return git(cwd, args)
      },
    }

    const failure = mergeRemoteTask(paths, 229, 'origin', branch, expectedHead, {
      taskGate: 'light', project: noCheckProject, mergeRuntime,
      forge: { issueClosingCommitMessage: (message) => message },
    })
    await expect(failure).rejects.toThrow(MergeError)
    await expect(failure).rejects.not.toThrow(MergeRecoveryError)
    // The merge left neither a merge in progress nor unmerged paths, so git refused it
    // rather than stopping on a conflict, and the task is not blamed for one.
    await expect(failure).rejects.toThrow(
      'without a conflict; the checkout was left as it was. Merge failure: merge did not start',
    )
    await expect(failure).rejects.not.toThrow('A merge conflict occurred')
    expectNoTemporaryWorktree('.adopt-')
  })
})
