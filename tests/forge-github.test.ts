import { describe, expect, it } from 'vitest'
import {
  createGithubForge, workflowRunForDispatch, type GithubCommand, type GithubWorkflowRun,
} from '../src/adapters/forge-github.ts'
import type { Forge } from '../src/adapters/forge.ts'

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
  labels: [{ name: 'loop:ready', color: 'ffffff' }],
  assignees: [{ login: 'worker-one', databaseId: 10 }],
  updatedAt: '2026-08-10T01:00:00Z',
  futureIssueField: 'ignored',
}

function forgeReturning(output: unknown): Forge {
  const command: GithubCommand = async () => JSON.stringify(output)
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
})

describe('GitHub forge JSON schemas', () => {
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

    await expect(forge.prStatus('task/branch')).resolves.toEqual({
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
      comments: [{ body: 'claimed', futureCommentField: 1 }],
      futureCommentsField: true,
    }).listIssueComments(357)).resolves.toEqual(['claimed'])
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
        invoke: (forge) => forge.prStatus('task/branch'),
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
        output: { comments: [{}] },
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
        invoke: (forge) => forge.prStatus('task/branch'),
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
        output: { comments: [{ body: 42 }] },
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
