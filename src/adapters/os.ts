// The operating-system adapter contains the behavior that cannot be verified without
// running on that operating system. Callers use intent-level operations and never
// inspect which implementation was selected.

export interface WorktreePath {
  /** Canonical value used when comparing Git's worktree paths. */
  comparisonKey: string
  /** Path form used by the direct-removal fallback. */
  removalPath: string
  /** Existing user-facing description of that fallback. */
  removalFallback: string
  /** Existing user-facing command for finding a process that holds the worktree. */
  holderHint: string
}

export interface OperatingSystem {
  terminateProcessTree(pid: number): boolean
  processTreeIsAlive(pid: number): boolean
  removeDirectory(path: string): void
  worktreePathFor(path: string): WorktreePath
}

// Unlike the consumer-selected adapters, the operating system is a fact about this
// process. Detect it once and expose only the selected behavior.
const implementation = process.platform === 'win32'
  ? await import('./os-windows.ts')
  : await import('./os-posix.ts')

export const operatingSystem: OperatingSystem = implementation.createOperatingSystem()
