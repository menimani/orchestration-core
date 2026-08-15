import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type {
  CheckConclusion, CreateIssueInRepositoryOptions, CreateIssueOptions, CreatePrOptions, Forge,
  ForgeAuthor, ForgeIssue, ForgeIssueComment, PrReference, PrStatus, WorkflowRun,
} from './forge.ts'
import { ForgeRateLimitError } from './forge.ts'

const execFileAsync = promisify(execFile)

// gh writes its errors to stdout too, and one of them names githubstatus.com — close
// enough to a URL that a looser match once stored the error text and every later cycle
// asked gh about a pull request called "check your internet connection".
const PR_URL_PATTERN = /^https:\/\/\S+\/pull\/\d+$/
const ISSUE_URL_PATTERN = /^https:\/\/\S+\/issues\/\d+$/

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
const repositorySchema = z.object({ nameWithOwner: z.string().min(1) })
const repositoryPermissionSchema = z.object({
  permission: z.string(),
  role_name: z.string().nullable().optional(),
})
const labelListSchema = z.array(z.object({ name: z.string() }))

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

const githubAuthorSchema = z.object({ login: z.string() }).nullable()

const githubIssueSchema = z.object({
  number: z.number(),
  state: z.enum(['OPEN', 'CLOSED']),
  title: z.string(),
  body: z.string(),
  author: githubAuthorSchema,
  labels: z.array(z.object({ name: z.string() })),
  assignees: z.array(z.object({ login: z.string() })),
  updatedAt: z.string(),
})

const openGithubIssueListSchema = z.array(githubIssueSchema.extend({ state: z.literal('OPEN') }))
const closedGithubIssueListSchema = z.array(githubIssueSchema.extend({ state: z.literal('CLOSED') }))
const issueCommentsSchema = z.object({
  comments: z.array(z.object({
    body: z.string(),
    author: githubAuthorSchema,
    authorAssociation: z.string(),
  })),
})
const rateLimitSchema = z.object({
  resources: z.object({
    graphql: z.object({ reset: z.number() }),
  }),
})

export type RollupEntry = z.infer<typeof rollupEntrySchema>
export type GithubWorkflowRun = z.infer<typeof workflowRunSchema>
type GithubIssue = z.infer<typeof githubIssueSchema>

const WRITE_PERMISSIONS = new Set(['write', 'maintain', 'admin'])

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
  // The workflow embeds the token in a readable run-name ('Production deploy [<token>]'),
  // so containment is the contract; exact equality also matches older runs' bare titles.
  return runs.find(
    (candidate) => candidate.displayTitle.includes(dispatchToken) && candidate.headBranch === ref,
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

async function withBodyFile<T>(body: string, action: (bodyFile: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'orch-gh-body-'))
  const bodyFile = join(directory, 'body.md')
  try {
    await writeFile(bodyFile, body, 'utf8')
    return await action(bodyFile)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function commandErrorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const commandError = error as Error & { stdout?: unknown; stderr?: unknown }
  return [error.message, commandError.stdout, commandError.stderr]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
}

function reportedResetAt(text: string): Date | undefined {
  const epoch = /(?:x-ratelimit-reset|reset(?:s|ting)?(?: at)?)[^\d]{0,8}(\d{10})/i.exec(text)?.[1]
  if (epoch !== undefined) return new Date(Number(epoch) * 1000)
  const iso = /(?:reset(?:s|ting)?(?: at)?|until)\s*:?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i
    .exec(text)?.[1]
  return iso === undefined ? undefined : new Date(iso)
}

function isRateLimitFailure(error: unknown): boolean {
  return /rate.?limit|HTTP 429/i.test(commandErrorText(error))
}

function githubPrBody(body: string): string {
  // GitHub reads a bare #N in a PR body as an issue reference and links it to some
  // unrelated pull request from the repository's first week. This presentation rule
  // belongs at the forge boundary so the core and other adapters retain the source text.
  return body.replace(/#(\d+)/g, '`#$1`')
}

export type GithubCommand = (repoRoot: string, args: string[]) => Promise<string>

export function createGithubForge(
  repoRoot: string = process.cwd(),
  runGh: GithubCommand = gh,
): Forge {
  const checkedGh: GithubCommand = async (root, args) => {
    try {
      return await runGh(root, args)
    } catch (error) {
      if (!isRateLimitFailure(error)) throw error
      let resetAt = reportedResetAt(commandErrorText(error))
      if (resetAt === undefined) {
        try {
          const rateLimitArgs = ['api', 'rate_limit']
          const stdout = await runGh(root, rateLimitArgs)
          const reset = parseGhJson(rateLimitArgs, stdout, rateLimitSchema).resources.graphql.reset
          resetAt = new Date(reset * 1000)
        } catch {
          // A short fallback still suppresses the poll storm when even rate_limit is unavailable.
          resetAt = new Date(Date.now() + 60_000)
        }
      }
      throw new ForgeRateLimitError(resetAt, { cause: error })
    }
  }

  const parseWorkflowRun = (data: GithubWorkflowRun): WorkflowRun => ({
    id: data.databaseId,
    createdAt: data.createdAt,
    headSha: data.headSha,
    status: data.status,
    conclusion: data.conclusion,
  })

  // The issue queue belongs to the repository this forge was created for. Resolve that
  // identity once and carry it on every queue call instead of letting gh infer a target
  // from a checkout whose remote may belong to a consumer or the upstream package.
  let issueQueueRepositoryPromise: Promise<string> | undefined
  const issueQueueRepository = (): Promise<string> => {
    issueQueueRepositoryPromise ??= (async () => {
      const args = ['repo', 'view', '--json', 'nameWithOwner']
      try {
        const stdout = await checkedGh(repoRoot, args)
        return parseGhJson(args, stdout, repositorySchema).nameWithOwner
      } catch (error) {
        // Resolution failures are not identities. A later poll may recover from a
        // transient forge outage or rate limit and should be allowed to resolve again.
        issueQueueRepositoryPromise = undefined
        if (error instanceof ForgeRateLimitError) throw error
        throw new Error(
          `Unable to resolve the current repository for the issue queue: ${commandErrorText(error)}`,
          { cause: error },
        )
      }
    })()
    return issueQueueRepositoryPromise
  }

  const normalizeAuthor = async (
    author: { login: string } | null,
    permissionCache = new Map<string, Promise<boolean>>(),
  ): Promise<ForgeAuthor> => {
    if (author === null) return { login: '(unknown)', hasWriteAccess: false }
    const repository = await issueQueueRepository()
    const cacheKey = author.login.toLowerCase()
    let permissionPromise = permissionCache.get(cacheKey)
    if (permissionPromise === undefined) {
      permissionPromise = (async () => {
        const encodedRepository = repository.split('/').map(encodeURIComponent).join('/')
        const args = [
          'api', `repos/${encodedRepository}/collaborators/${encodeURIComponent(author.login)}/permission`,
        ]
        try {
          const data = parseGhJson(
            args,
            await checkedGh(repoRoot, args),
            repositoryPermissionSchema,
          )
          return WRITE_PERMISSIONS.has(data.permission.toLowerCase())
            || (data.role_name !== undefined
              && data.role_name !== null
              && WRITE_PERMISSIONS.has(data.role_name.toLowerCase()))
        } catch (error) {
          // Missing collaborators and transient permission lookup failures are both
          // untrusted. Rate limits retain their reset signal so the loop can wait.
          if (error instanceof ForgeRateLimitError) throw error
          return false
        }
      })()
      // Collapse duplicate authors inside this forge response only. A later get/list
      // call must revalidate permission, especially the locked getIssue used by claim.
      permissionCache.set(cacheKey, permissionPromise)
    }
    return { login: author.login, hasWriteAccess: await permissionPromise }
  }

  const normalizeIssue = async (
    issue: GithubIssue,
    permissionCache?: Map<string, Promise<boolean>>,
  ): Promise<ForgeIssue> => ({
    number: issue.number,
    state: issue.state === 'OPEN' ? 'open' : 'closed',
    title: issue.title,
    body: issue.body,
    author: await normalizeAuthor(issue.author, permissionCache),
    labels: issue.labels.map((label) => label.name),
    assignees: issue.assignees.map((assignee) => assignee.login),
    updatedAt: issue.updatedAt,
  })

  return {
    resolveGitRemote(remote: string): string {
      return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(remote)
        ? `https://github.com/${remote.replace(/\.git$/, '')}.git`
        : remote
    },

    issueClosingCommitMessage(message: string, issueNumber: number): string {
      return `${message} (closes #${issueNumber})`
    },

    async prStatus(ref: PrReference): Promise<PrStatus> {
      let stdout: string
      const args = [
        'pr', 'view', String(ref.value),
        '--json', 'url,state,isDraft,headRefOid,statusCheckRollup',
      ]
      try {
        stdout = await checkedGh(repoRoot, args)
      } catch (error) {
        if (error instanceof ForgeRateLimitError) throw error
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
      const stdout = await checkedGh(repoRoot, args)
      return `${parseGhJson(args, stdout, prBodySchema).body}\n`
    },

    async createPr(options: CreatePrOptions): Promise<string> {
      const args = [
        'pr', 'create',
        '--base', options.base,
        '--title', options.title,
        '--body', githubPrBody(options.body),
      ]
      if (options.draft) args.push('--draft')
      const stdout = await checkedGh(repoRoot, args)
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
      if (fields.body !== undefined) args.push('--body', githubPrBody(fields.body))
      if (args.length === 3) return
      await checkedGh(repoRoot, args)
    },

    async markPrReady(ref: string): Promise<void> {
      await checkedGh(repoRoot, ['pr', 'ready', ref])
    },

    async dispatchWorkflow(workflow: string, ref: string, dispatchToken: string): Promise<void> {
      await checkedGh(repoRoot, [
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
      const stdout = await checkedGh(repoRoot, args)
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
      const stdout = await checkedGh(repoRoot, args)
      return parseWorkflowRun(parseGhJson(args, stdout, workflowRunSchema))
    },

    async currentUser(): Promise<string> {
      const args = ['api', 'user']
      const stdout = await checkedGh(repoRoot, args)
      return parseGhJson(args, stdout, currentUserSchema).login
    },

    async listLabels(): Promise<string[]> {
      const repository = await issueQueueRepository()
      const args = ['label', 'list', '--repo', repository, '--limit', '1000', '--json', 'name']
      return parseGhJson(args, await checkedGh(repoRoot, args), labelListSchema)
        .map((label) => label.name)
    },

    async createLabel(name: string, description: string): Promise<void> {
      const repository = await issueQueueRepository()
      await checkedGh(repoRoot, ['label', 'create', name, '--repo', repository,
        '--description', description])
    },

    async createIssue(options: CreateIssueOptions): Promise<number> {
      const repository = await issueQueueRepository()
      const stdout = await withBodyFile(options.body, async (bodyFile) => {
        const args = [
          'issue', 'create', '--repo', repository,
          '--title', options.title, '--body-file', bodyFile,
        ]
        for (const label of options.labels) args.push('--label', label)
        for (const assignee of options.assignees ?? []) args.push('--assignee', assignee)
        return checkedGh(repoRoot, args)
      })
      const match = /\/issues\/(\d+)\s*$/.exec(stdout.trim())
      if (match === null) {
        throw new Error(`gh issue create returned no issue URL: ${stdout.trim()}`)
      }
      return Number(match[1])
    },

    async createIssueInRepository(options: CreateIssueInRepositoryOptions): Promise<string> {
      // One listing, filtered here: gh's --search takes search syntax, and a label whose
      // name carries a colon — which every label this loop uses does — makes it fail
      // rather than match. It also costs one call instead of one per label.
      const labelArgs = [
        'label', 'list', '--repo', options.repository, '--limit', '100', '--json', 'name',
      ]
      const available = parseGhJson(
        labelArgs, await checkedGh(repoRoot, labelArgs), labelListSchema,
      ).map((candidate) => candidate.name)
      const labels = options.optionalLabels.filter((label) => available.includes(label))

      const stdout = await withBodyFile(options.body, async (bodyFile) => {
        const args = [
          'issue', 'create', '--repo', options.repository,
          '--title', options.title, '--body-file', bodyFile,
        ]
        for (const label of labels) args.push('--label', label)
        return checkedGh(repoRoot, args)
      })
      const url = stdout.split(/\r?\n/).map((line) => line.trim())
        .find((line) => ISSUE_URL_PATTERN.test(line))
      if (url === undefined) {
        throw new Error(`gh issue create returned no issue URL: ${stdout.trim()}`)
      }
      return url
    },

    async getIssue(issueNumber: number): Promise<ForgeIssue> {
      const repository = await issueQueueRepository()
      const args = ['issue', 'view', String(issueNumber),
        '--repo', repository,
        '--json', 'number,state,title,body,author,labels,assignees,updatedAt']
      const stdout = await checkedGh(repoRoot, args)
      return normalizeIssue(parseGhJson(args, stdout, githubIssueSchema))
    },

    async commentIssue(issueNumber: number, comment: string): Promise<void> {
      const repository = await issueQueueRepository()
      await checkedGh(repoRoot, [
        'issue', 'comment', String(issueNumber), '--repo', repository, '--body', comment,
      ])
    },

    async listIssueComments(issueNumber: number): Promise<ForgeIssueComment[]> {
      const repository = await issueQueueRepository()
      const args = [
        'issue', 'view', String(issueNumber), '--repo', repository, '--json', 'comments',
      ]
      const stdout = await checkedGh(repoRoot, args)
      const data = parseGhJson(args, stdout, issueCommentsSchema)
      const permissionCache = new Map<string, Promise<boolean>>()
      return Promise.all(data.comments.map(async (comment) => ({
        body: comment.body,
        author: await normalizeAuthor(comment.author, permissionCache),
      })))
    },

    async listOpenIssues(label: string): Promise<ForgeIssue[]> {
      const repository = await issueQueueRepository()
      const args = ['issue', 'list', '--state', 'open',
        '--repo', repository,
        '--label', label, '--limit', '200',
        '--json', 'number,state,title,body,author,labels,assignees,updatedAt']
      const stdout = await checkedGh(repoRoot, args)
      const permissionCache = new Map<string, Promise<boolean>>()
      return Promise.all(parseGhJson(args, stdout, openGithubIssueListSchema)
        .map((issue) => normalizeIssue(issue, permissionCache)))
    },

    async listClosedIssues(label: string): Promise<ForgeIssue[]> {
      const repository = await issueQueueRepository()
      const args = ['issue', 'list', '--state', 'closed',
        '--repo', repository,
        '--label', label, '--limit', '200',
        '--json', 'number,state,title,body,author,labels,assignees,updatedAt']
      const stdout = await checkedGh(repoRoot, args)
      const permissionCache = new Map<string, Promise<boolean>>()
      return Promise.all(parseGhJson(args, stdout, closedGithubIssueListSchema)
        .map((issue) => normalizeIssue(issue, permissionCache)))
    },

    async assignIssue(issueNumber: number, user: string): Promise<void> {
      const repository = await issueQueueRepository()
      await checkedGh(repoRoot, [
        'issue', 'edit', String(issueNumber), '--repo', repository, '--add-assignee', user,
      ])
    },

    async unassignIssue(issueNumber: number, user: string): Promise<void> {
      const repository = await issueQueueRepository()
      await checkedGh(repoRoot, [
        'issue', 'edit', String(issueNumber), '--repo', repository, '--remove-assignee', user,
      ])
    },

    async addLabel(issueNumber: number, label: string): Promise<void> {
      const repository = await issueQueueRepository()
      await checkedGh(repoRoot, [
        'issue', 'edit', String(issueNumber), '--repo', repository, '--add-label', label,
      ])
    },

    async removeLabel(issueNumber: number, label: string): Promise<void> {
      const repository = await issueQueueRepository()
      await checkedGh(repoRoot, [
        'issue', 'edit', String(issueNumber), '--repo', repository, '--remove-label', label,
      ])
    },

    async closeIssue(issueNumber: number, comment: string): Promise<void> {
      const repository = await issueQueueRepository()
      await checkedGh(repoRoot, [
        'issue', 'close', String(issueNumber), '--repo', repository, '--comment', comment,
      ])
    },
  }
}
