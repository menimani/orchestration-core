import type { OperatingSystem } from './adapters/os.ts'

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

export function removalFailureDetail(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer }).stderr
  const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr
  const message = detail?.trim() || (error instanceof Error ? error.message : String(error))
  return message.replaceAll(/\s+/g, ' ')
}

/** Remove a worktree with the long-path fallback required by Windows. */
export function removeWorktreeWithFallback(
  repoRoot: string,
  worktree: string,
  runtime: WorktreeRemovalRuntime,
): WorktreeRemovalResult {
  try {
    runtime.git(repoRoot, ['worktree', 'remove', worktree, '--force'])
    return {
      fallback: undefined, gitFailure: undefined, fallbackFailure: undefined,
      pruneFailure: undefined,
    }
  } catch (error) {
    const gitFailure = removalFailureDetail(error)
    const worktreePath = runtime.os.worktreePathFor(worktree)
    let fallbackFailure: string | undefined
    try {
      runtime.os.removeDirectory(worktreePath.removalPath)
    } catch (fallbackError) {
      fallbackFailure = removalFailureDetail(fallbackError)
    }

    let pruneFailure: string | undefined
    try {
      runtime.git(repoRoot, ['worktree', 'prune'])
    } catch (pruneError) {
      pruneFailure = removalFailureDetail(pruneError)
    }
    return { fallback: worktreePath.removalFallback, gitFailure, fallbackFailure, pruneFailure }
  }
}
