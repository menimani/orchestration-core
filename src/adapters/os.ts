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

export interface DaemonLaunchOptions {
  args: readonly string[]
  command: string
  cwd: string
  env?: NodeJS.ProcessEnv
  outputFile: string
}

export interface DaemonProcess {
  pid: number
  isAlive(): boolean
  terminate(): void
  release(): void
  onError(listener: (error: Error) => void): void
  offError(listener: (error: Error) => void): void
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  offExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
}

export interface OperatingSystem {
  launchDaemon(options: DaemonLaunchOptions): Promise<DaemonProcess>
  processTreeRootPid(env?: NodeJS.ProcessEnv): number
  /** Stable identity for this particular use of a PID, or undefined when unverifiable. */
  processStartIdentity(pid: number): string | undefined
  terminateProcessTree(pid: number): boolean
  /**
   * Whether a process with this identifier is running. Detection asks about the process;
   * termination asks about its tree. Using the tree question to detect a recorded PID
   * answers "gone" for anything that is not a process-group leader, which on POSIX let a
   * second daemon start alongside a live foreign task.
   */
  processIsAlive(pid: number): boolean
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
