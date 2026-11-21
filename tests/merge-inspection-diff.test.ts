// A merge prints the diff it gates under a `=== <task> diff ===` header. When that
// inspection diff fails, the log must say so rather than show the header over nothing,
// which reads as an empty change.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mergeRemoteTask, mergeTask } from '../src/merge.ts'
import { git, makeCompletedTask, noCheckProject, paths, repoRoot } from './mergeHarness.ts'

// Fails the inspection diff, `git diff <base>...HEAD`, while a test asks for it.
const inspectionDiff = vi.hoisted(() => ({ failing: false }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = ((...args: Parameters<typeof actual.execFileSync>) => {
    const [file, gitArgs] = args
    if (inspectionDiff.failing && file === 'git' && Array.isArray(gitArgs)
      && gitArgs.length === 2 && gitArgs[0] === 'diff' && String(gitArgs[1]).endsWith('...HEAD')) {
      throw new Error('stdout maxBuffer length exceeded')
    }
    return actual.execFileSync(...args)
  }) as typeof actual.execFileSync
  return { ...actual, execFileSync }
})

async function withFailingInspectionDiff<T>(step: () => Promise<T>): Promise<T> {
  inspectionDiff.failing = true
  try {
    return await step()
  } finally {
    inspectionDiff.failing = false
  }
}

describe('inspection diff of a merge', () => {
  it('reports why a local task diff is unavailable', async () => {
    const taskId = '20261120_120000_001_auto-inspection-diff-local'
    await makeCompletedTask(taskId, { commit: true })
    const outputFile = join(repoRoot, 'inspection-local.log')

    const answer = await withFailingInspectionDiff(() => mergeTask(paths, taskId, {
      taskGate: 'light', project: noCheckProject, outputFile,
    }))

    expect(answer.outcome).toBe('merged')
    expect(readFileSync(outputFile, 'utf8')).toContain(
      `=== ${taskId} diff (against main) ===\n(diff unavailable: stdout maxBuffer length exceeded)\n`,
    )
  })

  it('reports why a remote task diff is unavailable', async () => {
    const branch = 'task/inspection-diff-remote'
    git(repoRoot, ['switch', '-qc', branch])
    writeFileSync(join(repoRoot, 'remote-task.txt'), 'remote work\n')
    git(repoRoot, ['add', 'remote-task.txt'])
    git(repoRoot, ['commit', '-qm', 'feat: add remote work'])
    const expectedHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
    git(repoRoot, ['switch', '-q', 'main'])
    git(repoRoot, ['update-ref', `refs/remotes/origin/${branch}`, expectedHead])
    const outputFile = join(repoRoot, 'inspection-remote.log')

    const mergeCommit = await withFailingInspectionDiff(() => mergeRemoteTask(
      paths, 231, 'origin', branch, expectedHead, {
        taskGate: 'light', project: noCheckProject, outputFile,
        forge: { issueClosingCommitMessage: (message) => message },
      },
    ))

    expect(git(repoRoot, ['rev-parse', `${mergeCommit}^2`]).trim()).toBe(expectedHead)
    expect(readFileSync(outputFile, 'utf8')).toMatch(
      /=== \S+ diff \(against main\) ===\n\(diff unavailable: stdout maxBuffer length exceeded\)\n/,
    )
  })
})
