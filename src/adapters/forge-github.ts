import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  CheckConclusion, CreateIssueOptions, CreatePrOptions, Forge, ForgeIssue, PrStatus, WorkflowRun,
} from './forge.ts'

const execFileAsync = promisify(execFile)

// gh writes its errors to stdout too, and one of them names githubstatus.com — close
// enough to a URL that a looser match once stored the error text and every later cycle
// asked gh about a pull request called "check your internet connection".
const PR_URL_PATTERN = /^https:\/\/\S+\/pull\/\d+$/

export interface RollupEntry {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
}

// Normalization ported 1:1 from check_pr_ci_status in bin/loop.sh:
// - A running CheckRun has an empty-string conclusion; an empty string must read as
//   pending, never as success.
// - The rollup may contain StatusContext entries, which carry `state` instead of the
//   CheckRun fields.
// - Anything unclassifiable is pending, not success, so the caller keeps waiting.
export function normalizeEntry(entry: RollupEntry): CheckConclusion {
  const raw
    = entry.status !== undefined && entry.status !== ''
      ? entry.status === 'COMPLETED'
        ? (entry.conclusion ?? '') === '' ? 'UNKNOWN' : (entry.conclusion as string)
        : 'PENDING'
      : (entry.state ?? '') === '' ? 'UNKNOWN' : (entry.state as string)
  if (raw === 'SUCCESS' || raw === 'NEUTRAL' || raw === 'SKIPPED') return 'success'
  if (raw === 'FAILURE' || raw === 'ERROR' || raw === 'CANCELLED' || raw === 'TIMED_OUT') {
    return 'failure'
  }
  return 'pending'
}

async function gh(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    cwd: repoRoot,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout
}

export function createGithubForge(repoRoot: string = process.cwd()): Forge {
  const parseWorkflowRun = (data: {
    databaseId: number
    createdAt: string
    status: string
    conclusion: string | null
  }): WorkflowRun => ({
    id: data.databaseId,
    createdAt: data.createdAt,
    status: data.status,
    conclusion: data.conclusion,
  })

  return {
    async prStatus(ref: string): Promise<PrStatus> {
      let stdout: string
      try {
        stdout = await gh(repoRoot, [
          'pr', 'view', ref,
          '--json', 'url,state,isDraft,headRefOid,statusCheckRollup',
        ])
      } catch {
        return { state: 'none', isDraft: false, url: '', headSha: '', checks: [] }
      }
      const data = JSON.parse(stdout) as {
        url: string
        state: string
        isDraft: boolean
        headRefOid: string
        statusCheckRollup: RollupEntry[] | null
      }
      const state
        = data.state === 'OPEN' ? 'open'
          : data.state === 'MERGED' ? 'merged'
            : 'closed'
      return {
        state,
        isDraft: data.isDraft,
        url: data.url,
        headSha: data.headRefOid,
        checks: (data.statusCheckRollup ?? []).map((entry) => ({
          name: entry.name ?? entry.context ?? '(unnamed)',
          conclusion: normalizeEntry(entry),
        })),
      }
    },

    async prBody(ref: string): Promise<string> {
      const stdout = await gh(repoRoot, ['pr', 'view', ref, '--json', 'body', '--jq', '.body'])
      return stdout
    },

    async createPr(options: CreatePrOptions): Promise<string> {
      const args = [
        'pr', 'create',
        '--base', options.base,
        '--head', options.branch,
        '--title', options.title,
        '--body', options.body,
      ]
      if (options.draft) args.push('--draft')
      const stdout = await gh(repoRoot, args)
      const url = stdout.split(/\r?\n/).map((line) => line.trim())
        .find((line) => PR_URL_PATTERN.test(line))
      if (url === undefined) {
        throw new Error(`gh pr create returned no pull request URL: ${stdout.trim()}`)
      }
      return url
    },

    async updatePr(ref: string, fields: { title?: string; body?: string }): Promise<void> {
      const args = ['pr', 'edit', ref]
      if (fields.title !== undefined) args.push('--title', fields.title)
      if (fields.body !== undefined) args.push('--body', fields.body)
      if (args.length === 3) return
      await gh(repoRoot, args)
    },

    async markPrReady(ref: string): Promise<void> {
      await gh(repoRoot, ['pr', 'ready', ref])
    },

    async dispatchWorkflow(workflow: string, ref: string): Promise<void> {
      await gh(repoRoot, ['workflow', 'run', workflow, '--ref', ref])
    },

    async findWorkflowRun(workflow: string, createdAfter: Date): Promise<WorkflowRun | undefined> {
      const stdout = await gh(repoRoot, [
        'run', 'list', '--workflow', workflow, '--limit', '20',
        '--json', 'databaseId,createdAt,status,conclusion',
      ])
      const runs = (JSON.parse(stdout) as Array<{
        databaseId: number
        createdAt: string
        status: string
        conclusion: string | null
      }>)
        .filter((run) => new Date(run.createdAt).getTime() >= createdAfter.getTime())
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      return runs[0] === undefined ? undefined : parseWorkflowRun(runs[0])
    },

    async getWorkflowRun(runId: number): Promise<WorkflowRun> {
      const stdout = await gh(repoRoot, [
        'run', 'view', String(runId), '--json', 'databaseId,createdAt,status,conclusion',
      ])
      return parseWorkflowRun(JSON.parse(stdout) as {
        databaseId: number
        createdAt: string
        status: string
        conclusion: string | null
      })
    },

    async currentUser(): Promise<string> {
      return (await gh(repoRoot, ['api', 'user', '--jq', '.login'])).trim()
    },

    async ensureLabel(name: string, description: string): Promise<void> {
      // --force updates an existing label instead of failing on it.
      await gh(repoRoot, ['label', 'create', name, '--description', description, '--force'])
    },

    async createIssue(options: CreateIssueOptions): Promise<number> {
      const args = ['issue', 'create', '--title', options.title, '--body', options.body]
      for (const label of options.labels) args.push('--label', label)
      for (const assignee of options.assignees ?? []) args.push('--assignee', assignee)
      const stdout = await gh(repoRoot, args)
      const match = /\/issues\/(\d+)\s*$/.exec(stdout.trim())
      if (match === null) {
        throw new Error(`gh issue create returned no issue URL: ${stdout.trim()}`)
      }
      return Number(match[1])
    },

    async getIssue(issueNumber: number): Promise<ForgeIssue> {
      const stdout = await gh(repoRoot, ['issue', 'view', String(issueNumber),
        '--json', 'number,state,title,body,labels,assignees,updatedAt'])
      const data = JSON.parse(stdout) as {
        number: number
        state: 'OPEN' | 'CLOSED'
        title: string
        body: string
        labels: Array<{ name: string }>
        assignees: Array<{ login: string }>
        updatedAt: string
      }
      return {
        number: data.number,
        state: data.state.toLowerCase() as ForgeIssue['state'],
        title: data.title,
        body: data.body,
        labels: data.labels.map((label) => label.name),
        assignees: data.assignees.map((assignee) => assignee.login),
        updatedAt: data.updatedAt,
      }
    },

    async commentIssue(issueNumber: number, comment: string): Promise<void> {
      await gh(repoRoot, ['issue', 'comment', String(issueNumber), '--body', comment])
    },

    async listOpenIssues(label: string): Promise<ForgeIssue[]> {
      const stdout = await gh(repoRoot, ['issue', 'list', '--state', 'open',
        '--label', label, '--limit', '200',
        '--json', 'number,state,title,body,labels,assignees,updatedAt'])
      const data = JSON.parse(stdout) as Array<{
        number: number
        state: 'OPEN'
        title: string
        body: string
        labels: Array<{ name: string }>
        assignees: Array<{ login: string }>
        updatedAt: string
      }>
      return data.map((issue) => ({
        number: issue.number,
        state: issue.state.toLowerCase() as ForgeIssue['state'],
        title: issue.title,
        body: issue.body,
        labels: issue.labels.map((label_) => label_.name),
        assignees: issue.assignees.map((assignee) => assignee.login),
        updatedAt: issue.updatedAt,
      }))
    },

    async assignIssue(issueNumber: number, user: string): Promise<void> {
      await gh(repoRoot, ['issue', 'edit', String(issueNumber), '--add-assignee', user])
    },

    async unassignIssue(issueNumber: number, user: string): Promise<void> {
      await gh(repoRoot, ['issue', 'edit', String(issueNumber), '--remove-assignee', user])
    },

    async addLabel(issueNumber: number, label: string): Promise<void> {
      await gh(repoRoot, ['issue', 'edit', String(issueNumber), '--add-label', label])
    },

    async removeLabel(issueNumber: number, label: string): Promise<void> {
      await gh(repoRoot, ['issue', 'edit', String(issueNumber), '--remove-label', label])
    },

    async closeIssue(issueNumber: number, comment: string): Promise<void> {
      await gh(repoRoot, ['issue', 'close', String(issueNumber), '--comment', comment])
    },
  }
}
