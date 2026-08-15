// The runner adapter is the only place the orchestration invokes the coding agent.
// The contract that makes runners substitutable is the marker protocol, not the CLI:
// a runner receives a task specification and must write a final-message file whose
// last lines carry `TASK_COMPLETE` on its own line when the work is done, and may
// carry `NO_CHANGE_WARRANTED`, `NEXT_TASK: <description>`, and
// `DECISION_REQUIRED: <text>` lines before it.
// Markers anywhere else (the transcript log) are ignored by the core. SPEC.md item 30.

import type { SharedSkillRenderOptions, SharedSkillsAdapter } from './shared-skills.ts'

export type { SharedSkillRenderOptions, SharedSkillsAdapter } from './shared-skills.ts'

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

export type RunnerSharedSkillRenderOptions = SharedSkillRenderOptions
export type RunnerSharedSkills = SharedSkillsAdapter

export interface Runner {
  /** Runner-specific repository skill discovery and rendering behavior. */
  sharedSkills: RunnerSharedSkills
  /** Start the agent process detached; resolve with its PID once spawned. */
  start(options: RunnerStartOptions): Promise<number>
}

export interface RunnerLoadOptions {
  runnerClaudeModel?: string | undefined
  runnerClaudeModelMinimal?: string | undefined
  runnerClaudeModelLow?: string | undefined
  runnerClaudeModelMedium?: string | undefined
  runnerClaudeModelHigh?: string | undefined
}

export async function loadRunner(
  name: string,
  options: RunnerLoadOptions = {},
): Promise<Runner> {
  switch (name) {
    case 'codex': {
      const mod = await import('./runner-codex.ts')
      return mod.createCodexRunner()
    }
    case 'claude': {
      const mod = await import('./runner-claude.ts')
      return mod.createClaudeRunner(options)
    }
    default:
      throw new Error(`Unknown RUNNER '${name}' (supported: codex, claude)`)
  }
}
