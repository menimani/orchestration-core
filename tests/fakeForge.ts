import type {
  CreateIssueOptions, CreatePrOptions, Forge, ForgeIssue, PrStatus,
} from '../src/adapters/forge.ts'

// An in-memory forge for tests: PR calls answer from a settable status, and the issue
// operations behave like a real tracker — including multiple simultaneous assignees,
// which is what makes the claim tie-break testable.

export interface FakeForge extends Forge {
  prStatusValue: PrStatus
  prStatusScript: PrStatus[]
  prStatusCalls: number
  issues: Map<number, ForgeIssue>
  issueComments: Map<number, string[]>
  user: string
  clock: () => Date
}

export function makeFakeForge(user = 'worker-a'): FakeForge {
  let nextIssueNumber = 1
  const fake: FakeForge = {
    prStatusValue: { state: 'open', isDraft: true, url: 'https://example.test/pull/1', headSha: '', checks: [] },
    prStatusScript: [],
    prStatusCalls: 0,
    issues: new Map(),
    issueComments: new Map(),
    user,
    clock: () => new Date(),

    async prStatus(): Promise<PrStatus> {
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
    async ensureLabel(): Promise<void> {},
    async createIssue(options: CreateIssueOptions): Promise<number> {
      const issueNumber = nextIssueNumber++
      fake.issues.set(issueNumber, {
        number: issueNumber,
        state: 'open',
        title: options.title,
        body: options.body,
        labels: [...options.labels],
        assignees: [...(options.assignees ?? [])],
        updatedAt: fake.clock().toISOString(),
      })
      return issueNumber
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
      issue.updatedAt = fake.clock().toISOString()
    },
    async listIssueComments(issueNumber: number): Promise<string[]> {
      return [...(fake.issueComments.get(issueNumber) ?? [])]
    },
    async listOpenIssues(label: string): Promise<ForgeIssue[]> {
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
      }
    },
  }
  return fake
}
