// Questions the core used to ask git in consecutive processes and now asks in one: a
// task commit's tree together with its parent's, and the daemon checkout's branch
// together with its HEAD. Each combined read must answer, and fail, exactly as the
// separate questions did, and must start one process where they started two.

import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { prepareBranchTopology } from '../src/branchTopology.ts'
import { mergeTask } from '../src/merge.ts'
import { branchName } from '../src/paths.ts'
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

async function recordedGit<T>(step: () => T | Promise<T>): Promise<{
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

// The processes that asked for a tree, whatever else they asked.
function treeQuestions(started: { cwd: string, argv: string[] }[], cwd: string): string[][] {
  return started
    .filter((process) => process.cwd === cwd && process.argv[0] === 'rev-parse'
      && process.argv.some((argument) => argument.endsWith('^{tree}')))
    .map((process) => process.argv)
}

function commitIn(worktree: string, file: string, message: string): string {
  writeFileSync(join(worktree, file), `${file}\n`)
  git(worktree, ['add', file])
  git(worktree, ['commit', '-qm', message])
  return git(worktree, ['rev-parse', 'HEAD']).trim()
}

function emptyCommitIn(worktree: string, message: string): string {
  git(worktree, ['commit', '--allow-empty', '-qm', message])
  return git(worktree, ['rev-parse', 'HEAD']).trim()
}

describe('a task commit tree and its parent tree, read together', () => {
  it('finds a commit whose tree equals its parent tree empty', async () => {
    const taskId = '20261120_120000_001_auto-batching-empty-commit'
    const worktree = await makeCompletedTask(taskId)
    const commit = emptyCommitIn(worktree, 'chore: change nothing')

    const { answer, started } = await recordedGit(() => mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    }).then(() => 'merged', (error: Error) => error.message))

    expect(answer).toContain(`${taskId} has only empty commits relative to main.`)
    // One process printed both trees, where two processes each printed one.
    expect(treeQuestions(started, worktree)).toEqual([
      ['rev-parse', `${commit}^{tree}`, `${commit}^1^{tree}`],
    ])
  })

  it('finds a commit whose tree differs from its parent tree a change', async () => {
    const taskId = '20261120_120000_002_auto-batching-changed-commit'
    const worktree = await makeCompletedTask(taskId)
    const commit = commitIn(worktree, 'changed.txt', 'feat: change a file')

    const { answer, started } = await recordedGit(() => mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    }))

    expect(answer.outcome).toBe('merged')
    expect(treeQuestions(started, worktree)).toEqual([
      ['rev-parse', `${commit}^{tree}`, `${commit}^1^{tree}`],
    ])
    expect(asked(started, worktree, ['rev-parse', `${commit}^{tree}`])).toBe(0)
    expect(asked(started, worktree, ['rev-parse', `${commit}^1^{tree}`])).toBe(0)
  })

  it('asks one process per commit and stops at the first commit with a change', async () => {
    const taskId = '20261120_120000_003_auto-batching-several-commits'
    const worktree = await makeCompletedTask(taskId)
    const empty = emptyCommitIn(worktree, 'chore: change nothing yet')
    const changed = commitIn(worktree, 'first.txt', 'feat: first change')
    commitIn(worktree, 'second.txt', 'feat: second change')

    const { answer, started } = await recordedGit(() => mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    }))

    expect(answer.outcome).toBe('merged')
    expect(treeQuestions(started, worktree)).toEqual([
      ['rev-parse', `${empty}^{tree}`, `${empty}^1^{tree}`],
      ['rev-parse', `${changed}^{tree}`, `${changed}^1^{tree}`],
    ])
  })

  it('fails for a commit without a parent, as the separate parent question did', async () => {
    const taskId = '20261120_120000_004_auto-batching-root-commit'
    const worktree = await makeCompletedTask(taskId)
    git(worktree, ['switch', '-q', '--orphan', 'unrelated-history'])
    const root = commitIn(worktree, 'unrelated.txt', 'feat: start unrelated history')
    git(worktree, ['switch', '-q', '-C', branchName(taskId)])
    const headBefore = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    const { answer, started } = await recordedGit(() => mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject,
    }).then(() => 'merged', (error: Error) => error.message))

    expect(answer).toContain(`Command failed: git rev-parse ${root}^{tree} ${root}^1^{tree}`)
    expect(treeQuestions(started, worktree)).toHaveLength(1)
    expect(git(repoRoot, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
  })
})

describe('the daemon checkout branch and HEAD, read together', () => {
  // The run's own state lives under orchestration/ in this fixture; excluded, it leaves
  // the daemon checkout clean.
  function daemonCheckout(): void {
    appendFileSync(join(repoRoot, '.git', 'info', 'exclude'), '\norchestration/\n')
    git(repoRoot, ['switch', '-qc', 'daemon/run'])
  }

  const combined = ['rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD']

  it('reads a branch with a commit in one process, then validates it in one more', async () => {
    daemonCheckout()
    const head = git(repoRoot, ['rev-parse', 'HEAD']).trim()

    const prepared = await recordedGit(() => prepareBranchTopology(paths, 'integration/run'))

    expect(prepared.answer.daemonHead).toBe(head)
    expect(asked(prepared.started, repoRoot, combined)).toBe(2)
    expect(asked(prepared.started, repoRoot, ['branch', '--show-current'])).toBe(0)
    expect(asked(prepared.started, repoRoot, ['rev-parse', 'HEAD'])).toBe(0)

    const validated = await recordedGit(() => prepared.answer.validateDaemonCheckout())

    expect(validated.answer).toBeUndefined()
    // The branch and HEAD in one process, then the status: two processes, where three
    // asked before.
    expect(validated.started).toEqual([
      { cwd: repoRoot, argv: combined },
      { cwd: repoRoot, argv: ['status', '--porcelain'] },
    ])
  })

  it('names no branch for a detached HEAD', async () => {
    daemonCheckout()
    const topology = prepareBranchTopology(paths, 'integration/run')
    git(repoRoot, ['checkout', '-q', '--detach'])

    const { answer, started } = await recordedGit(() => topology.validateDaemonCheckout())

    expect(answer).toBe('daemon checkout  does not match fixed branch daemon/run')
    expect(started).toEqual([{ cwd: repoRoot, argv: combined }])
    expect(() => prepareBranchTopology(paths, 'integration/run'))
      .toThrow('The daemon checkout must be on a branch.')
  })

  it('names the branch HEAD moved on from the commit the run was fixed to', async () => {
    daemonCheckout()
    const topology = prepareBranchTopology(paths, 'integration/run')
    const fixed = topology.daemonHead
    const moved = commitIn(repoRoot, 'moved.txt', 'feat: move the daemon branch')

    const { answer, started } = await recordedGit(() => topology.validateDaemonCheckout())

    expect(answer).toBe(
      `daemon branch daemon/run moved from fixed commit ${fixed.slice(0, 8)} to ${moved.slice(0, 8)}`,
    )
    expect(started).toEqual([{ cwd: repoRoot, argv: combined }])
  })

  it('names an unborn branch, which has no HEAD commit, as the separate questions did', async () => {
    daemonCheckout()
    const topology = prepareBranchTopology(paths, 'integration/run')
    git(repoRoot, ['switch', '-q', '--orphan', 'unborn/run'])

    const { answer, started } = await recordedGit(() => topology.validateDaemonCheckout())

    expect(answer).toBe('daemon checkout unborn/run does not match fixed branch daemon/run')
    expect(started).toEqual([
      { cwd: repoRoot, argv: combined },
      { cwd: repoRoot, argv: ['branch', '--show-current'] },
    ])
  })

  it('fails to read the HEAD of an unborn branch at startup, as the separate question did', () => {
    daemonCheckout()
    git(repoRoot, ['switch', '-q', '--orphan', 'unborn/run'])

    expect(() => prepareBranchTopology(paths, 'integration/run'))
      .toThrow('Command failed: git rev-parse HEAD')
  })

  it('fails for a HEAD outside refs/heads, as the separate branch question did', async () => {
    daemonCheckout()
    const topology = prepareBranchTopology(paths, 'integration/run')
    git(repoRoot, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/remotes/origin/main'])

    expect(() => topology.validateDaemonCheckout())
      .toThrow('Command failed: git branch --show-current')
    expect(() => prepareBranchTopology(paths, 'integration/run'))
      .toThrow('Command failed: git branch --show-current')
  })
})
