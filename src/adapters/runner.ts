// The runner adapter is the only place the orchestration invokes the coding agent.
// The contract that makes runners substitutable is the marker protocol, not the CLI:
// a runner receives a task specification and must write a final-message file whose
// last lines carry `TASK_COMPLETE` on its own line when the work is done, and may
// carry `NEXT_TASK: <description>` and `DECISION_REQUIRED: <text>` lines before it.
// Markers anywhere else (the transcript log) are ignored by the core. SPEC.md item 30.

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high'

export interface RunnerStartOptions {
  /** Absolute path of the worktree the runner works in. */
  worktree: string
  /** Absolute path of the task specification file (its content is the prompt). */
  specFile: string
  /** Absolute path the runner must write its final message to. */
  finalMessageFile: string
  /** Absolute path of the transcript log. */
  logFile: string
  effort: ReasoningEffort
  /** Runner-specific model override; undefined lets the runner CLI decide. */
  model?: string | undefined
}

export interface RunnerSharedSkillRenderOptions {
  repoRoot: string
  packageRoot: string
  commandPrefixPlaceholder: string
}

export interface RunnerSharedSkills {
  /** Absolute directory where this runner discovers repository-scoped skills. */
  destinationRoot(repoRoot: string): string
  /** Absolute former discovery directories whose generated skills may be migrated. */
  legacyRoots?(repoRoot: string): string[]
  /** Render a canonical shared-skill file into the runner's on-disk format. */
  renderFile(contents: Buffer, options: RunnerSharedSkillRenderOptions): Buffer
}

export interface Runner {
  /** Runner-specific repository skill discovery and rendering behavior. */
  sharedSkills: RunnerSharedSkills
  /** Start the agent process detached; resolve with its PID once spawned. */
  start(options: RunnerStartOptions): Promise<number>
}

export async function loadRunner(name: string): Promise<Runner> {
  switch (name) {
    case 'codex': {
      const mod = await import('./runner-codex.ts')
      return mod.createCodexRunner()
    }
    default:
      throw new Error(`Unknown RUNNER '${name}' (supported: codex)`)
  }
}
