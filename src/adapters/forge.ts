// The forge adapter is the only place the orchestration talks to a hosting platform.
// Everything it returns is normalized: the core never sees a `gh`/`glab`/`tea` output
// shape, so porting to Gitea or GitLab means implementing this interface and nothing
// else. SPEC.md item 29.

export type PrState = 'open' | 'closed' | 'merged' | 'none'

export type CheckConclusion = 'success' | 'failure' | 'pending' | 'skipped'

export interface PrCheck {
  name: string
  conclusion: CheckConclusion
  /** ISO timestamp used to distinguish reruns, or an empty string when unavailable. */
  startedAt: string
}

export interface PrStatus {
  state: PrState
  isDraft: boolean
  url: string
  /** Head commit SHA reported by the forge. */
  headSha: string
  checks: PrCheck[]
}

/**
 * A forge-neutral reference to an existing pull request.
 *
 * The reference kind records what the caller actually knows, rather than relying on
 * adapters to guess whether an untyped string is a branch, PR number, or URL.
 */
export type PrReference =
  | { kind: 'branch'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'url'; value: string }

export interface CreatePrOptions {
  branch: string
  base: string
  title: string
  body: string
  draft: boolean
}

export interface ForgeAuthor {
  login: string
  /** The forge's verdict that this account is allowed to write to the repository. */
  hasWriteAccess: boolean
}

export interface ForgeIssue {
  number: number
  state: 'open' | 'closed'
  title: string
  body: string
  author: ForgeAuthor
  labels: string[]
  assignees: string[]
  /** ISO timestamp of the last update — the stale-lease clock. */
  updatedAt: string
}

export interface ForgeIssueComment {
  body: string
  author: ForgeAuthor
}

export interface CreateIssueOptions {
  title: string
  body: string
  labels: string[]
  /** Assignees applied atomically when the forge creates the issue. */
  assignees?: string[]
}

export interface CreateIssueInRepositoryOptions {
  repository: string
  title: string
  body: string
  /** Labels to apply when they already exist in the target repository. */
  optionalLabels: string[]
}

export interface WorkflowRun {
  id: number
  createdAt: string
  headSha: string
  status: string
  conclusion: string | null
}

/** A forge quota exhaustion with the instant at which calls may resume. */
export class ForgeRateLimitError extends Error {
  readonly resetAt: Date

  constructor(
    resetAt: Date,
    options?: ErrorOptions,
  ) {
    super(`Forge rate limit exhausted until ${resetAt.toISOString()}`, options)
    this.name = 'ForgeRateLimitError'
    this.resetAt = resetAt
  }
}

export interface Forge {
  /** Resolve forge-specific repository shorthand into a Git remote or URL. */
  resolveGitRemote(remote: string): string

  /** Decorate a merge commit message so promotion closes the linked issue. */
  issueClosingCommitMessage(message: string, issueNumber: number): string

  /** Find the PR identified by the supplied reference, or state 'none' when absent. */
  prStatus(ref: PrReference): Promise<PrStatus>
  /** The current body text of the PR for a branch or URL. */
  prBody(ref: string): Promise<string>
  /** Create a PR and return its URL. */
  createPr(options: CreatePrOptions): Promise<string>
  /** Replace title and/or body of the PR for a branch. */
  updatePr(branch: string, fields: { title?: string; body?: string }): Promise<void>
  /** Promote a draft PR to ready for review. */
  markPrReady(branch: string): Promise<void>

  /** Dispatch a workflow and locate/observe the exact run created by that dispatch. */
  dispatchWorkflow(workflow: string, ref: string, dispatchToken: string): Promise<void>
  findWorkflowRun(workflow: string, ref: string, dispatchToken: string): Promise<WorkflowRun | undefined>
  getWorkflowRun(runId: number): Promise<WorkflowRun>

  // Issue-queue operations. Labels passed anywhere here must already exist.
  currentUser(): Promise<string>
  listLabels(): Promise<string[]>
  createLabel(name: string, description: string): Promise<void>
  createIssue(options: CreateIssueOptions): Promise<number>
  /** Create an issue outside the current repository and return its URL. */
  createIssueInRepository(options: CreateIssueInRepositoryOptions): Promise<string>
  getIssue(issueNumber: number): Promise<ForgeIssue>
  /** Add a comment to an issue. */
  commentIssue(issueNumber: number, comment: string): Promise<void>
  /** Issue comments with normalized authorship, oldest first. */
  listIssueComments(issueNumber: number): Promise<ForgeIssueComment[]>
  /** Open issues carrying the label, newest first. */
  listOpenIssues(label: string): Promise<ForgeIssue[]>
  /** Closed issues carrying the label, newest first. */
  listClosedIssues(label: string): Promise<ForgeIssue[]>
  assignIssue(issueNumber: number, user: string): Promise<void>
  unassignIssue(issueNumber: number, user: string): Promise<void>
  addLabel(issueNumber: number, label: string): Promise<void>
  removeLabel(issueNumber: number, label: string): Promise<void>
  closeIssue(issueNumber: number, comment: string): Promise<void>
}

export async function loadForge(name: string, repoRoot: string): Promise<Forge> {
  switch (name) {
    case 'github': {
      const mod = await import('./forge-github.ts')
      return mod.createGithubForge(repoRoot)
    }
    default:
      throw new Error(`Unknown FORGE '${name}' (supported: github)`)
  }
}
