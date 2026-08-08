import { execFileSync, execSync } from 'node:child_process'
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectAdapter } from './adapters/project.ts'
import { branchName, isInspectionTaskId, logFile, worktreeDir, type OrchPaths } from './paths.ts'
import { readStatus, writeStatus } from './status.ts'

export class MergeError extends Error {
  keepWorktree: boolean
  constructor(message: string, keepWorktree = true) {
    super(message)
    this.keepWorktree = keepWorktree
  }
}

export interface MergeOptions {
  /** Explicit test command; overrides the project's check selection. */
  testCmd?: string | undefined
  skipAutoTest?: boolean
  taskGate: 'full' | 'light'
  /** The repository's own knowledge: which checks verify a merge, and when. */
  project: ProjectAdapter
  /**
   * Issue this merge resolves. The reference rides the merge commit, so the forge
   * closes the issue when the promotion PR lands the commit on the default branch.
   */
  closesIssue?: number | undefined
  /**
   * When set, everything the merge prints — including test output — goes to this file
   * instead of stdout, so a loop's log stays readable and the details stay findable.
   */
  outputFile?: string | undefined
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  })
}

/**
 * Merge a completed task into the current branch. Ported from task-merge.sh:
 * uncommitted changes or a missing deliverable stop the merge and keep the worktree,
 * because removing it would lose work an agent forgot to commit.
 */
export async function mergeTask(paths: OrchPaths, taskId: string, options: MergeOptions): Promise<void> {
  const out = (text: string): void => {
    if (options.outputFile !== undefined) {
      appendFileSync(options.outputFile, `${text}\n`)
    } else {
      console.log(text)
    }
  }
  const run = (cwd: string, command: string): void => {
    if (options.outputFile !== undefined) {
      const result = execSync(command, {
        cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      })
      appendFileSync(options.outputFile, result)
    } else {
      execSync(command, { cwd, stdio: 'inherit', windowsHide: true })
    }
  }
  const tryRun = (cwd: string, command: string, label: string): boolean => {
    out(`=== ${label}: ${command} ===`)
    try {
      run(cwd, command)
      return true
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string }
      if (options.outputFile !== undefined) {
        appendFileSync(options.outputFile, `${failed.stdout ?? ''}${failed.stderr ?? ''}`)
      }
      return false
    }
  }

  const status = readStatus(paths, taskId)
  if (status === undefined) {
    throw new MergeError(`Task not found: ${taskId}`)
  }
  if (status.status !== 'completed') {
    throw new MergeError(`Task status is not 'completed' (current: ${status.status}).`)
  }

  const worktree = worktreeDir(paths, taskId)
  const branch = branchName(taskId)
  const currentBranch = git(paths.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()

  if (git(worktree, ['status', '--porcelain']).trim() !== '') {
    throw new MergeError(
      `The worktree has uncommitted changes: ${worktree}\n`
      + 'The runner may have forgotten to commit. Review the changes, commit them in the '
      + 'worktree if they belong, then retry the merge.',
    )
  }

  const newCommits = git(worktree, ['log', `${currentBranch}..HEAD`, '--oneline']).trim()
  if (!isInspectionTaskId(paths, taskId) && newCommits === '') {
    throw new MergeError(
      `${taskId} has no new commits relative to ${currentBranch}.\n`
      + `Check the log: ${logFile(paths, taskId)}\nThe worktree will be kept: ${worktree}`,
    )
  }

  out(`=== ${taskId} diff (against ${currentBranch}) ===`)
  try {
    out(git(worktree, ['diff', `${currentBranch}...HEAD`]))
  } catch {
    // an empty inspection diff is fine
  }

  if (options.testCmd !== undefined && options.testCmd !== '') {
    out(`=== Running tests in worktree: ${options.testCmd} ===`)
    try {
      run(worktree, options.testCmd)
    } catch {
      throw new MergeError('Tests failed. Aborting merge.')
    }
  } else if (options.skipAutoTest !== true) {
    const changed = git(worktree, ['diff', '--name-only', `${currentBranch}...HEAD`])
      .split(/\r?\n/).filter((line) => line !== '')
    let ok = true
    for (const check of options.project.mergeChecks(options.taskGate)) {
      if (check.appliesTo !== undefined && !check.appliesTo(changed)) continue
      if (check.requires !== undefined && !existsSync(join(worktree, check.requires))) continue
      if (check.unless !== undefined && existsSync(join(worktree, check.unless))) continue
      ok = tryRun(join(worktree, check.cwd), check.command, check.label) && ok
    }
    if (!ok) {
      throw new MergeError('Tests failed. Aborting merge.')
    }
  }

  const mergeMessage = options.closesIssue === undefined
    ? `Merge ${taskId} via Codex`
    : `Merge ${taskId} via Codex (closes #${options.closesIssue})`
  try {
    git(paths.repoRoot, ['merge', '--no-ff', branch, '-m', mergeMessage])
  } catch {
    try {
      git(paths.repoRoot, ['merge', '--abort'])
    } catch {
      // nothing to abort
    }
    throw new MergeError('A merge conflict occurred. Rebase the worktree, then retry the merge.')
  }

  // Removing the worktree is tidying, not part of the merge. On Windows a handle held
  // by an editor or a scanner makes the removal fail with EBUSY, and letting that abort
  // once left the merge in place while the task was recorded as failed.
  try {
    git(paths.repoRoot, ['worktree', 'remove', worktree, '--force'])
  } catch {
    try {
      rmSync(worktree, { recursive: true, force: true })
    } catch {
      out(`WARN: merged, but the worktree is still there and has to go by hand: ${worktree}`)
      try {
        git(paths.repoRoot, ['worktree', 'prune'])
      } catch {
        // best effort
      }
    }
  }
  try {
    git(paths.repoRoot, ['branch', '-d', branch])
  } catch {
    try {
      git(paths.repoRoot, ['branch', '-D', branch])
    } catch {
      // an inspection task's branch may already be gone
    }
  }
  await writeStatus(paths, taskId, 'merged')
  out(`Merged ${taskId} and removed the worktree.`)
}
