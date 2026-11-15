import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { operatingSystem } from '../src/adapters/os.ts'
import {
  inTemporaryWorktree, MergeRecoveryError, mergeTask, removeMergedWorktree,
  removeTemporaryWorktree, TestLockBusyError,
} from '../src/merge.ts'
import { branchName, orchPaths, worktreeDir } from '../src/paths.ts'
import { readStatus, writeMergedStatus, writeStatus } from '../src/status.ts'
import { specFile } from '../src/tasks.ts'
import { removeWorktreeWithFallback } from '../src/worktree.ts'
import {
  failedWorktreeRemovalRuntime, git, makeCompletedTask, noCheckProject, paths,
  posixOperatingSystem, repoRoot, windowsOperatingSystem,
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

  it('withholds the details of an imported security requirement', async () => {
    const taskId = '20260808_000000_030_user-imported-security-reason'
    await makeCompletedTask(taskId, { commit: true })

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      reasons: [[
        '> [SECURITY] The token check in `src/auth.ts` accepts an empty signature',
        'Imported from issue 7 of acme/widget, opened by octo.',
        '> The signature is compared only when present.\n>\n> Details follow.',
      ].join('\n\n')],
    })

    expect(git(repoRoot, ['log', '-1', '--format=%b']).trim())
      .toBe('Why: security fix; details withheld.')
  })

  it('records an imported requirement title without its quote marker', async () => {
    const taskId = '20260808_000000_031_user-imported-reason'
    await makeCompletedTask(taskId, { commit: true })

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      reasons: [[
        '> [BUG] Drop the duplicate retry in `src/fetch.ts`',
        'Imported from issue 8 of acme/widget, opened by octo.',
        '> It doubles every timeout.',
      ].join('\n\n')],
    })

    expect(git(repoRoot, ['log', '-1', '--format=%b']).trim())
      .toBe('Why: [BUG] Drop the duplicate retry in `src/fetch.ts`')
  })

})
