// The project adapter carries everything the orchestration knows about the repository
// it runs in: which checks verify a merge, which suites prove a cycle's tip, and which
// paths make each of them relevant. The core executes these declarations and owns the
// generic behavior — output capture, failure attribution, stop decisions — so porting
// the orchestration to another repository means writing a project adapter and nothing
// else, exactly as porting to another forge means writing a forge adapter.

export interface MergeCheck {
  label: string
  /** Directory the command runs in, relative to the worktree root ('' = the root). */
  cwd: string
  command: string
  /** Whether the changed paths make this check relevant; undefined = always runs. */
  appliesTo?: (changedFiles: string[]) => boolean
  /** Skip silently when this worktree-relative path does not exist. */
  requires?: string
  /** Skip when this worktree-relative path exists — for fallbacks a successor replaces. */
  unless?: string
}

export interface SuiteStep {
  label: string
  /** Directory the command runs in, relative to the repository root ('' = the root). */
  cwd: string
  command: string
  /** Skip silently when this repo-relative path does not exist. */
  requires?: string
  /** Run a repair command first when a repo-relative path is missing — for a toolchain
   * that breaks in a way reinstalling fixes, which is not the branch's fault. */
  repairWhenMissing?: { path: string; command: string; message: string }
}

export interface ProjectAdapter {
  name: string
  /** Manual production deployment, when this repository has one. */
  deployment?: { workflow: string; url: string }
  /** Per-merge verification, selected from the paths the worktree touched. */
  mergeChecks(taskGate: 'full' | 'light'): MergeCheck[]
  /** The full suites the cycle gate runs against the branch tip under light task gates. */
  cycleSuite(): SuiteStep[]
}

export async function loadProject(name: string): Promise<ProjectAdapter> {
  switch (name) {
    case 'shiora': {
      const mod = await import('./project-shiora.ts')
      return mod.shioraProject
    }
    default:
      throw new Error(`Unknown PROJECT '${name}' (supported: shiora)`)
  }
}
