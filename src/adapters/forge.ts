// The forge adapter is the only place the orchestration talks to a hosting platform.
// Everything it returns is normalized: the core never sees a `gh`/`glab`/`tea` output
// shape, so porting to Gitea or GitLab means implementing this interface and nothing
// else. SPEC.md item 29.

export type PrState = 'open' | 'closed' | 'merged' | 'none'

export type CheckConclusion = 'success' | 'failure' | 'pending' | 'skipped'

export interface PrCheck {
  name: string
  conclusion: CheckConclusion
  /** ISO timestamp used to distinguish reruns with the same check name. */
  startedAt: string
}

export interface PrStatus {
  state: PrState
  isDraft: boolean
  url: string
  /** Head commit SHA — the core's no-checks grace window is measured from its push. */
  headSha: string
  checks: PrCheck[]
}

export interface CreatePrOptions {
  branch: string
  base: string
  title: string
  body: string
  draft: boolean
}

export interface ForgeIssue {
  number: number
  state: 'open' | 'closed'
  title: string
  body: string
  labels: string[]
  assignees: string[]
  /** ISO timestamp of the last update — the stale-lease clock. */
  updatedAt: string
}

export interface CreateIssueOptions {
  title: string
  body: string
  labels: string[]
  /** Assignees applied atomically when the forge creates the issue. */
  assignees?: string[]
}

export interface WorkflowRun {
  id: number
  createdAt: string
  headSha: string
  status: string
  conclusion: string | null
}

export interface Forge {
  /** Find the open PR for a branch, or state 'none' when there is not one. */
  prStatus(branch: string): Promise<PrStatus>
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

  // Issue-queue operations. Labels passed anywhere here must already exist —
  // call ensureLabel first; creating them lazily inside every call would cost a
  // round-trip per operation.
  currentUser(): Promise<string>
  ensureLabel(name: string, description: string): Promise<void>
  createIssue(options: CreateIssueOptions): Promise<number>
  getIssue(issueNumber: number): Promise<ForgeIssue>
  /** Add a comment to an issue. */
  commentIssue(issueNumber: number, comment: string): Promise<void>
  /** Issue comment bodies, oldest first. */
  listIssueComments(issueNumber: number): Promise<string[]>
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
