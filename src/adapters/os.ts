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

/**
 * An agent is either a bare command name, resolved as the user's shell would resolve it
 * (an npm .cmd shim included), or the absolute path of an executable.
 */
export interface AgentLaunchOptions {
  args: readonly string[]
  cwd: string
  /** Read as the agent's standard input. */
  inputFile: string
  /** Receives the agent's standard output and error, appended after what it holds. */
  outputFile: string
  program: string
}

/** The spawn arguments that run an agent program with exactly the given arguments. */
export interface AgentCommand {
  args: string[]
  command: string
  /** Pass `args` to the command line unquoted; they are already escaped for it. */
  verbatimArguments: boolean
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

export interface TerminableSpawnOptions {
  detached: boolean
}

export interface OperatingSystem {
  /** User-facing label for the environment that exercised local verification. */
  verificationEnvironmentLabel(): string
  launchDaemon(options: DaemonLaunchOptions): Promise<DaemonProcess>
  /**
   * Start an agent that outlives this process and resolve with the PID whose tree
   * `terminateProcessTree` stops. Rejects when the agent could not be started.
   */
  launchAgent(options: AgentLaunchOptions): Promise<number>
  /** How to spawn an agent program as an attached child of this process. */
  agentCommand(program: string, args: readonly string[]): AgentCommand
  processTreeRootPid(env?: NodeJS.ProcessEnv): number
  /** Stable identity for this particular use of a PID, or undefined when unverifiable. */
  processStartIdentity(pid: number): string | undefined
  terminateProcessTree(pid: number): boolean
  /**
   * Spawn options that keep a child's tree reachable by `terminateProcessTree`. POSIX stops
   * a process group, so the child must lead one; Windows follows parent links instead.
   */
  terminableSpawnOptions(): TerminableSpawnOptions
  /**
   * Whether a process with this identifier is running. Detection asks about the process;
   * termination asks about its tree. Using the tree question to detect a recorded PID
   * answers "gone" for anything that is not a process-group leader, which on POSIX let a
   * second daemon start alongside a live foreign task.
   */
  processIsAlive(pid: number): boolean
  processTreeIsAlive(pid: number): boolean
  /**
   * Terminate the tree of every live process that names this worktree in its command line
   * or executable path, before the worktree is removed. A shell whose parent exited first
   * is outside the tree that stopping a runner reaches, and its open files block removal.
   * Best effort: a process that survives keeps holding the worktree, so removal fails.
   * Each holder whose tree this ends is reported once, as an event line through `report`.
   */
  terminateWorktreeProcesses(path: string, report: (line: string) => void): void
  removeDirectory(path: string): void
  worktreePathFor(path: string): WorktreePath
  /** Canonical value used when comparing environment variable names. */
  environmentNameKey(name: string): string
}

// Unlike the consumer-selected adapters, the operating system is a fact about this
// process. Detect it once and expose only the selected behavior.
const implementation = process.platform === 'win32'
  ? await import('./os-windows.ts')
  : await import('./os-posix.ts')

export const operatingSystem: OperatingSystem = implementation.createOperatingSystem()
