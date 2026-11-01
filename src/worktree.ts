import type { OperatingSystem } from './adapters/os.ts'
import { commandFailureSummary } from './errorText.ts'
import { canonicalPath } from './paths.ts'

export interface WorktreeRemovalRuntime {
  os: OperatingSystem
  git(cwd: string, args: string[]): string
}

export interface WorktreeRemovalResult {
  fallback: string | undefined
  gitFailure: string | undefined
  fallbackFailure: string | undefined
  pruneFailure: string | undefined
}

/**
 * Remove a worktree with the long-path fallback required by Windows, after ending the
 * processes still running inside it that stopping the task's runner did not reach.
 * Each process ended that way is reported through `report`.
 */
export function removeWorktreeWithFallback(
  repoRoot: string,
  worktree: string,
  runtime: WorktreeRemovalRuntime,
  report: (line: string) => void,
): WorktreeRemovalResult {
  runtime.os.terminateWorktreeProcesses(worktree, report)
  try {
    runtime.git(repoRoot, ['worktree', 'remove', worktree, '--force'])
    return {
      fallback: undefined, gitFailure: undefined, fallbackFailure: undefined,
      pruneFailure: undefined,
    }
  } catch (error) {
    const gitFailure = commandFailureSummary(error)
    const worktreePath = runtime.os.worktreePathFor(worktree)
    let fallbackFailure: string | undefined
    try {
      runtime.os.removeDirectory(worktreePath.removalPath)
    } catch (fallbackError) {
      fallbackFailure = commandFailureSummary(fallbackError)
    }

    let pruneFailure: string | undefined
    try {
      runtime.git(repoRoot, ['worktree', 'prune'])
    } catch (pruneError) {
      pruneFailure = commandFailureSummary(pruneError)
    }
    return { fallback: worktreePath.removalFallback, gitFailure, fallbackFailure, pruneFailure }
  }
}

/**
 * Whether `git worktree list --porcelain -z` output still registers the worktree. Git
 * lists each worktree by its realpath, while the loop spells the path from its own root,
 * which may run through a symlink, a junction or a Windows short name. Both sides are
 * canonicalized before the platform key compares them; otherwise a registration that
 * outlived its removal would go unnoticed.
 */
export function worktreeListIncludes(
  os: OperatingSystem,
  listing: string,
  worktree: string,
): boolean {
  const listed = listing.split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length))
  if (listed.length === 0) return false
  const key = (path: string) => os.worktreePathFor(canonicalPath(path)).comparisonKey
  const target = key(worktree)
  return listed.some((path) => key(path) === target)
}
