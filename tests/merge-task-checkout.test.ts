// Part of the mergeTask tests, kept apart from the other parts (tests/merge.test.ts,
// tests/merge-task-cleanup.test.ts, tests/merge-task-no-change.test.ts,
// tests/merge-task-gates.test.ts and tests/merge-task-dependencies.test.ts) so the parts
// run on separate workers. The describe name is the same, so reported test names do not
// change.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MergeError, MergeRecoveryError, mergeTask } from '../src/merge.ts'
import { branchName } from '../src/paths.ts'
import { readStatus } from '../src/status.ts'
import {
  expectNoTemporaryWorktree, git, makeCompletedTask, noCheckProject, paths, repoRoot,
} from './mergeHarness.ts'

describe('mergeTask', () => {
  it('stops when a failed local merge cannot prove that the worktree was restored', async () => {
    const taskId = '20260824_084607_019_auto-merge-recovery'
    await makeCompletedTask(taskId, { commit: true })
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
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
        if (args[0] === 'merge' && args[1] === '--abort') {
          throw new Error('abort failed')
        }
        return git(cwd, args)
      },
    }

    const failure = mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, mergeRuntime,
    })
    await expect(failure).rejects.toThrow(MergeRecoveryError)
    await expect(failure).rejects.toThrow('merge is still in progress; merge abort failed')

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expectNoTemporaryWorktree('.merge-')
  })

  it('refuses to merge into a checkout that already has a merge in progress', async () => {
    const taskId = '20260824_084607_020_auto-merge-in-progress'
    await makeCompletedTask(taskId, { commit: true })
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const mergeHead = git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'])
      .trim()
    writeFileSync(mergeHead, `${runHead}\n`)
    const mergeCommands: string[] = []
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string => {
        if (args[0] === 'merge' && cwd === repoRoot) mergeCommands.push(args[1]!)
        return git(cwd, args)
      },
    }

    const failure = mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, mergeRuntime,
    })
    await expect(failure).rejects.toThrow(MergeRecoveryError)
    await expect(failure).rejects.toThrow(
      'The integration worktree already has a merge in progress. '
      + 'Inspect and restore it before restarting orchestration.',
    )

    // Neither a merge nor an abort may touch the merge someone else left there.
    expect(mergeCommands).toEqual([])
    expect(readFileSync(mergeHead, 'utf8')).toBe(`${runHead}\n`)
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expectNoTemporaryWorktree('.merge-')
  })

  it('stops when the state after a failed local merge cannot be read', async () => {
    const taskId = '20260824_084607_021_auto-unreadable-merge'
    await makeCompletedTask(taskId, { commit: true })
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    let mergeFailed = false
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string => {
        if (args[0] === 'merge' && args[1] === '--quiet' && cwd === repoRoot) {
          mergeFailed = true
          throw new Error('merge was interrupted')
        }
        if (args[0] === 'merge' && args[1] === '--abort') return ''
        if (mergeFailed && args[0] === 'status') throw new Error('index is unreadable')
        return git(cwd, args)
      },
    }

    const failure = mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, mergeRuntime,
    })
    await expect(failure).rejects.toThrow(MergeRecoveryError)
    await expect(failure).rejects.toThrow(
      'A merge conflict occurred. Rebase the worktree, then retry the merge. '
      + 'Recovery could not be verified: index is unreadable; merge abort reported success. '
      + 'Merge failure: merge was interrupted. '
      + 'Inspect and restore the integration worktree before restarting orchestration.',
    )

    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expectNoTemporaryWorktree('.merge-')
  })

  it('refuses before the gate when an untracked file in the main checkout collides with the task', async () => {
    const taskId = '20260824_084607_022_auto-dirty-main-checkout'
    await makeCompletedTask(taskId, { commit: true })
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(repoRoot, `${taskId}.txt`), 'left in the main checkout\n')
    const mergeCommands: string[] = []
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string => {
        if (args[0] === 'merge') mergeCommands.push(cwd)
        return git(cwd, args)
      },
    }

    const failure = mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, mergeRuntime,
    })
    await expect(failure).rejects.toThrow(MergeError)
    await expect(failure).rejects.not.toThrow(MergeRecoveryError)
    await expect(failure).rejects.toThrow(
      `The main checkout has uncommitted or untracked changes the merge would overwrite: ${repoRoot}\n`
      + `${taskId}.txt\n`,
    )

    // The gate never ran: no merge was attempted, in a temporary worktree or the checkout.
    expect(mergeCommands).toEqual([])
    expect(readFileSync(join(repoRoot, `${taskId}.txt`), 'utf8')).toBe('left in the main checkout\n')
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expectNoTemporaryWorktree('.merge-')
  })

  it('reports git refusing the checkout merge instead of a conflict in the task', async () => {
    const taskId = '20260824_084607_023_auto-refused-main-merge'
    await makeCompletedTask(taskId, { commit: true })
    const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    const mergeRuntime = {
      git: (cwd: string, args: string[]): string => {
        // The file appears while the gate runs, after the check before it passed.
        if (args[0] === 'merge' && args[1] === '--quiet' && cwd !== repoRoot) {
          writeFileSync(join(repoRoot, `${taskId}.txt`), 'written during the gate\n')
        }
        return git(cwd, args)
      },
    }

    const failure = mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, mergeRuntime,
    })
    await expect(failure).rejects.toThrow(MergeError)
    await expect(failure).rejects.not.toThrow(MergeRecoveryError)
    await expect(failure).rejects.not.toThrow('A merge conflict occurred')
    await expect(failure).rejects.toThrow(
      `Git refused the merge into ${repoRoot} without a conflict; the checkout was left as it was. `
      + 'Merge failure: ',
    )
    await expect(failure).rejects.toThrow('would be overwritten by merge')

    expect(readFileSync(join(repoRoot, `${taskId}.txt`), 'utf8')).toBe('written during the gate\n')
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
    expect(readStatus(paths, taskId)?.status).toBe('completed')
    expectNoTemporaryWorktree('.merge-')
  })

  // Each row leaves the main checkout in one porcelain state and lets the task change a
  // path. The check must refuse exactly when git itself refuses the merge: a refusal is
  // confirmed by running the same merge with git, an acceptance by the merge landing.
  type IncomingChange = (worktree: string) => void
  const modifiesShared: IncomingChange = (worktree) => {
    writeFileSync(join(worktree, 'shared.txt'), 'changed by the task\n')
  }
  const deletesShared: IncomingChange = (worktree) => {
    rmSync(join(worktree, 'shared.txt'))
  }
  const addsFile: IncomingChange = (worktree) => {
    writeFileSync(join(worktree, 'added.txt'), 'added by the task\n')
  }
  const addsDirectory: IncomingChange = (worktree) => {
    mkdirSync(join(worktree, 'added'))
    writeFileSync(join(worktree, 'added', 'inner.txt'), 'added by the task\n')
  }
  const addsFileNamedAdded: IncomingChange = (worktree) => {
    writeFileSync(join(worktree, 'added'), 'added by the task\n')
  }
  const checkoutStates: [string, string, IncomingChange, () => void, boolean][] = [
    ['an unstaged modification of a changed file', ' M', modifiesShared, () => {
      writeFileSync(join(repoRoot, 'shared.txt'), 'local edit\n')
    }, true],
    ['a staged modification of a changed file', 'M ', modifiesShared, () => {
      writeFileSync(join(repoRoot, 'shared.txt'), 'local edit\n')
      git(repoRoot, ['add', 'shared.txt'])
    }, true],
    ['an unstaged deletion of a changed file', ' D', modifiesShared, () => {
      rmSync(join(repoRoot, 'shared.txt'))
    }, false],
    ['a staged deletion of a changed file', 'D ', modifiesShared, () => {
      git(repoRoot, ['rm', '-q', 'shared.txt'])
    }, true],
    ['an unstaged deletion of a deleted file', ' D', deletesShared, () => {
      rmSync(join(repoRoot, 'shared.txt'))
    }, false],
    ['an unstaged modification of a deleted file', ' M', deletesShared, () => {
      writeFileSync(join(repoRoot, 'shared.txt'), 'local edit\n')
    }, true],
    ['an untracked file in the way of an added one', '??', addsFile, () => {
      writeFileSync(join(repoRoot, 'added.txt'), 'local file\n')
    }, true],
    ['an identical untracked file in the way of an added one', '??', addsFile, () => {
      writeFileSync(join(repoRoot, 'added.txt'), 'added by the task\n')
    }, true],
    ['a staged addition of an added file', 'A ', addsFile, () => {
      writeFileSync(join(repoRoot, 'added.txt'), 'local file\n')
      git(repoRoot, ['add', 'added.txt'])
    }, true],
    ['an intent-to-add entry for an added file', ' A', addsFile, () => {
      writeFileSync(join(repoRoot, 'added.txt'), 'local file\n')
      git(repoRoot, ['add', '-N', 'added.txt'])
    }, true],
    ['an untracked file where the task adds a directory', '??', addsDirectory, () => {
      writeFileSync(join(repoRoot, 'added'), 'local file\n')
    }, true],
    ['an untracked file inside a directory the task adds as a file', '??', addsFileNamedAdded, () => {
      mkdirSync(join(repoRoot, 'added'))
      writeFileSync(join(repoRoot, 'added', 'local.txt'), 'local file\n')
    }, true],
    ['an untracked file beside one the task adds', '??', addsDirectory, () => {
      mkdirSync(join(repoRoot, 'added'))
      writeFileSync(join(repoRoot, 'added', 'local.txt'), 'local file\n')
    }, false],
    ['an unstaged modification elsewhere', ' M', modifiesShared, () => {
      writeFileSync(join(repoRoot, 'other.txt'), 'local edit\n')
    }, false],
    ['an unstaged deletion elsewhere', ' D', modifiesShared, () => {
      rmSync(join(repoRoot, 'other.txt'))
    }, false],
    ['an untracked file elsewhere', '??', modifiesShared, () => {
      writeFileSync(join(repoRoot, 'local.txt'), 'local file\n')
    }, false],
    ['a staged modification elsewhere', 'M ', modifiesShared, () => {
      writeFileSync(join(repoRoot, 'other.txt'), 'local edit\n')
      git(repoRoot, ['add', 'other.txt'])
    }, true],
    ['an intent-to-add entry elsewhere', ' A', modifiesShared, () => {
      writeFileSync(join(repoRoot, 'local.txt'), 'local file\n')
      git(repoRoot, ['add', '-N', 'local.txt'])
    }, true],
  ]

  it.each(checkoutStates.map((row, index) => [...row, index] as const))(
    'decides the checkout merge as git does for %s (%s)',
    async (_name, porcelain, incoming, leaveCheckoutState, refused, index) => {
      const taskId = `20260824_084607_${String(100 + index)}_auto-checkout-state`
      writeFileSync(join(repoRoot, 'shared.txt'), 'shared\n')
      writeFileSync(join(repoRoot, 'other.txt'), 'other\n')
      git(repoRoot, ['add', 'shared.txt', 'other.txt'])
      git(repoRoot, ['commit', '-qm', 'chore: add shared files'])
      const worktree = await makeCompletedTask(taskId)
      incoming(worktree)
      git(worktree, ['add', '-A'])
      git(worktree, ['commit', '-qm', 'feat: change the shared files'])
      leaveCheckoutState()
      const status = git(repoRoot, ['status', '--porcelain', '--untracked-files=all'])
      expect(status.split('\n').map((line) => line.slice(0, 2))).toContain(porcelain)
      const runHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()

      const result = mergeTask(paths, taskId, { taskGate: 'light', project: noCheckProject })

      if (!refused) {
        await expect(result).resolves.toMatchObject({ outcome: 'merged' })
        expect(git(repoRoot, ['rev-parse', 'HEAD^1']).trim()).toBe(runHead)
        expect(git(repoRoot, ['log', '-1', '--format=%s', 'HEAD^2']).trim())
          .toBe('feat: change the shared files')
        expect(readStatus(paths, taskId)?.status).toBe('merged')
        return
      }
      await expect(result).rejects.toThrow(MergeError)
      await expect(result).rejects.toThrow(
        `The main checkout has uncommitted or untracked changes the merge would overwrite: ${repoRoot}\n`,
      )
      expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
      expect(git(repoRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe(status)
      expect(readStatus(paths, taskId)?.status).toBe('completed')
      expectNoTemporaryWorktree('.merge-')
      // Git refuses the same merge in the same state, without starting it.
      expect(() => git(repoRoot, ['merge', '--quiet', '--no-ff', branchName(taskId), '-m', 'probe']))
        .toThrow()
      expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(runHead)
      expect(git(repoRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe(status)
    },
  )
})
