import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { operatingSystem } from '../src/adapters/os.ts'
import {
  completeTaskWithoutChanges, inTemporaryWorktree, MergeError, MergeRecoveryError,
  mergeRemoteTask, mergeTask, removeMergedWorktree, removeTemporaryWorktree,
  TestLockBusyError, UnverifiedRunnerError,
} from '../src/merge.ts'
import { branchName, finalMessageFile, orchPaths, worktreeDir } from '../src/paths.ts'
import { taskProcessPid } from '../src/processRegistry.ts'
import { readStatus, writeMergedStatus, writeStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'
import { removeWorktreeWithFallback } from '../src/worktree.ts'
import {
  expectNoTemporaryWorktree, failedWorktreeRemovalRuntime, git, installProject,
  makeCompletedTask, noCheckProject, paths, posixOperatingSystem, repoRoot, repositoryState,
  staleMetadataRemovalRuntime, testProcesses, waitForFile, windowsOperatingSystem,
} from './mergeHarness.ts'
import { stubProject } from './stubProject.ts'
import { nonCanonicalSpelling } from './pathComparison.ts'

describe('removeMergedWorktree', () => {
  it('returns a metadata prune failure after fallback removal', () => {
    const worktree = worktreeDir(paths, '20260820_205524_042_auto-prune-failure')
    const result = removeWorktreeWithFallback(paths.repoRoot, worktree, {
      os: posixOperatingSystem(vi.fn()),
      git: (_cwd, args) => {
        if (args[1] === 'remove') throw new Error('Git removal failed')
        if (args[1] === 'prune') throw new Error('metadata is locked')
        return ''
      },
    }, vi.fn())

    expect(result).toMatchObject({
      gitFailure: 'Git removal failed',
      fallbackFailure: undefined,
      pruneFailure: 'metadata is locked',
    })
  })

  it('does not report removal when worktree metadata is still registered', () => {
    const worktree = worktreeDir(paths, '20260820_205524_043_auto-stale-registration')
    const log = vi.fn()
    const removed = removeMergedWorktree(paths, worktree, log, {
      os: posixOperatingSystem(vi.fn()),
      git: (_cwd, args) => {
        if (args[1] === 'remove') throw new Error('Git removal failed')
        if (args[1] === 'prune') throw new Error('metadata is locked')
        if (args[1] === 'list') return `worktree ${worktree}\0HEAD deadbeef\0`
        return ''
      },
    })

    expect(removed).toBe(false)
    expect(log).toHaveBeenCalledWith(
      `WARN: worktree metadata pruning failed for ${worktree}: metadata is locked`,
    )
    expect(log).toHaveBeenCalledWith(
      `WARN: the removed worktree is still registered and has to be pruned by hand: ${worktree}`,
    )
  })

  it('sees a stale registration when the root is not spelled the way Git reports it', () => {
    const taskId = '20260820_205524_044_auto-aliased-registration'
    const linkDir = mkdtempSync(join(tmpdir(), 'orch-merge-alias-'))
    try {
      const aliasPaths = orchPaths(nonCanonicalSpelling(repoRoot, linkDir))
      const worktree = worktreeDir(aliasPaths, taskId)
      git(repoRoot, ['worktree', 'add', worktree, '-b', branchName(taskId)])
      const log = vi.fn()

      const removed = removeMergedWorktree(aliasPaths, worktree, log, {
        os: operatingSystem,
        git: (cwd, args) => {
          if (args[1] === 'remove') throw new Error('Git removal failed')
          if (args[1] === 'prune') throw new Error('metadata is locked')
          return git(cwd, args)
        },
      })

      expect(removed).toBe(false)
      expect(log).toHaveBeenCalledWith(
        `WARN: the removed worktree is still registered and has to be pruned by hand: ${worktree}`,
      )
    } finally {
      git(repoRoot, ['worktree', 'prune', '--expire', 'now'])
      rmSync(linkDir, { recursive: true, force: true })
    }
  })

  it('uses the Windows UNC namespace for a UNC worktree fallback', () => {
    const worktree = '\\\\server\\share\\orchestration\\worktrees\\task'
    const remove = vi.fn()
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('Removal failed')
      return ''
    })

    removeMergedWorktree(paths, worktree, vi.fn(), {
      os: windowsOperatingSystem(remove), git: gitRuntime,
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
      os: windowsOperatingSystem(remove), git: gitRuntime,
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

    const removed = removeMergedWorktree(paths, worktree, log, {
      os: posixOperatingSystem(remove), git: gitRuntime,
    })

    expect(removed).toBe(true)
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

    const removed = removeMergedWorktree(paths, worktree, log, {
      os: windowsOperatingSystem(() => { throw new Error('Filename too long') }),
      git: gitRuntime,
    })

    expect(removed).toBe(false)
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(
      `WARN: merged, but the worktree is still there and has to go by hand: ${worktree} (error: failed to delete: Filename too long)`,
    )
    expect(gitRuntime).toHaveBeenNthCalledWith(
      2, paths.repoRoot, ['worktree', 'prune'],
    )
  })
})

describe('removeTemporaryWorktree', () => {
  it('ends processes left in the worktree before Git removes it and logs each one', () => {
    const worktree = join(paths.worktreesDir, '.merge-held')
    const calls: string[] = []
    const log = vi.fn()

    removeTemporaryWorktree(paths, worktree, log, {
      os: {
        ...posixOperatingSystem(vi.fn()),
        terminateWorktreeProcesses: (path, report) => {
          calls.push(`terminate ${path}`)
          report(`Stopped PID 4242    bash.exe holding worktree ${path}`)
        },
      },
      git: (_cwd, args) => {
        calls.push(args.join(' '))
        return ''
      },
    })

    expect(calls).toEqual([`terminate ${worktree}`, `worktree remove ${worktree} --force`])
    expect(log).toHaveBeenCalledWith(`Stopped PID 4242    bash.exe holding worktree ${worktree}`)
  })

  it('uses the Windows long-path fallback and prunes after git removal fails', () => {
    const worktree = join(paths.worktreesDir, '.merge-long-path')
    const remove = vi.fn()
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('Removal failed')
      return ''
    })

    removeTemporaryWorktree(paths, worktree, vi.fn(), {
      os: windowsOperatingSystem(remove), git: gitRuntime,
    })

    expect(remove).toHaveBeenCalledWith(
      `\\\\?\\${worktree.replaceAll('/', '\\')}`,
      { recursive: true, force: true, maxRetries: 3 },
    )
    expect(gitRuntime).toHaveBeenNthCalledWith(
      2, paths.repoRoot, ['worktree', 'prune'],
    )
  })

  it('fails when both Git and the direct-removal fallback fail', () => {
    const worktree = join(paths.worktreesDir, '.merge-still-present')
    const gitRuntime = vi.fn((_cwd: string, args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new Error('Git removal failed')
      return ''
    })

    expect(() => removeTemporaryWorktree(paths, worktree, vi.fn(), {
      os: posixOperatingSystem(() => { throw new Error('Direct removal failed') }),
      git: gitRuntime,
    })).toThrow(
      `Could not remove temporary worktree ${worktree}; merge was not applied. `
      + '(git: Git removal failed; fallback: Direct removal failed)',
    )
    expect(gitRuntime).toHaveBeenNthCalledWith(2, paths.repoRoot, ['worktree', 'prune'])
  })
})

describe('inTemporaryWorktree', () => {
  const removalFailure = (worktree: string): string =>
    `Could not remove temporary worktree ${worktree}; merge was not applied. `
    + '(git: Git removal failed; fallback: Direct removal failed)'

  it.each([
    ['a test-lock deferral', new TestLockBusyError('the repository test lock stayed busy')],
    ['a recovery failure', new MergeRecoveryError('Could not restore the worktree.')],
  ])('keeps %s when the worktree removal also fails, and logs the removal', (_name, failure) => {
    const worktree = join(paths.worktreesDir, '.merge-failed-step')
    const log = vi.fn()

    let thrown: unknown
    try {
      inTemporaryWorktree(paths, worktree, log, () => { throw failure }, failedWorktreeRemovalRuntime())
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(failure)
    expect(log).toHaveBeenCalledWith(`WARN: ${removalFailure(worktree)}`)
  })

  it('fails with the removal error when the step passed', () => {
    const worktree = join(paths.worktreesDir, '.merge-passed-step')
    const step = vi.fn()

    expect(() => inTemporaryWorktree(
      paths, worktree, vi.fn(), step, failedWorktreeRemovalRuntime(),
    )).toThrow(removalFailure(worktree))
    expect(step).toHaveBeenCalledOnce()
  })

  it('removes the worktree after a step that passed', () => {
    const worktree = join(paths.worktreesDir, '.merge-clean')
    const calls: string[] = []

    inTemporaryWorktree(paths, worktree, vi.fn(), () => { calls.push('step') }, {
      os: posixOperatingSystem(vi.fn()),
      git: (_cwd, args) => {
        calls.push(args.join(' '))
        return ''
      },
    })

    expect(calls).toEqual(['step', `worktree remove ${worktree} --force`])
  })
})

describe('mergeTask', () => {
  it('reclaims an old ownerless merge guard left by a failed acquisition', async () => {
    const taskId = '20260820_135042_001_user-ownerless-guard'
    await makeCompletedTask(taskId, { commit: true })
    const guard = join(paths.queueDir, 'merge-guards', taskId)
    mkdirSync(guard, { recursive: true })
    const old = new Date(Date.now() - 60_000)
    utimesSync(guard, old, old)

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    })).resolves.toMatchObject({ outcome: 'merged' })

    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(existsSync(guard)).toBe(false)
  })

  it('reclaims an old merge guard with an unparseable owner file', async () => {
    const taskId = '20260820_135042_002_user-malformed-guard'
    await makeCompletedTask(taskId, { commit: true })
    const guard = join(paths.queueDir, 'merge-guards', taskId)
    mkdirSync(guard, { recursive: true })
    const ownerFile = join(guard, 'owner.json')
    writeFileSync(ownerFile, '{not json\n')
    const old = new Date(Date.now() - 60_000)
    utimesSync(ownerFile, old, old)

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    })).resolves.toMatchObject({ outcome: 'merged' })

    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(existsSync(guard)).toBe(false)
  })

  it('treats a fresh merge guard with an unparseable owner file as active', async () => {
    const taskId = '20260820_135042_004_user-fresh-malformed-guard'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const initialHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const guard = join(paths.queueDir, 'merge-guards', taskId)
    mkdirSync(guard, { recursive: true })
    const ownerFile = join(guard, 'owner.json')
    writeFileSync(ownerFile, '{not json\n')
    const onMergeSkipped = vi.fn()
    const onMergeStart = vi.fn()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, onMergeSkipped, onMergeStart,
    })).resolves.toEqual({ outcome: 'skipped', reason: 'active' })

    expect(onMergeSkipped.mock.calls).toEqual([['active']])
    expect(onMergeStart).not.toHaveBeenCalled()
    expect(readFileSync(ownerFile, 'utf8')).toBe('{not json\n')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(initialHead)
    expect(existsSync(worktree)).toBe(true)
  })

  it('fails safely when a stale merge guard cannot be removed', async () => {
    const taskId = '20260820_135042_003_user-blocked-stale-guard'
    await makeCompletedTask(taskId, { commit: true })
    const guard = join(paths.queueDir, 'merge-guards', taskId)
    mkdirSync(guard, { recursive: true })
    writeFileSync(join(guard, 'owner.json'), `${JSON.stringify({
      state: 'active', pid: 2147483647, startIdentity: null,
    })}\n`)
    writeFileSync(join(guard, 'blocker'), 'cannot remove directory\n')
    vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(false)
    const now = Date.now()
    let elapsed = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now + elapsed++ * 1_000)

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    })).rejects.toThrow(`Could not remove stale merge guard: ${taskId}`)

    expect(existsSync(guard)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it.each(['merged', 'no-change'] as const)(
    'skips a task already recorded %s without taking the merge guard',
    async (recorded) => {
      const taskId = `20260808_000000_040_user-already-${recorded}`
      const worktree = await makeCompletedTask(taskId, { commit: true })
      const initialHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
      if (recorded === 'merged') {
        await writeMergedStatus(paths, taskId, initialHead, 'main')
      } else {
        await writeStatus(paths, taskId, 'no-change')
      }
      const onMergeSkipped = vi.fn()
      const onMergeStart = vi.fn()

      await expect(mergeTask(paths, taskId, {
        taskGate: 'light', project: noCheckProject, onMergeSkipped, onMergeStart,
      })).resolves.toEqual({ outcome: 'skipped', reason: 'succeeded' })

      expect(onMergeSkipped.mock.calls).toEqual([['succeeded']])
      expect(onMergeStart).not.toHaveBeenCalled()
      expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(initialHead)
      expect(existsSync(join(paths.queueDir, 'merge-guards'))).toBe(false)
      expect(existsSync(worktree)).toBe(true)
      expect(readStatus(paths, taskId)?.status).toBe(recorded)
    },
  )

  it('skips a task another merger finished while this one waited for the guard', async () => {
    const taskId = '20260808_000000_041_user-merged-while-waiting'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const initialHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    // A retired guard that cannot be removed yet keeps this merger waiting to reclaim it.
    const guard = join(paths.queueDir, 'merge-guards', taskId)
    mkdirSync(guard, { recursive: true })
    writeFileSync(join(guard, 'retired'), '')
    const blocker = join(guard, 'blocker')
    writeFileSync(blocker, 'keeps the retired guard in place\n')
    const onMergeSkipped = vi.fn()
    const onMergeStart = vi.fn()

    const pending = mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, onMergeSkipped, onMergeStart,
    })
    await writeMergedStatus(paths, taskId, initialHead, 'main')
    rmSync(blocker)

    await expect(pending).resolves.toEqual({ outcome: 'skipped', reason: 'succeeded' })
    expect(onMergeSkipped.mock.calls).toEqual([['succeeded']])
    expect(onMergeStart).not.toHaveBeenCalled()
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(initialHead)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('merges a committed task, removes its worktree and branch, and records merged', async () => {
    const taskId = '20260808_000000_001_user-adds-a-file'
    const worktree = await makeCompletedTask(taskId, { commit: true })

    const result = await mergeTask(
      paths, taskId, { taskGate: 'light', project: stubProject },
    )

    expect(result).toEqual({
      outcome: 'merged', mergeCommit: git(repoRoot, ['rev-parse', 'HEAD']).trim(),
    })
    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via orchestration`,
    )
    expect(existsSync(join(repoRoot, `${taskId}.txt`))).toBe(true)
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('persists and cleans up a merge already applied before status persistence failed', async () => {
    const taskId = '20260808_000000_022_user-retries-persistence'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    git(repoRoot, [
      'merge', '--quiet', '--no-ff', branchName(taskId),
      '-m', `Merge ${taskId} via orchestration`,
    ])
    const appliedCommit = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    })).resolves.toEqual({ outcome: 'merged', mergeCommit: appliedCommit })

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(appliedCommit)
    expect(readStatus(paths, taskId)).toMatchObject({
      status: 'merged', merge_commit: appliedCommit, run_branch: 'main',
    })
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).toBe('')
  })

  it('records why the merged work exists in the merge commit body', async () => {
    const taskId = '20260808_000000_027_user-merge-reason'
    await makeCompletedTask(taskId, { commit: true })
    writeFileSync(specFile(paths, taskId), [
      '# spec',
      '## Requirement',
      'Drop the duplicate retry in `src/fetch.ts`; it doubles every timeout.\n\nDetails follow.',
      '## Commit',
    ].join('\n\n'))

    await mergeTask(paths, taskId, { taskGate: 'light', project: noCheckProject })

    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim())
      .toBe(`Merge ${taskId} via orchestration`)
    expect(git(repoRoot, ['log', '-1', '--format=%b']).trim())
      .toBe('Why: Drop the duplicate retry in `src/fetch.ts`; it doubles every timeout.')
  })

  it('withholds the details of a security requirement', async () => {
    const taskId = '20260808_000000_028_user-security-reason'
    await makeCompletedTask(taskId, { commit: true })

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      reasons: [
        '[SECURITY] The token check in `src/auth.ts` accepts an empty signature',
        '[DEPS] Bump the parser past GHSA-qwww-vcr4-c8h2',
      ],
    })

    expect(git(repoRoot, ['log', '-1', '--format=%b']).trim())
      .toBe('Why: security fix; details withheld.')
  })

  it('recognizes an applied merge whose reasons have changed since', async () => {
    const taskId = '20260808_000000_029_user-edited-reason'
    await makeCompletedTask(taskId, { commit: true })
    git(repoRoot, [
      'merge', '--quiet', '--no-ff', branchName(taskId),
      '-m', `Merge ${taskId} via orchestration\n\nWhy: the requirement as it first read.`,
    ])
    const appliedCommit = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, reasons: ['The requirement as edited later.'],
    })).resolves.toEqual({ outcome: 'merged', mergeCommit: appliedCommit })
  })

  it('reports manual cleanup when a merged worktree could not be removed', async () => {
    const taskId = '20260808_000000_026_user-retained-merged-worktree'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const outputFile = join(repoRoot, 'merge-output.log')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
      worktreeRemovalRuntime: failedWorktreeRemovalRuntime(),
    })

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain(
      `WARN: merged, but the worktree is still there and has to go by hand: ${worktree}`,
    )
    expect(output).toContain(`Merged ${taskId}; manual worktree cleanup remains: ${worktree}`)
    expect(output).not.toContain(`Merged ${taskId} and removed the worktree.`)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('ends processes left in the task worktree before removing it', async () => {
    const taskId = '20261029_040729_001_user-orphaned-worktree-shell'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const presentAtTermination = new Map<string, boolean>()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
      worktreeRemovalRuntime: {
        os: {
          ...operatingSystem,
          terminateWorktreeProcesses: (path) => {
            presentAtTermination.set(path, existsSync(path))
          },
        },
        git,
      },
    })).resolves.toMatchObject({ outcome: 'merged' })

    expect(presentAtTermination.get(worktree)).toBe(true)
    expect(existsSync(worktree)).toBe(false)
  })

  it('does not report merged cleanup while metadata and the task branch remain', async () => {
    const taskId = '20260820_205524_044_auto-retained-merged-metadata'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const branch = branchName(taskId)
    const outputFile = join(repoRoot, 'stale-merge-output.log')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
      worktreeRemovalRuntime: staleMetadataRemovalRuntime(),
    })

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain(`WARN: worktree metadata pruning failed for ${worktree}`)
    expect(output).toContain(`task branch remains: ${branch}`)
    expect(output).not.toContain(`Merged ${taskId} and removed the worktree.`)
    expect(git(repoRoot, ['worktree', 'list', '--porcelain']))
      .toContain(`branch refs/heads/${branch}`)
    expect(git(repoRoot, ['branch', '--list', branch]).trim()).not.toBe('')
  })

  it('stops and verifies a completed runner with a live PID before merging', async () => {
    const taskId = '20260808_000000_017_user-runner-finishes-output-first'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runnerReady = join(repoRoot, 'runner-ready')
    const runner = testProcesses.spawn(process.execPath, [
      '--input-type=module', '--eval',
      "const { writeFileSync } = await import('node:fs'); writeFileSync(process.argv[1], ''); setInterval(() => {}, 1000)",
      runnerReady,
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    const runnerPid = runner.pid
    if (runnerPid === undefined) throw new Error('Runner did not publish a PID.')
    runner.unref()
    await writeStatus(paths, taskId, 'completed', runnerPid)
    await waitForFile(runnerReady, 'Runner fixture did not become ready.')

    await mergeTask(paths, taskId, { taskGate: 'light', project: stubProject })

    expect(operatingSystem.processTreeIsAlive(runnerPid)).toBe(false)
    expect(existsSync(worktree)).toBe(false)
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(readStatus(paths, taskId)?.pid).toBeNull()
  })

  it('keeps completed task state when the runner cannot be verified stopped', async () => {
    const taskId = '20260808_000000_018_user-runner-resists-stop'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runnerPid = 12345
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue('started:runner')
    await writeStatus(paths, taskId, 'completed', runnerPid)
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree').mockReturnValue(true)
    vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(true)

    // A tree that resisted termination is a counted failure: unlike an unverifiable
    // runner, nothing here clears on its own.
    const failure = await mergeTask(paths, taskId, { taskGate: 'light', project: stubProject })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(MergeError)
    expect(failure).not.toBeInstanceOf(UnverifiedRunnerError)
    expect((failure as MergeError).message).toBe(
      `Could not stop completed runner ${runnerPid}; task state was retained.`,
    )

    expect(terminate).toHaveBeenCalledWith(runnerPid)
    expect(existsSync(worktree)).toBe(true)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).not.toBe('')
    expect(existsSync(join(repoRoot, `${taskId}.txt`))).toBe(false)
    expect(readStatus(paths, taskId)).toMatchObject({ status: 'completed', pid: runnerPid })
  })

  it('does not terminate an unverified runner before merging', async () => {
    const taskId = '20260815_120000_001_user-unverified-merge-runner'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runnerPid = 12345
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue(undefined)
    vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(true)
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree')
    await writeStatus(paths, taskId, 'completed', runnerPid)

    // A deferral, not a failure: the caller must be able to tell this from a gate that
    // judged the work, so it carries its own type and the PID it could not verify.
    const failure = await mergeTask(paths, taskId, { taskGate: 'light', project: stubProject })
      .then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(UnverifiedRunnerError)
    expect((failure as UnverifiedRunnerError).pid).toBe(runnerPid)
    expect((failure as UnverifiedRunnerError).message).toBe(
      `Could not verify completed runner ${runnerPid}; task state was retained.`,
    )

    expect(terminate).not.toHaveBeenCalled()
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)).toMatchObject({ status: 'completed', pid: runnerPid })
  })

  it('does not terminate an unverified runner before no-change completion', async () => {
    const taskId = '20260815_120000_002_user-unverified-no-change-runner'
    const worktree = await makeCompletedTask(taskId)
    const runnerPid = 12345
    writeFileSync(finalMessageFile(paths, taskId),
      'No implementation is needed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue(undefined)
    vi.spyOn(operatingSystem, 'processIsAlive').mockReturnValue(true)
    vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(true)
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree')
    await writeStatus(paths, taskId, 'completed', runnerPid)

    const failure = await completeTaskWithoutChanges(
      paths, taskId, git(repoRoot, ['rev-parse', 'HEAD']).trim(),
    ).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(UnverifiedRunnerError)
    expect((failure as UnverifiedRunnerError).pid).toBe(runnerPid)
    expect((failure as UnverifiedRunnerError).message).toBe(
      `Could not verify completed runner ${runnerPid}; task state was retained.`,
    )

    expect(terminate).not.toHaveBeenCalled()
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)).toMatchObject({ status: 'completed', pid: runnerPid })
  })

  it('forgets a stopped runner before a failed-check merge is retried', async () => {
    const taskId = '20260808_000000_027_user-failed-check-retry'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runnerPid = 12345
    vi.spyOn(operatingSystem, 'processStartIdentity').mockReturnValue('started:runner')
    await writeStatus(paths, taskId, 'completed', runnerPid)
    const terminate = vi.spyOn(operatingSystem, 'terminateProcessTree').mockReturnValue(true)
    vi.spyOn(operatingSystem, 'processTreeIsAlive').mockReturnValue(false)
    const options = {
      taskGate: 'light' as const,
      project: stubProject,
      testCmd: 'node -e "process.exit(1)"',
    }

    await expect(mergeTask(paths, taskId, options)).rejects.toThrow('Tests failed')

    expect(taskProcessPid(paths, taskId)).toBeUndefined()
    expect(readStatus(paths, taskId)).toMatchObject({ status: 'completed', pid: null })
    expect(existsSync(worktree)).toBe(true)

    await expect(mergeTask(paths, taskId, options)).rejects.toThrow('Tests failed')
    expect(terminate).toHaveBeenCalledTimes(1)
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

  it('names no queue issue in the merge commit when the queue is in another repository', async () => {
    const taskId = '20260808_000000_016_user-fleet-issue'
    await makeCompletedTask(taskId, { commit: true })
    const fleetQueuePaths = {
      ...paths,
      fleet: {
        dir: repoRoot, project: 'example', repository: 'owner/example', issueRepository: 'owner/fleet',
      },
    }

    await mergeTask(fleetQueuePaths, taskId, {
      taskGate: 'light',
      project: stubProject,
      closesIssues: [317, 318],
      forge: {
        issueClosingCommitMessage: (message, issueNumber) => `${message} (closes #${issueNumber})`,
      },
    })

    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via orchestration`,
    )
  })

  it('closes the project issues imported work came from when the queue is elsewhere', async () => {
    const taskId = '20260808_000000_017_user-imported-issue'
    await makeCompletedTask(taskId, { commit: true })
    const fleetQueuePaths = {
      ...paths,
      fleet: {
        dir: repoRoot, project: 'example', repository: 'owner/example', issueRepository: 'owner/fleet',
      },
    }

    await mergeTask(fleetQueuePaths, taskId, {
      taskGate: 'light',
      project: stubProject,
      closesIssues: [317],
      closesSourceIssues: [42],
      forge: {
        issueClosingCommitMessage: (message, issueNumber) => `${message} (closes #${issueNumber})`,
      },
    })

    expect(git(repoRoot, ['log', '-1', '--format=%s']).trim()).toBe(
      `Merge ${taskId} via orchestration (closes #42)`,
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

  it('accepts an explicit no-change verdict without creating a merge commit', async () => {
    const taskId = '20260808_000000_023_user-already-resolved'
    const worktree = await makeCompletedTask(taskId)
    const initialHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const onNoChange = vi.fn(async () => {})
    writeFileSync(finalMessageFile(paths, taskId),
      'The reported problem is already fixed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, onNoChange,
    })).resolves.toEqual({ outcome: 'no-change' })

    expect(onNoChange).toHaveBeenCalledOnce()
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(initialHead)
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
  })

  it('reports manual cleanup when a no-change worktree could not be removed', async () => {
    const taskId = '20260808_000000_028_user-retained-no-change-worktree'
    const worktree = await makeCompletedTask(taskId)
    const outputFile = join(repoRoot, 'no-change-output.log')
    writeFileSync(finalMessageFile(paths, taskId),
      'The reported problem is already fixed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, outputFile,
      worktreeRemovalRuntime: failedWorktreeRemovalRuntime(),
    })

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain(
      `WARN: task completed without changes, but the worktree is still there and has to go by hand: ${worktree}`,
    )
    expect(output).toContain(
      `Completed ${taskId} without changes; manual worktree cleanup remains: ${worktree}`,
    )
    expect(output).not.toContain(`Completed ${taskId} without changes and removed the worktree.`)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
  })

  it('does not report no-change cleanup while metadata and the task branch remain', async () => {
    const taskId = '20260820_205524_045_auto-retained-no-change-metadata'
    const worktree = await makeCompletedTask(taskId)
    const branch = branchName(taskId)
    const outputFile = join(repoRoot, 'stale-no-change-output.log')
    writeFileSync(finalMessageFile(paths, taskId),
      'The reported problem is already fixed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
      worktreeRemovalRuntime: staleMetadataRemovalRuntime(),
    })

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain(`WARN: worktree metadata pruning failed for ${worktree}`)
    expect(output).toContain(`task branch remains: ${branch}`)
    expect(output).not.toContain(`Completed ${taskId} without changes and removed the worktree.`)
    expect(git(repoRoot, ['worktree', 'list', '--porcelain']))
      .toContain(`branch refs/heads/${branch}`)
    expect(git(repoRoot, ['branch', '--list', branch]).trim()).not.toBe('')
  })

  it('keeps a no-change task retryable when its linked work cannot be reconciled', async () => {
    const taskId = '20260808_000000_024_user-no-change-retry'
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(finalMessageFile(paths, taskId),
      'No implementation is needed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')

    const onNoChange = vi.fn(async () => {
      expect(readStatus(paths, taskId)?.status).toBe('completed')
      expect(existsSync(worktree)).toBe(true)
      throw new Error('completion persistence unavailable')
    })
    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject,
      onNoChange,
    })).rejects.toThrow(
      'Could not reconcile the no-change verdict: completion persistence unavailable',
    )

    expect(onNoChange).toHaveBeenCalledOnce()
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('requires reconciliation before accepting a linked no-change task', async () => {
    const taskId = '20260808_000000_025_user-linked-no-change'
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(finalMessageFile(paths, taskId),
      'No implementation is needed.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 318,
      forge: { issueClosingCommitMessage: (message) => message },
    })).rejects.toThrow('A linked no-change task requires issue reconciliation.')

    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('completes a scan without commits and without recording a merge', async () => {
    const taskId = '20260808_000000_004_scan'
    const worktree = await makeCompletedTask(taskId)
    const initialHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    await expect(mergeTask(paths, taskId, { taskGate: 'light', project: stubProject }))
      .resolves.toEqual({ outcome: 'no-change' })

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(initialHead)
    expect(existsSync(worktree)).toBe(false)
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
    expect(readStatus(paths, taskId)?.merge_commit).toBeUndefined()
  })

  it('closes the linked issues of a commit-less inspection directly', async () => {
    const taskId = '20260808_000000_033_user-inspect-linked'
    mkdirSync(join(paths.queueDir, 'inspect'), { recursive: true })
    writeFileSync(join(paths.queueDir, 'inspect', taskId), '')
    // Work that landed after the inspection started: a no-op merge would leave HEAD here.
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(join(repoRoot, 'unrelated.txt'), 'earlier work\n')
    git(repoRoot, ['add', 'unrelated.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: unrelated earlier work'])
    const unrelatedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const forge = {
      issueClosingCommitMessage: (message: string, issue: number) => `${message} (closes #${issue})`,
    }

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 412, forge,
    })).rejects.toThrow('A linked no-change task requires issue reconciliation.')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expect(existsSync(worktree)).toBe(true)

    const onNoChange = vi.fn(async () => {
      expect(readStatus(paths, taskId)?.status).toBe('completed')
    })
    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, closesIssue: 412, forge, onNoChange,
    })).resolves.toEqual({ outcome: 'no-change' })

    expect(onNoChange).toHaveBeenCalledOnce()
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(unrelatedHead)
    expect(git(repoRoot, ['log', '--format=%s']).trim()).not.toContain('closes #412')
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', branchName(taskId)]).trim()).toBe('')
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
    expect(readStatus(paths, taskId)?.merge_commit).toBeUndefined()
  })

  it('refuses to record a merge that left the run branch where it was', async () => {
    const taskId = '20260808_000000_034_user-merge-without-commit'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string =>
        cwd === paths.repoRoot && args[0] === 'merge' && args[1] === '--quiet' ? '' : git(cwd, args),
    }

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, mergeRuntime,
    })).rejects.toThrow(`Merging ${branchName(taskId)} created no commit on main.`)

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(existsSync(worktree)).toBe(true)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
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

  it('rejects a successful explicit test that borrowed dependencies', async () => {
    const taskId = '20260808_000000_019_user-test-borrows-dependencies'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'fixture-dependency': '^1.0.0' },
    }, null, 2)}\n`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare an uninstalled test dependency'])
    const outputFile = join(repoRoot, 'merge-check.log')

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
      testCmd: 'node -e "process.exit(0)"',
    })).rejects.toThrow('Tests passed against borrowed dependencies. Aborting merge.')

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain('the worktree: passed on dependencies it does not have')
    expect(output).toContain('fixture-dependency')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('names the failing check and its exit status before aborting the merge', async () => {
    const taskId = '20260808_000000_032_user-reports-check-status'
    await makeCompletedTask(taskId, { commit: true })
    const outputFile = join(repoRoot, 'failing-check.log')
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'failing-check',
      mergeChecks: () => [
        { label: 'Passing check', cwd: '', command: 'node -e "process.exit(0)"' },
        { label: 'Crashing check', cwd: '', command: 'node -e "process.exit(3)"' },
      ],
    }

    await expect(mergeTask(paths, taskId, { taskGate: 'light', project, outputFile }))
      .rejects.toThrow('Tests failed. Aborting merge.')

    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain('=== Crashing check failed: exit status 3 ===')
    expect(output).not.toContain('Passing check failed')
    expect(readStatus(paths, taskId)?.status).toBe('completed')
  })

  it('reports an explicit test command exit status before aborting the merge', async () => {
    const taskId = '20260808_000000_033_user-reports-test-command-status'
    await makeCompletedTask(taskId, { commit: true })
    const outputFile = join(repoRoot, 'failing-test-command.log')

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project: stubProject, outputFile, testCmd: 'node -e "process.exit(2)"',
    })).rejects.toThrow('Tests failed. Aborting merge.')

    expect(readFileSync(outputFile, 'utf8')).toContain('=== Tests failed: exit status 2 ===')
  })
})

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
    await expect(failure).rejects.toThrow(`A merge conflict occurred while adopting ${branch}.`)
    expectNoTemporaryWorktree('.adopt-')
  })
})
