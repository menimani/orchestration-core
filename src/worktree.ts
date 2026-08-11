import { win32 } from 'node:path'

interface RemoveOptions {
  force?: boolean
  maxRetries?: number
  recursive?: boolean
}

export interface WorktreeRemovalRuntime {
  platform: NodeJS.Platform
  remove(path: string, options: RemoveOptions): void
  git(cwd: string, args: string[]): string
}

export interface WorktreeRemovalResult {
  fallback: 'windows-long-path' | 'direct' | undefined
  gitFailure: string | undefined
  fallbackFailure: string | undefined
}

function extendedLengthPath(path: string): string {
  const absolutePath = win32.resolve(path)
  if (absolutePath.startsWith('\\\\?\\')) return absolutePath
  if (absolutePath.startsWith('\\\\')) return `\\\\?\\UNC\\${absolutePath.slice(2)}`
  return `\\\\?\\${absolutePath}`
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
    return { fallback: undefined, gitFailure: undefined, fallbackFailure: undefined }
  } catch (error) {
    const gitFailure = removalFailureDetail(error)
    const fallback = runtime.platform === 'win32' ? 'windows-long-path' : 'direct'
    let fallbackFailure: string | undefined
    try {
      const removalPath = runtime.platform === 'win32' ? extendedLengthPath(worktree) : worktree
      const options = runtime.platform === 'win32'
        ? { recursive: true, force: true, maxRetries: 3 }
        : { recursive: true, force: true }
      runtime.remove(removalPath, options)
    } catch (fallbackError) {
      fallbackFailure = removalFailureDetail(fallbackError)
    }

    try {
      runtime.git(repoRoot, ['worktree', 'prune'])
    } catch {
      // Callers decide whether a failed metadata cleanup is fatal.
    }
    return { fallback, gitFailure, fallbackFailure }
  }
}
