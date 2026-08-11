import { existsSync, readdirSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

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
  /** Run an install command first when a worktree-relative dependency path is missing. */
  installWhenMissing?: { path: string; command: string }
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
  /** Whether this step needs a running Docker daemon. */
  needsDocker?: boolean
}

export interface DockerProbe {
  /** Command used to verify that the Docker daemon is reachable. */
  command: string
  /** Maximum time to wait for the probe before treating Docker as unavailable. */
  timeoutMs: number
  /** Project-specific recovery guidance when the probe fails. */
  remediation: string
}

export interface InfrastructureFailure {
  /** Short attribution suitable for a merge-failure warning. */
  diagnosis: string
  /** Recovery guidance suitable for a cycle-suite error. */
  remediation: string
}

export interface WorktreeSetupStep {
  label: string
  /** Directory the command runs in, relative to the new worktree root. */
  cwd: string
  command: string
  /** Skip silently when this worktree-relative path does not exist. */
  requires?: string
}

export interface PullRequestCategory {
  /** Section heading used in the generated pull-request body. */
  label: string
  /** Wording used in the final title; omit categories that should not be counted there. */
  title?: { singular: string; plural: string }
}

export interface PullRequestCommit {
  subject: string
  files: string[]
}

export interface PullRequestClassification {
  category: string
  /** Optional screen or domain label shown before the commit subject. */
  area?: string
}

export interface PullRequestChanges {
  files: string[]
  deletedFiles: string[]
  /** Read the branch diff, optionally limited to repository-relative pathspecs. */
  diff(pathspecs?: string[]): string
}

export interface PullRequestPresentation {
  categories: PullRequestCategory[]
  /** Final-title summary when no category configured for title counts has commits. */
  titleFallback: string
  classifyCommit(commit: PullRequestCommit): PullRequestClassification
  /** Unprefixed bullet text; continuation lines may carry their own indentation. */
  detectRisks(changes: PullRequestChanges): string[]
}

export interface ProjectAdapter {
  name: string
  /** Manual production deployment, when this repository has one. */
  deployment?: { workflow: string; revisionUrl: string }
  /** Whether pull requests are expected to receive CI checks. Omit when unknown. */
  ciChecksExpected?: boolean
  /** Per-merge verification, selected from the paths the worktree touched. */
  mergeChecks(taskGate: 'full' | 'light'): MergeCheck[]
  /** The full suites the cycle gate runs against the branch tip under light task gates. */
  cycleSuite(): SuiteStep[]
  /** Repository-specific probe used when a cycle suite step needs Docker. */
  cycleSuiteDockerProbe?: DockerProbe
  /** Classify repository-specific infrastructure failures found in command output. */
  classifyInfrastructureFailure?: (output: string) => InfrastructureFailure | undefined
  /** Repository-specific preparation required before a scan can inspect a fresh worktree. */
  scanWorktreeSetup?: WorktreeSetupStep[]
  /** Repository-specific classification and risk signals for the generated pull request. */
  pullRequest: PullRequestPresentation
}

function isProjectAdapter(value: unknown, name?: string): value is ProjectAdapter {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<ProjectAdapter>
  return typeof candidate.name === 'string'
    && candidate.name !== ''
    && (name === undefined || candidate.name === name)
    && typeof candidate.mergeChecks === 'function'
    && typeof candidate.cycleSuite === 'function'
    && typeof candidate.pullRequest === 'object'
    && candidate.pullRequest !== null
    && Array.isArray(candidate.pullRequest.categories)
    && typeof candidate.pullRequest.titleFallback === 'string'
    && typeof candidate.pullRequest.classifyCommit === 'function'
    && typeof candidate.pullRequest.detectRisks === 'function'
}

function discoverProjectAdapter(orchestrationRoot: string): { path: string; name: string } {
  const projectDirectory = resolve(orchestrationRoot, 'project')
  const adapters = existsSync(projectDirectory)
    ? readdirSync(projectDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^project-.+\.ts$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    : []

  if (adapters.length !== 1) {
    const found = adapters.length === 0 ? '(none)' : adapters.join(', ')
    throw new Error(
      `Could not discover project adapter in ${projectDirectory}: found ${found}. `
      + 'Expected exactly one project-*.ts file; PROJECT selects between them.',
    )
  }

  const filename = adapters[0]!
  return {
    path: resolve(projectDirectory, filename),
    name: basename(filename, '.ts').slice('project-'.length),
  }
}

export async function loadProject(
  orchestrationRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectAdapter> {
  const configuredName = env['PROJECT'] === undefined || env['PROJECT'] === ''
    ? undefined
    : env['PROJECT']
  const configuredPath = env['PROJECT_ADAPTER'] === undefined || env['PROJECT_ADAPTER'] === ''
    ? undefined
    : env['PROJECT_ADAPTER']
  const discovered = configuredName === undefined && configuredPath === undefined
    ? discoverProjectAdapter(orchestrationRoot)
    : undefined
  const name = configuredName ?? discovered?.name
  const adapterPath = configuredPath !== undefined
    ? resolve(orchestrationRoot, configuredPath)
    : discovered?.path ?? resolve(orchestrationRoot, 'project', `project-${name}.ts`)

  if (!existsSync(adapterPath)) {
    throw new Error(`Project adapter not found: ${adapterPath}`)
  }

  const mod = await import(pathToFileURL(adapterPath).href) as Record<string, unknown>
  for (const value of Object.values(mod)) {
    if (isProjectAdapter(value, name)) return value
  }
  const expected = name === undefined ? 'a project adapter' : `project '${name}'`
  throw new Error(`Project adapter '${adapterPath}' does not export ${expected}`)
}
