// The runner adapter is the only place the orchestration invokes the coding agent.
// The contract that makes runners substitutable is the marker protocol, not the CLI:
// a runner receives a task specification and must write a final-message file whose
// last lines carry `TASK_COMPLETE` on its own line when the work is done, and may
// carry `NO_CHANGE_WARRANTED`, `NEXT_TASK: <description>`, and
// `DECISION_REQUIRED: <text>` lines before it.
// Markers anywhere else (the transcript log) are ignored by the core. SPEC.md item 30.

import type { SharedSkillRenderOptions, SharedSkillsAdapter } from './shared-skills.ts'
import { externalAdapterSpecifier } from './external.ts'

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

export type RunnerModelOptions = Pick<RunnerStartOptions, 'effort' | 'model'>

export type RunnerSharedSkillRenderOptions = SharedSkillRenderOptions
export type RunnerSharedSkills = SharedSkillsAdapter

export interface Runner {
  /** Runner-specific repository skill discovery and rendering behavior. */
  sharedSkills: RunnerSharedSkills
  /** Resolve the model the adapter will pass to its runner, if it passes one explicitly. */
  resolveModel?(options: RunnerModelOptions): string | undefined
  /** Start the agent process detached; resolve with its PID once spawned. */
  start(options: RunnerStartOptions): Promise<number>
}

export interface RunnerLoadOptions {
  /** Environment available to the selected runner adapter. */
  env: NodeJS.ProcessEnv
  /** Consumer repository root used to resolve relative external adapter selectors. */
  repoRoot?: string
}

export interface ExternalRunnerModule {
  /** A ready-to-use adapter. */
  default?: Runner
  /** A named ready-to-use adapter. */
  runner?: Runner
  /** A factory for adapters that need loader options. */
  createRunner?: (options: RunnerLoadOptions) => Runner | Promise<Runner>
}

export async function loadRunner(
  name: string,
  options: RunnerLoadOptions = { env: process.env },
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
    default: {
      let mod: ExternalRunnerModule
      try {
        mod = await import(
          externalAdapterSpecifier(name, options.repoRoot ?? process.cwd())
        ) as ExternalRunnerModule
      } catch (error) {
        throw new Error(
          `Unknown RUNNER '${name}' (supported: codex, claude). Could not load external adapter: ${(error as Error).message}`,
          { cause: error },
        )
      }
      const runner = mod.default ?? mod.runner
      if (runner !== undefined) return runner
      if (mod.createRunner !== undefined) return mod.createRunner(options)
      throw new Error(
        `External RUNNER '${name}' must export default, runner, or createRunner`,
      )
    }
  }
}
