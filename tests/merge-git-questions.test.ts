// Counts the git processes one merge step starts, so that a question the step has already
// answered is not asked again: the task's commits when no rebase rewrote them, and the
// checkout's HEAD the merge verification reads right after the step read it.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mergeRemoteTask, mergeTask } from '../src/merge.ts'
import { readStatus } from '../src/status.ts'
import { git, makeCompletedTask, noCheckProject, paths, repoRoot } from './mergeHarness.ts'

// Records the git processes started while a test asks for them.
const gitProcesses = vi.hoisted(() => ({
  recording: false,
  started: [] as { cwd: string, argv: string[] }[],
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = ((...args: Parameters<typeof actual.execFileSync>) => {
    const [file, gitArgs, options] = args
    if (gitProcesses.recording && file === 'git' && Array.isArray(gitArgs)) {
      const cwd = (options as { cwd?: unknown } | undefined)?.cwd
      gitProcesses.started.push({ cwd: typeof cwd === 'string' ? cwd : '', argv: [...gitArgs] })
    }
    return actual.execFileSync(...args)
  }) as typeof actual.execFileSync
  return { ...actual, execFileSync }
})

async function recordedGit<T>(step: () => Promise<T>): Promise<{
  answer: T
  started: { cwd: string, argv: string[] }[]
}> {
  gitProcesses.started = []
  gitProcesses.recording = true
  try {
    return { answer: await step(), started: gitProcesses.started }
  } finally {
    gitProcesses.recording = false
  }
}

function asked(started: { cwd: string, argv: string[] }[], cwd: string, argv: string[]): number {
  return started.filter((process) =>
    process.cwd === cwd && JSON.stringify(process.argv) === JSON.stringify(argv)).length
}

// The git processes of a step, without the one `removeWorktreeWithFallback` adds only when
// `git worktree remove --force` fails and the directory fallback runs, which on Windows
// happens whenever something briefly holds a file in the worktree. Every other process
// still counts, so a question the step did not ask before still changes the total.
function stepProcesses(started: { cwd: string, argv: string[] }[]): number {
  return started.filter((process) =>
    JSON.stringify(process.argv) !== JSON.stringify(['worktree', 'prune'])).length
}

function commitOnMain(file: string): string {
  writeFileSync(join(repoRoot, file), `${file}\n`)
  git(repoRoot, ['add', file])
  git(repoRoot, ['commit', '-qm', `chore: add ${file}`])
  return git(repoRoot, ['rev-parse', 'HEAD']).trim()
}

describe('git questions of one merge step', () => {
  it('reads the task commits once when no rebase rewrote them', async () => {
    const taskId = '20261115_120000_001_auto-git-questions-no-rebase'
    const worktree = await makeCompletedTask(taskId, { commit: true })

    const { answer, started } = await recordedGit(() => mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    }))

    expect(answer.outcome).toBe('merged')
    expect(asked(started, worktree, ['rev-list', '--reverse', 'main..HEAD'])).toBe(1)
    // Before, the commits and each commit's trees were read twice: 35 processes. Two
    // more questions since pin the gate's base: resolving it once, and confirming the
    // checkout is still on its branch before the merge lands there.
    expect(stepProcesses(started)).toBe(33)
  })

  it('reads the task commits again after a moved run branch made it rebase', async () => {
    const taskId = '20261115_120000_002_auto-git-questions-rebase'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const runTip = commitOnMain('later-work.txt')

    const { answer, started } = await recordedGit(() => mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    }))

    expect(answer.outcome).toBe('merged')
    expect(asked(started, worktree, ['rev-list', '--reverse', 'main..HEAD'])).toBe(2)
    // Before, the checkout HEAD was read twice: 37 processes. The two questions that pin
    // the gate's base add two.
    expect(stepProcesses(started)).toBe(38)
    const mergeCommit = answer.outcome === 'merged' ? answer.mergeCommit : ''
    expect(git(repoRoot, ['rev-parse', `${mergeCommit}^2^`]).trim()).toBe(runTip)
  })

  it('completes a task its rebase emptied, as the second read after the rebase finds', async () => {
    const taskId = '20261115_120000_003_auto-git-questions-emptied'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    // The same change lands on the run branch first, so the rebase drops it to empty.
    writeFileSync(join(repoRoot, `${taskId}.txt`), 'work\n')
    git(repoRoot, ['add', `${taskId}.txt`])
    git(repoRoot, ['commit', '-qm', 'feat: land the same work on the run branch'])

    const { answer, started } = await recordedGit(() => mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    }))

    expect(answer.outcome).toBe('no-change')
    expect(asked(started, worktree, ['rev-list', '--reverse', 'main..HEAD'])).toBe(2)
    expect(readStatus(paths, taskId)?.status).toBe('no-change')
  })

  it('reads the checkout HEAD once before its merge and sees a HEAD moved since the last step', async () => {
    const firstTask = '20261115_120000_004_auto-git-questions-first'
    const secondTask = '20261115_120000_005_auto-git-questions-second'
    await makeCompletedTask(firstTask, { commit: true })
    await makeCompletedTask(secondTask, { commit: true })

    const first = await recordedGit(() => mergeTask(paths, firstTask, {
      taskGate: 'light', project: noCheckProject,
    }))
    // Between the two steps the run branch moves outside the loop as well.
    const movedHead = commitOnMain('moved-between-steps.txt')
    const second = await recordedGit(() => mergeTask(paths, secondTask, {
      taskGate: 'light', project: noCheckProject,
    }))

    // One read before the merge and one of the merge commit after it.
    expect(asked(first.started, repoRoot, ['rev-parse', 'HEAD'])).toBe(2)
    expect(asked(second.started, repoRoot, ['rev-parse', 'HEAD'])).toBe(2)
    const firstMerge = first.answer.outcome === 'merged' ? first.answer.mergeCommit : ''
    const secondMerge = second.answer.outcome === 'merged' ? second.answer.mergeCommit : ''
    expect(git(repoRoot, ['rev-parse', `${firstMerge}^1`]).trim()).not.toBe(movedHead)
    expect(git(repoRoot, ['rev-parse', `${secondMerge}^1`]).trim()).toBe(movedHead)
  })

  it('reads the checkout HEAD once before adopting a remote branch', async () => {
    const branch = 'task/git-questions-remote'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'remote-task.txt'), 'remote work\n')
    git(repoRoot, ['add', 'remote-task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    const { answer, started } = await recordedGit(() => mergeRemoteTask(
      paths, 230, 'origin', branch, expectedHead, {
        taskGate: 'light', project: noCheckProject,
        forge: { issueClosingCommitMessage: (message) => message },
      },
    ))

    expect(asked(started, repoRoot, ['rev-parse', 'HEAD'])).toBe(2)
    // Before, the checkout HEAD was read twice: 20 processes. The two questions that pin
    // the gate's base add two.
    expect(stepProcesses(started)).toBe(21)
    expect(git(repoRoot, ['rev-parse', `${answer}^1`]).trim()).toBe(headBefore)
    expect(git(repoRoot, ['rev-parse', `${answer}^2`]).trim()).toBe(expectedHead)
  })
})
