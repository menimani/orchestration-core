import { describe, expect, it } from 'vitest'
import {
  createGithubForge, workflowRunForDispatch, type GithubCommand, type GithubWorkflowRun,
} from '../src/adapters/forge-github.ts'
import { ForgeRateLimitError, type Forge } from '../src/adapters/forge.ts'

const workflowRunFixture = {
  databaseId: 71,
  createdAt: '2026-08-08T15:00:00Z',
  displayTitle: 'wanted-token',
  headBranch: 'main',
  headSha: 'wanted-sha',
  status: 'queued',
  conclusion: null,
  futureWorkflowField: 'ignored',
}

const openIssueFixture = {
  number: 357,
  state: 'OPEN',
  title: 'Validate forge JSON',
  body: 'Task body',
  author: { login: 'maintainer-one' },
  authorAssociation: 'MEMBER',
  labels: [{ name: 'loop:ready', color: 'ffffff' }],
  assignees: [{ login: 'worker-one', databaseId: 10 }],
  updatedAt: '2026-08-10T01:00:00Z',
  futureIssueField: 'ignored',
}

function forgeReturning(output: unknown): Forge {
  const command: GithubCommand = async (_root, args) => {
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'example/repo' })
    if (args[0] === 'api' && args[1]?.includes('/collaborators/')) {
      const login = args[1].split('/').at(-2)
      return JSON.stringify({
        permission: login === 'outside-user' ? 'none' : 'admin',
        role_name: login === 'outside-user' ? null : 'admin',
      })
    }
    return JSON.stringify(output)
  }
  return createGithubForge('repo-root', command)
}

async function validationError(
  output: unknown,
  invoke: (forge: Forge) => Promise<unknown>,
): Promise<Error> {
  try {
    await invoke(forgeReturning(output))
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected schema validation to fail')
}

function run(overrides: Partial<GithubWorkflowRun>): GithubWorkflowRun {
  return {
    databaseId: 1,
    createdAt: '2026-08-08T15:00:00Z',
    displayTitle: 'wanted-token',
    headBranch: 'main',
    headSha: 'wanted-sha',
    status: 'queued',
    conclusion: null,
    ...overrides,
  }
}

describe('GitHub issue promotion', () => {
  it('adds GitHub issue-closing syntax to merge commit messages', () => {
    const forge = createGithubForge('repo-root')

    expect(forge.issueClosingCommitMessage('Merge task via orchestration', 42)).toBe(
      'Merge task via orchestration (closes #42)',
    )
  })
})

describe('GitHub pull request bodies', () => {
  it('fences issue-number-like references when creating a pull request', async () => {
    const calls: string[][] = []
    const command: GithubCommand = async (_root, args) => {
      calls.push(args)
      return 'https://github.com/example/repo/pull/12\n'
    }
    const forge = createGithubForge('repo-root', command)

    await forge.createPr({
      branch: 'task/branch',
      base: 'main',
      title: 'Generated PR',
      body: 'Decision #12 remains open',
      draft: false,
    })

    expect(calls[0]).toContain('Decision `#12` remains open')
  })

  it('fences issue-number-like references when updating a pull request', async () => {
    const calls: string[][] = []
    const command: GithubCommand = async (_root, args) => {
      calls.push(args)
      return ''
    }
    const forge = createGithubForge('repo-root', command)

    await forge.updatePr('task/branch', { body: 'Decision #12 remains open' })

    expect(calls[0]).toEqual([
      'pr', 'edit', 'task/branch', '--body', 'Decision `#12` remains open',
    ])
  })
})

describe('GitHub workflow dispatch correlation', () => {
  it('ignores newer concurrent and same-second runs with another token or ref', () => {
    const wanted = run({ databaseId: 71 })
    const runs = [
      run({ databaseId: 74, createdAt: '2026-08-08T15:00:01Z', displayTitle: 'other-token' }),
      run({ databaseId: 73, headBranch: 'release' }),
      run({ databaseId: 72, displayTitle: 'pre-dispatch-run' }),
      wanted,
    ]

    expect(workflowRunForDispatch(runs, 'main', 'wanted-token')).toBe(wanted)
  })

  it('waits when its unique dispatch has not appeared', () => {
    expect(workflowRunForDispatch([
      run({ displayTitle: 'other-token' }),
    ], 'main', 'wanted-token')).toBeUndefined()
  })

  it('matches the token inside the readable run-name wrapper', () => {
    const wanted = run({ displayTitle: 'Production deploy [wanted-token]' })

    expect(workflowRunForDispatch([
      run({ displayTitle: 'Production deploy (manual)' }),
      wanted,
    ], 'main', 'wanted-token')).toBe(wanted)
  })
})

describe('GitHub upstream issue creation', () => {
  it.each([
    { available: [{ name: 'upstream:report' }], expectedLabel: true },
    { available: [], expectedLabel: false },
  ])('applies the optional label only when it exists', async ({ available, expectedLabel }) => {
    const calls: string[][] = []
    const command: GithubCommand = async (_root, args) => {
      calls.push(args)
      return args[0] === 'label'
        ? JSON.stringify(available)
        : 'https://github.com/menimani/orchestration-core/issues/42\n'
    }
    const forge = createGithubForge('repo-root', command)

    await expect(forge.createIssueInRepository({
      repository: 'menimani/orchestration-core',
      title: 'Core defect report',
      body: 'Report body',
      optionalLabels: ['upstream:report'],
    })).resolves.toBe('https://github.com/menimani/orchestration-core/issues/42')

    // No --search: gh reads that as search syntax, and a label name carrying a colon
    // fails there instead of matching. The list is fetched once and filtered locally.
    expect(calls[0]).toEqual([
      'label', 'list', '--repo', 'menimani/orchestration-core',
      '--limit', '100', '--json', 'name',
    ])
    expect(calls[1]).toEqual([
      'issue', 'create', '--repo', 'menimani/orchestration-core',
      '--title', 'Core defect report', '--body', 'Report body',
      ...(expectedLabel ? ['--label', 'upstream:report'] : []),
    ])
  })
})

describe('GitHub issue queue repository targeting', () => {
  it('resolves the repository once and passes it on every queue call', async () => {
    const calls: string[][] = []
    const command: GithubCommand = async (_root, args) => {
      calls.push(args)
      if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'consumer/project' })
      if (args[0] === 'api') return JSON.stringify({ permission: 'write' })
      if (args[0] === 'issue' && args[1] === 'create') {
        return 'https://github.com/consumer/project/issues/42\n'
      }
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify(args.includes('closed')
          ? [{ ...openIssueFixture, state: 'CLOSED' }]
          : [openIssueFixture])
      }
      if (args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify(args.includes('comments')
          ? { comments: [{
            body: 'Queue comment', author: { login: 'maintainer-one' },
            authorAssociation: 'MEMBER',
          }] }
          : openIssueFixture)
      }
      return ''
    }
    const forge = createGithubForge('repo-root', command)

    await forge.ensureLabel('loop:finding', 'Finding')
    await forge.createIssue({ title: 'Finding', body: 'Body', labels: ['loop:finding'] })
    await forge.getIssue(42)
    await forge.commentIssue(42, 'Comment')
    await forge.listIssueComments(42)
    await forge.listOpenIssues('loop:finding')
    await forge.listClosedIssues('loop:finding')
    await forge.assignIssue(42, 'worker-one')
    await forge.unassignIssue(42, 'worker-one')
    await forge.addLabel(42, 'loop:ready')
    await forge.removeLabel(42, 'loop:ready')
    await forge.closeIssue(42, 'Done')

    expect(calls.filter((args) => args[0] === 'repo')).toEqual([
      ['repo', 'view', '--json', 'nameWithOwner'],
    ])
    for (const args of calls.slice(1).filter((args) => args[0] !== 'api')) {
      expect(args, `gh ${args.join(' ')}`).toContain('--repo')
      expect(args, `gh ${args.join(' ')}`).toContain('consumer/project')
    }
  })

  it('fails closed when the current repository cannot be resolved', async () => {
    const calls: string[][] = []
    const command: GithubCommand = async (_root, args) => {
      calls.push(args)
      if (args[0] === 'repo') throw new Error('not a git repository')
      return 'https://github.com/upstream/package/issues/42\n'
    }
    const forge = createGithubForge('repo-root', command)

    await expect(forge.createIssue({
      title: 'Finding',
      body: 'Body',
      labels: ['loop:finding'],
    })).rejects.toThrow('Unable to resolve the current repository for the issue queue')
    expect(calls).toEqual([['repo', 'view', '--json', 'nameWithOwner']])
  })
})

describe('GitHub author permissions', () => {
  it('trusts actual write-level permission, not author association, and caches each login', async () => {
    const calls: string[][] = []
    const issues = [
      { ...openIssueFixture, number: 1, author: { login: 'read-member' }, authorAssociation: 'MEMBER' },
      { ...openIssueFixture, number: 2, author: { login: 'triage-collaborator' }, authorAssociation: 'COLLABORATOR' },
      { ...openIssueFixture, number: 3, author: { login: 'maintainer' }, authorAssociation: 'NONE' },
      { ...openIssueFixture, number: 4, author: { login: 'maintainer' }, authorAssociation: 'MEMBER' },
    ]
    const command: GithubCommand = async (_root, args) => {
      calls.push(args)
      if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'example/repo' })
      if (args[0] === 'issue') return JSON.stringify(issues)
      const login = args[1]?.split('/').at(-2)
      const permission = login === 'read-member' ? 'read'
        : login === 'triage-collaborator' ? 'triage'
          : 'maintain'
      return JSON.stringify({ permission })
    }
    const forge = createGithubForge('repo-root', command)

    const normalized = await forge.listOpenIssues('loop:ready')

    expect(normalized.map((issue) => issue.author.hasWriteAccess))
      .toEqual([false, false, true, true])
    expect(calls.filter((args) => args[0] === 'api')).toHaveLength(3)
  })
})

describe('GitHub forge JSON schemas', () => {
  it.each([
    [{ kind: 'branch', value: 'task/branch' } as const, 'task/branch'],
    [{ kind: 'number', value: 12 } as const, '12'],
    [{ kind: 'url', value: 'https://github.com/example/repo/pull/12' } as const,
      'https://github.com/example/repo/pull/12'],
  ])('translates a forge-neutral PR reference for gh', async (ref, expected) => {
    const calls: string[][] = []
    const command: GithubCommand = async (_root, args) => {
      calls.push(args)
      return JSON.stringify({
        url: 'https://github.com/example/repo/pull/12',
        state: 'OPEN',
        isDraft: false,
        headRefOid: 'abc123',
        statusCheckRollup: [],
      })
    }

    await createGithubForge('repo-root', command).prStatus(ref)

    expect(calls).toEqual([[
      'pr', 'view', expected, '--json', 'url,state,isDraft,headRefOid,statusCheckRollup',
    ]])
  })

  it('queries the GraphQL reset when a rate-limit error does not report one', async () => {
    const calls: string[][] = []
    const command: GithubCommand = async (_root, args) => {
      calls.push(args)
      if (args.join(' ') === 'repo view --json nameWithOwner') {
        return JSON.stringify({ nameWithOwner: 'example/repo' })
      }
      if (args.join(' ') === 'api rate_limit') {
        return JSON.stringify({ resources: { graphql: { reset: 1_786_435_200 } } })
      }
      throw new Error('GraphQL: API rate limit exceeded')
    }
    const forge = createGithubForge('repo-root', command)

    let error: unknown
    try {
      await forge.listOpenIssues('loop:finding')
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(ForgeRateLimitError)
    expect((error as ForgeRateLimitError).resetAt.toISOString()).toBe('2026-08-11T08:00:00.000Z')
    expect(calls.map((args) => args.join(' '))).toEqual([
      'repo view --json nameWithOwner',
      'issue list --state open --repo example/repo --label loop:finding --limit 200 --json number,state,title,body,author,labels,assignees,updatedAt',
      'api rate_limit',
    ])
  })

  it('validates and normalizes PR details and check rollups', async () => {
    const forge = forgeReturning({
      url: 'https://github.com/example/repo/pull/12',
      state: 'OPEN',
      isDraft: true,
      headRefOid: 'abc123',
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'build',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          startedAt: '2026-08-10T01:01:00Z',
          futureCheckField: 'ignored',
        },
        {
          __typename: 'StatusContext',
          context: 'deploy',
          state: 'PENDING',
          startedAt: '2026-08-10T01:02:00Z',
        },
      ],
      futurePrField: 'ignored',
    })

    await expect(forge.prStatus({ kind: 'branch', value: 'task/branch' })).resolves.toEqual({
      state: 'open',
      isDraft: true,
      url: 'https://github.com/example/repo/pull/12',
      headSha: 'abc123',
      checks: [
        { name: 'build', conclusion: 'success', startedAt: '2026-08-10T01:01:00Z' },
        { name: 'deploy', conclusion: 'pending', startedAt: '2026-08-10T01:02:00Z' },
      ],
    })
  })

  it('validates PR bodies and preserves the gh jq output normalization', async () => {
    await expect(forgeReturning({ body: 'Generated body', futureField: true }).prBody('12'))
      .resolves.toBe('Generated body\n')
  })

  it('validates and normalizes workflow run lists and views', async () => {
    await expect(forgeReturning([workflowRunFixture]).findWorkflowRun(
      'deploy.yml', 'main', 'wanted-token',
    )).resolves.toEqual({
      id: 71,
      createdAt: '2026-08-08T15:00:00Z',
      headSha: 'wanted-sha',
      status: 'queued',
      conclusion: null,
    })
    await expect(forgeReturning(workflowRunFixture).getWorkflowRun(71)).resolves.toEqual({
      id: 71,
      createdAt: '2026-08-08T15:00:00Z',
      headSha: 'wanted-sha',
      status: 'queued',
      conclusion: null,
    })
  })

  it('validates and normalizes issue views, lists, and comments', async () => {
    const normalizedOpenIssue = {
      number: 357,
      state: 'open',
      title: 'Validate forge JSON',
      body: 'Task body',
      author: { login: 'maintainer-one', hasWriteAccess: true },
      labels: ['loop:ready'],
      assignees: ['worker-one'],
      updatedAt: '2026-08-10T01:00:00Z',
    }
    await expect(forgeReturning(openIssueFixture).getIssue(357)).resolves
      .toEqual(normalizedOpenIssue)
    await expect(forgeReturning([openIssueFixture]).listOpenIssues('loop:ready')).resolves
      .toEqual([normalizedOpenIssue])
    await expect(forgeReturning([{ ...openIssueFixture, state: 'CLOSED' }])
      .listClosedIssues('loop:done')).resolves.toEqual([{ ...normalizedOpenIssue, state: 'closed' }])
    await expect(forgeReturning({
      comments: [{
        body: 'claimed', author: { login: 'outside-user' },
        authorAssociation: 'NONE', futureCommentField: 1,
      }],
      futureCommentsField: true,
    }).listIssueComments(357)).resolves.toEqual([{
      body: 'claimed', author: { login: 'outside-user', hasWriteAccess: false },
    }])
    await expect(forgeReturning({
      ...openIssueFixture, author: null, authorAssociation: 'NONE',
    }).getIssue(357)).resolves.toMatchObject({
      author: { login: '(unknown)', hasWriteAccess: false },
    })
  })

  it('validates and normalizes the current user response', async () => {
    await expect(forgeReturning({ login: 'worker-one', avatar_url: 'future-field' }).currentUser())
      .resolves.toBe('worker-one')
  })

  it('names the gh command and missing field path in validation errors', async () => {
    const cases: Array<{
      output: unknown
      invoke: (forge: Forge) => Promise<unknown>
      command: string
      path: string
    }> = [
      {
        output: {
          url: 'https://github.com/example/repo/pull/12',
          state: 'OPEN',
          isDraft: false,
          statusCheckRollup: [],
        },
        invoke: (forge) => forge.prStatus({ kind: 'branch', value: 'task/branch' }),
        command: 'gh pr view',
        path: 'headRefOid',
      },
      {
        output: {},
        invoke: (forge) => forge.prBody('12'),
        command: 'gh pr view',
        path: 'body',
      },
      {
        output: [{ ...workflowRunFixture, headSha: undefined }],
        invoke: (forge) => forge.findWorkflowRun('deploy.yml', 'main', 'wanted-token'),
        command: 'gh run list',
        path: '[0].headSha',
      },
      {
        output: { ...openIssueFixture, labels: [{}] },
        invoke: (forge) => forge.getIssue(357),
        command: 'gh issue view',
        path: 'labels[0].name',
      },
      {
        output: { comments: [{ author: { login: 'worker' }, authorAssociation: 'MEMBER' }] },
        invoke: (forge) => forge.listIssueComments(357),
        command: 'gh issue view',
        path: 'comments[0].body',
      },
      {
        output: {},
        invoke: (forge) => forge.currentUser(),
        command: 'gh api user',
        path: 'login',
      },
    ]

    for (const testCase of cases) {
      const error = await validationError(testCase.output, testCase.invoke)
      expect(error.message).toContain(testCase.command)
      expect(error.message).toContain(testCase.path)
    }
  })

  it('names the gh command and wrong-typed field path in validation errors', async () => {
    const cases: Array<{
      output: unknown
      invoke: (forge: Forge) => Promise<unknown>
      command: string
      path: string
    }> = [
      {
        output: {
          url: 'https://github.com/example/repo/pull/12',
          state: 'OPEN',
          isDraft: false,
          headRefOid: 'abc123',
          statusCheckRollup: [{ startedAt: 42 }],
        },
        invoke: (forge) => forge.prStatus({ kind: 'branch', value: 'task/branch' }),
        command: 'gh pr view',
        path: 'statusCheckRollup[0].startedAt',
      },
      {
        output: { ...workflowRunFixture, databaseId: '71' },
        invoke: (forge) => forge.getWorkflowRun(71),
        command: 'gh run view',
        path: 'databaseId',
      },
      {
        output: [{ ...openIssueFixture, number: '357' }],
        invoke: (forge) => forge.listOpenIssues('loop:ready'),
        command: 'gh issue list',
        path: '[0].number',
      },
      {
        output: [{ ...openIssueFixture, state: 'CLOSED', updatedAt: 42 }],
        invoke: (forge) => forge.listClosedIssues('loop:done'),
        command: 'gh issue list',
        path: '[0].updatedAt',
      },
      {
        output: { comments: [{
          body: 42, author: { login: 'worker' }, authorAssociation: 'MEMBER',
        }] },
        invoke: (forge) => forge.listIssueComments(357),
        command: 'gh issue view',
        path: 'comments[0].body',
      },
    ]

    for (const testCase of cases) {
      const error = await validationError(testCase.output, testCase.invoke)
      expect(error.message).toContain(testCase.command)
      expect(error.message).toContain(testCase.path)
    }
  })
})

describe('gh JSON field selections', () => {
  // gh rejects the whole command when a --json selection names a field it does not
  // support, so an invalid name is not a degraded response but a dead adapter. The
  // fake forge in every other test answers whatever it is asked, which is exactly
  // why 'authorAssociation' — a field gh offers on comments but not on issues —
  // reached a release and stopped the loop before its first scan.
  const ISSUE_FIELDS = new Set([
    'assignees', 'author', 'body', 'closed', 'closedAt', 'comments', 'createdAt',
    'id', 'isPinned', 'labels', 'milestone', 'number', 'projectCards', 'projectItems',
    'reactionGroups', 'state', 'stateReason', 'title', 'updatedAt', 'url',
  ])

  it('asks issue list and issue view only for fields gh supports', async () => {
    const calls: string[][] = []
    const command: GithubCommand = async (_root, args) => {
      calls.push(args)
      if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'example/repo' })
      if (args[0] === 'api') return JSON.stringify({ permission: 'admin', role_name: 'admin' })
      if (args[1] === 'view') return JSON.stringify(openIssueFixture)
      return '[]'
    }
    const forge = createGithubForge('repo-root', command)

    await forge.listOpenIssues('loop:finding')
    await forge.listClosedIssues('loop:finding')
    await forge.getIssue(1)

    const selections = calls
      .filter((args) => args[0] === 'issue' && (args[1] === 'list' || args[1] === 'view'))
      .map((args) => args[args.indexOf('--json') + 1] as string)

    expect(selections.length).toBe(3)
    for (const selection of selections) {
      for (const field of selection.split(',')) {
        expect(ISSUE_FIELDS.has(field), `gh does not offer ${field} on issues`).toBe(true)
      }
    }
  })
})
