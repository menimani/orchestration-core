import type {
  CreateIssueInRepositoryOptions, CreateIssueOptions, CreatePrOptions, Forge, ForgeIssue,
  ForgeIssueComment, PrReference, PrStatus,
} from '../src/adapters/forge.ts'

// An in-memory forge for tests: PR calls answer from a settable status, and the issue
// operations behave like a real tracker — including multiple simultaneous assignees,
// which is what makes the claim tie-break testable.

export interface FakeForge extends Forge {
  prStatusValue: PrStatus
  prStatusScript: PrStatus[]
  prStatusCalls: number
  prStatusRefs: PrReference[]
  issues: Map<number, ForgeIssue>
  issueComments: Map<number, string[]>
  issueCommentAuthors: Map<number, Array<{ login: string; hasWriteAccess: boolean }>>
  repositoryIssues: Array<CreateIssueInRepositoryOptions & { labels: string[]; url: string }>
  repositoryLabels: Map<string, Set<string>>
  labels: Set<string>
  listOpenIssuesCalls: string[]
  listIssueCommentsCalls: number[]
  user: string
  clock: () => Date
}

export function makeFakeForge(user = 'worker-a'): FakeForge {
  let nextIssueNumber = 1
  const fake: FakeForge = {
    prStatusValue: { state: 'open', isDraft: true, url: 'https://example.test/pull/1', headSha: '', checks: [] },
    prStatusScript: [],
    prStatusCalls: 0,
    prStatusRefs: [],
    issues: new Map(),
    issueComments: new Map(),
    issueCommentAuthors: new Map(),
    repositoryIssues: [],
    repositoryLabels: new Map(),
    labels: new Set(),
    listOpenIssuesCalls: [],
    listIssueCommentsCalls: [],
    user,
    clock: () => new Date(),

    resolveGitRemote(remote: string): string {
      return remote
    },

    issueClosingCommitMessage(message: string): string {
      return message
    },

    async prStatus(ref: PrReference): Promise<PrStatus> {
      fake.prStatusRefs.push(ref)
      const scripted = fake.prStatusScript[Math.min(fake.prStatusCalls, fake.prStatusScript.length - 1)]
      fake.prStatusCalls++
      return scripted ?? fake.prStatusValue
    },
    async prBody(): Promise<string> {
      return ''
    },
    async createPr(_options: CreatePrOptions): Promise<string> {
      return 'https://example.test/pull/1'
    },
    async updatePr(): Promise<void> {},
    async markPrReady(): Promise<void> {},
    async dispatchWorkflow(): Promise<void> {},
    async findWorkflowRun(): Promise<undefined> {
      return undefined
    },
    async getWorkflowRun(): Promise<never> {
      throw new Error('no workflow run configured')
    },

    async currentUser(): Promise<string> {
      return fake.user
    },
    async listLabels(): Promise<string[]> {
      return [...fake.labels]
    },
    async createLabel(name: string): Promise<void> {
      fake.labels.add(name)
    },
    async createIssue(options: CreateIssueOptions): Promise<number> {
      const issueNumber = nextIssueNumber++
      fake.issues.set(issueNumber, {
        number: issueNumber,
        state: 'open',
        title: options.title,
        body: options.body,
        author: { login: fake.user, hasWriteAccess: true },
        labels: [...options.labels],
        assignees: [...(options.assignees ?? [])],
        updatedAt: fake.clock().toISOString(),
      })
      return issueNumber
    },
    async createIssueInRepository(options: CreateIssueInRepositoryOptions): Promise<string> {
      const labels = options.optionalLabels.filter(
        (label) => fake.repositoryLabels.get(options.repository)?.has(label) === true,
      )
      const url = `https://example.test/${options.repository}/issues/${fake.repositoryIssues.length + 1}`
      fake.repositoryIssues.push({ ...options, optionalLabels: [...options.optionalLabels], labels, url })
      return url
    },
    async getIssue(issueNumber: number): Promise<ForgeIssue> {
      const issue = fake.issues.get(issueNumber)
      if (issue === undefined) throw new Error(`no such issue: #${issueNumber}`)
      return { ...issue, labels: [...issue.labels], assignees: [...issue.assignees] }
    },
    async commentIssue(issueNumber: number, comment: string): Promise<void> {
      const issue = fake.issues.get(issueNumber)
      if (issue === undefined) throw new Error(`no such issue: #${issueNumber}`)
      const comments = fake.issueComments.get(issueNumber) ?? []
      comments.push(comment)
      fake.issueComments.set(issueNumber, comments)
      const authors = fake.issueCommentAuthors.get(issueNumber) ?? []
      authors.push({ login: fake.user, hasWriteAccess: true })
      fake.issueCommentAuthors.set(issueNumber, authors)
      issue.updatedAt = fake.clock().toISOString()
    },
    async listIssueComments(issueNumber: number): Promise<ForgeIssueComment[]> {
      fake.listIssueCommentsCalls.push(issueNumber)
      const authors = fake.issueCommentAuthors.get(issueNumber) ?? []
      return (fake.issueComments.get(issueNumber) ?? []).map((body, index) => ({
        body,
        author: authors[index] ?? { login: fake.user, hasWriteAccess: true },
      }))
    },
    async listOpenIssues(label: string): Promise<ForgeIssue[]> {
      fake.listOpenIssuesCalls.push(label)
      return [...fake.issues.values()]
        .filter((issue) => issue.state === 'open' && issue.labels.includes(label))
        .map((issue) => ({ ...issue, labels: [...issue.labels], assignees: [...issue.assignees] }))
    },
    async listClosedIssues(label: string): Promise<ForgeIssue[]> {
      return [...fake.issues.values()]
        .filter((issue) => issue.state === 'closed' && issue.labels.includes(label))
        .map((issue) => ({ ...issue, labels: [...issue.labels], assignees: [...issue.assignees] }))
    },
    async assignIssue(issueNumber: number, assignee: string): Promise<void> {
      const issue = fake.issues.get(issueNumber)
      if (issue === undefined) throw new Error(`no such issue: #${issueNumber}`)
      if (!issue.assignees.includes(assignee)) issue.assignees.push(assignee)
      issue.updatedAt = fake.clock().toISOString()
    },
    async unassignIssue(issueNumber: number, assignee: string): Promise<void> {
      const issue = fake.issues.get(issueNumber)
      if (issue === undefined) return
      issue.assignees = issue.assignees.filter((login) => login !== assignee)
      issue.updatedAt = fake.clock().toISOString()
    },
    async addLabel(issueNumber: number, label: string): Promise<void> {
      const issue = fake.issues.get(issueNumber)
      if (issue === undefined) return
      if (!issue.labels.includes(label)) issue.labels.push(label)
      issue.updatedAt = fake.clock().toISOString()
    },
    async removeLabel(issueNumber: number, label: string): Promise<void> {
      const issue = fake.issues.get(issueNumber)
      if (issue === undefined) return
      issue.labels = issue.labels.filter((name) => name !== label)
      issue.updatedAt = fake.clock().toISOString()
    },
    async closeIssue(issueNumber: number, comment: string): Promise<void> {
      const issue = fake.issues.get(issueNumber)
      if (issue !== undefined) {
        issue.state = 'closed'
        const comments = fake.issueComments.get(issueNumber) ?? []
        comments.push(comment)
        fake.issueComments.set(issueNumber, comments)
        const authors = fake.issueCommentAuthors.get(issueNumber) ?? []
        authors.push({ login: fake.user, hasWriteAccess: true })
        fake.issueCommentAuthors.set(issueNumber, authors)
      }
    },
  }
  return fake
}
