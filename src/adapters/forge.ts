// The forge adapter is the only place the orchestration talks to a hosting platform.
// Everything it returns is normalized: the core never sees a `gh`/`glab`/`tea` output
// shape, so porting to Gitea or GitLab means implementing this interface and nothing
// else. SPEC.md item 29.

export type PrState = 'open' | 'closed' | 'merged' | 'none'

export type CheckConclusion = 'success' | 'failure' | 'pending'

export interface PrCheck {
  name: string
  conclusion: CheckConclusion
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
