import { execFileSync, execSync } from 'node:child_process'
import { appendFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { backendGateCmd, frontendGateCmd } from './gates.ts'
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
  /** Explicit test command; overrides path-based selection. */
  testCmd?: string | undefined
  skipAutoTest?: boolean
  taskGate: 'full' | 'light'
  /**
   * When set, everything the merge prints — including test output — goes to this file
   * instead of stdout, so a loop's log stays readable and the details stay findable.
   */
  outputFile?: string | undefined
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

/**
 * Choose pre-merge checks from the paths the worktree touched, ported from
 * task-merge.sh. The i18n check runs on either side of the translation contract,
 * because a backend-only change can still leave a user looking at a raw messageId.
 * The English check is repository-wide and cheap, so it runs whatever changed.
 */
export function selectChecks(changedFiles: string[]): {
  frontend: boolean
  backend: boolean
  orchestration: boolean
  i18n: boolean
} {
  return {
    frontend: changedFiles.some((file) => file.startsWith('src/frontend/')),
    backend: changedFiles.some((file) => file.startsWith('src/backend/')),
    orchestration: changedFiles.some((file) => file.startsWith('orchestration/')),
    i18n: changedFiles.some((file) =>
      /^src\/frontend\/src\/i18n\/|^src\/backend\/src\/main\/resources\/messages/.test(file)),
  }
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
      const result = execSync(command, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      appendFileSync(options.outputFile, result)
    } else {
      execSync(command, { cwd, stdio: 'inherit' })
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
    const checks = selectChecks(changed)
    let ok = true
    if (checks.frontend && existsSync(join(worktree, 'src', 'frontend'))) {
      ok = tryRun(join(worktree, 'src', 'frontend'), frontendGateCmd(options.taskGate), 'Frontend gate') && ok
    }
    if (checks.backend && existsSync(join(worktree, 'src', 'backend'))) {
      ok = tryRun(join(worktree, 'src', 'backend'), backendGateCmd(options.taskGate), 'Backend gate') && ok
    }
    if (checks.orchestration) {
      // The TS implementation carries its own gate; the bash test harness stays the
      // gate only while it is still in the tree.
      if (existsSync(join(worktree, 'orchestration', 'ts', 'package.json'))) {
        ok = tryRun(join(worktree, 'orchestration', 'ts'),
          'npm run typecheck && npm run test', 'Orchestration gate') && ok
      } else if (existsSync(join(worktree, 'orchestration', 'tests', 'run-all.sh'))) {
        ok = tryRun(worktree, 'bash orchestration/tests/run-all.sh', 'Orchestration tests') && ok
      }
    }
    if (checks.i18n && existsSync(join(worktree, 'checks', 'i18n-keys.js'))) {
      ok = tryRun(worktree, 'node checks/i18n-keys.js', 'Translation completeness') && ok
    }
    if (existsSync(join(worktree, 'checks', 'english-only.mjs'))) {
      ok = tryRun(worktree, 'node checks/english-only.mjs', 'English only') && ok
    }
    if (!ok) {
      throw new MergeError('Tests failed. Aborting merge.')
    }
  }

  try {
    git(paths.repoRoot, ['merge', '--no-ff', branch, '-m', `Merge ${taskId} via Codex`])
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
