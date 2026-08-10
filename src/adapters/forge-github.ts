import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type {
  CheckConclusion, CreateIssueOptions, CreatePrOptions, Forge, ForgeIssue, PrStatus, WorkflowRun,
} from './forge.ts'

const execFileAsync = promisify(execFile)

// gh writes its errors to stdout too, and one of them names githubstatus.com — close
// enough to a URL that a looser match once stored the error text and every later cycle
// asked gh about a pull request called "check your internet connection".
const PR_URL_PATTERN = /^https:\/\/\S+\/pull\/\d+$/

const rollupEntrySchema = z.object({
  __typename: z.string().optional(),
  name: z.string().optional(),
  context: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  state: z.string().optional(),
  startedAt: z.string().optional(),
})

const prStatusSchema = z.object({
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  headRefOid: z.string(),
  statusCheckRollup: z.array(rollupEntrySchema).nullable(),
})

const prBodySchema = z.object({ body: z.string() })
const currentUserSchema = z.object({ login: z.string() })

const workflowRunSchema = z.object({
  databaseId: z.number(),
  createdAt: z.string(),
  displayTitle: z.string(),
  headBranch: z.string(),
  headSha: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
})

const workflowRunListSchema = z.array(workflowRunSchema)

const githubIssueSchema = z.object({
  number: z.number(),
  state: z.enum(['OPEN', 'CLOSED']),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  assignees: z.array(z.object({ login: z.string() })),
  updatedAt: z.string(),
})

const openGithubIssueListSchema = z.array(githubIssueSchema.extend({ state: z.literal('OPEN') }))
const closedGithubIssueListSchema = z.array(githubIssueSchema.extend({ state: z.literal('CLOSED') }))
const issueCommentsSchema = z.object({
  comments: z.array(z.object({ body: z.string() })),
})

export type RollupEntry = z.infer<typeof rollupEntrySchema>
export type GithubWorkflowRun = z.infer<typeof workflowRunSchema>
type GithubIssue = z.infer<typeof githubIssueSchema>

function schemaPath(path: PropertyKey[]): string {
  if (path.length === 0) return '(root)'
  return path.map((segment, index) => {
    if (typeof segment === 'number') return `[${segment}]`
    return `${index === 0 ? '' : '.'}${String(segment)}`
  }).join('')
}

function parseGhJson<T>(args: readonly string[], stdout: string, schema: z.ZodType<T>): T {
  const command = `gh ${args.join(' ')}`
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new Error(`${command} returned invalid JSON at (root)`, { cause: error })
  }
  const result = schema.safeParse(parsed)
  if (!result.success) {
    const mismatches = result.error.issues
      .map((issue) => `${schemaPath(issue.path)}: ${issue.message}`)
      .join('; ')
    throw new Error(`${command} returned JSON that failed schema validation at ${mismatches}`, {
      cause: result.error,
    })
  }
  return result.data
}

export function workflowRunForDispatch(
  runs: GithubWorkflowRun[],
  ref: string,
  dispatchToken: string,
): GithubWorkflowRun | undefined {
  return runs.find(
    (candidate) => candidate.displayTitle === dispatchToken && candidate.headBranch === ref,
  )
}

// Normalization constraints:
// - A running CheckRun has an empty-string conclusion; an empty string must read as
//   pending, never as success.
// - The rollup may contain StatusContext entries, which carry `state` instead of the
//   CheckRun fields.
// - Anything unclassifiable is pending, not success, so the caller keeps waiting.
export function normalizeEntry(entry: RollupEntry): CheckConclusion {
  const raw
    = entry.status !== undefined && entry.status !== ''
      ? entry.status === 'COMPLETED'
        ? (entry.conclusion ?? '') === '' ? 'UNKNOWN' : entry.conclusion
        : 'PENDING'
      : (entry.state ?? '') === '' ? 'UNKNOWN' : entry.state
  if (raw === 'SUCCESS' || raw === 'NEUTRAL') return 'success'
  if (raw === 'SKIPPED') return 'skipped'
  if (raw === 'FAILURE' || raw === 'ERROR' || raw === 'CANCELLED' || raw === 'TIMED_OUT'
    || raw === 'ACTION_REQUIRED' || raw === 'STARTUP_FAILURE' || raw === 'STALE') {
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

export type GithubCommand = (repoRoot: string, args: string[]) => Promise<string>

export function createGithubForge(
  repoRoot: string = process.cwd(),
  runGh: GithubCommand = gh,
): Forge {
  const parseWorkflowRun = (data: GithubWorkflowRun): WorkflowRun => ({
    id: data.databaseId,
    createdAt: data.createdAt,
    headSha: data.headSha,
    status: data.status,
    conclusion: data.conclusion,
  })

  return {
    async prStatus(ref: string): Promise<PrStatus> {
      let stdout: string
      const args = [
        'pr', 'view', ref,
        '--json', 'url,state,isDraft,headRefOid,statusCheckRollup',
      ]
      try {
        stdout = await runGh(repoRoot, args)
      } catch {
        return { state: 'none', isDraft: false, url: '', headSha: '', checks: [] }
      }
      const data = parseGhJson(args, stdout, prStatusSchema)
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
          startedAt: entry.startedAt ?? '',
        })),
      }
    },

    async prBody(ref: string): Promise<string> {
      const args = ['pr', 'view', ref, '--json', 'body']
      const stdout = await runGh(repoRoot, args)
      return `${parseGhJson(args, stdout, prBodySchema).body}\n`
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
      const stdout = await runGh(repoRoot, args)
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
      await runGh(repoRoot, args)
    },

    async markPrReady(ref: string): Promise<void> {
      await runGh(repoRoot, ['pr', 'ready', ref])
    },

    async dispatchWorkflow(workflow: string, ref: string, dispatchToken: string): Promise<void> {
      await runGh(repoRoot, [
        'workflow', 'run', workflow, '--ref', ref,
        '--field', `dispatch_token=${dispatchToken}`,
      ])
    },

    async findWorkflowRun(
      workflow: string,
      ref: string,
      dispatchToken: string,
    ): Promise<WorkflowRun | undefined> {
      const args = [
        'run', 'list', '--workflow', workflow, '--event', 'workflow_dispatch', '--limit', '100',
        '--json', 'databaseId,createdAt,displayTitle,headBranch,headSha,status,conclusion',
      ]
      const stdout = await runGh(repoRoot, args)
      const run = workflowRunForDispatch(
        parseGhJson(args, stdout, workflowRunListSchema), ref, dispatchToken,
      )
      return run === undefined ? undefined : parseWorkflowRun(run)
    },

    async getWorkflowRun(runId: number): Promise<WorkflowRun> {
      const args = [
        'run', 'view', String(runId),
        '--json', 'databaseId,createdAt,displayTitle,headBranch,headSha,status,conclusion',
      ]
      const stdout = await runGh(repoRoot, args)
      return parseWorkflowRun(parseGhJson(args, stdout, workflowRunSchema))
    },

    async currentUser(): Promise<string> {
      const args = ['api', 'user']
      const stdout = await runGh(repoRoot, args)
      return parseGhJson(args, stdout, currentUserSchema).login
    },

    async ensureLabel(name: string, description: string): Promise<void> {
      // --force updates an existing label instead of failing on it.
      await runGh(repoRoot, ['label', 'create', name, '--description', description, '--force'])
    },

    async createIssue(options: CreateIssueOptions): Promise<number> {
      const args = ['issue', 'create', '--title', options.title, '--body', options.body]
      for (const label of options.labels) args.push('--label', label)
      for (const assignee of options.assignees ?? []) args.push('--assignee', assignee)
      const stdout = await runGh(repoRoot, args)
      const match = /\/issues\/(\d+)\s*$/.exec(stdout.trim())
      if (match === null) {
        throw new Error(`gh issue create returned no issue URL: ${stdout.trim()}`)
      }
      return Number(match[1])
    },

    async getIssue(issueNumber: number): Promise<ForgeIssue> {
      const args = ['issue', 'view', String(issueNumber),
        '--json', 'number,state,title,body,labels,assignees,updatedAt']
      const stdout = await runGh(repoRoot, args)
      return normalizeIssue(parseGhJson(args, stdout, githubIssueSchema))
    },

    async commentIssue(issueNumber: number, comment: string): Promise<void> {
      await runGh(repoRoot, ['issue', 'comment', String(issueNumber), '--body', comment])
    },

    async listIssueComments(issueNumber: number): Promise<string[]> {
      const args = [
        'issue', 'view', String(issueNumber), '--json', 'comments',
      ]
      const stdout = await runGh(repoRoot, args)
      const data = parseGhJson(args, stdout, issueCommentsSchema)
      return data.comments.map((comment) => comment.body)
    },

    async listOpenIssues(label: string): Promise<ForgeIssue[]> {
      const args = ['issue', 'list', '--state', 'open',
        '--label', label, '--limit', '200',
        '--json', 'number,state,title,body,labels,assignees,updatedAt']
      const stdout = await runGh(repoRoot, args)
      return parseGhJson(args, stdout, openGithubIssueListSchema).map(normalizeIssue)
    },

    async listClosedIssues(label: string): Promise<ForgeIssue[]> {
      const args = ['issue', 'list', '--state', 'closed',
        '--label', label, '--limit', '200',
        '--json', 'number,state,title,body,labels,assignees,updatedAt']
      const stdout = await runGh(repoRoot, args)
      return parseGhJson(args, stdout, closedGithubIssueListSchema).map(normalizeIssue)
    },

    async assignIssue(issueNumber: number, user: string): Promise<void> {
      await runGh(repoRoot, ['issue', 'edit', String(issueNumber), '--add-assignee', user])
    },

    async unassignIssue(issueNumber: number, user: string): Promise<void> {
      await runGh(repoRoot, ['issue', 'edit', String(issueNumber), '--remove-assignee', user])
    },

    async addLabel(issueNumber: number, label: string): Promise<void> {
      await runGh(repoRoot, ['issue', 'edit', String(issueNumber), '--add-label', label])
    },

    async removeLabel(issueNumber: number, label: string): Promise<void> {
      await runGh(repoRoot, ['issue', 'edit', String(issueNumber), '--remove-label', label])
    },

    async closeIssue(issueNumber: number, comment: string): Promise<void> {
      await runGh(repoRoot, ['issue', 'close', String(issueNumber), '--comment', comment])
    },
  }
}

function normalizeIssue(issue: GithubIssue): ForgeIssue {
  return {
    number: issue.number,
    state: issue.state === 'OPEN' ? 'open' : 'closed',
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((label) => label.name),
    assignees: issue.assignees.map((assignee) => assignee.login),
    updatedAt: issue.updatedAt,
  }
}
