import { describe, expect, it } from 'vitest'
import {
  workflowRunForDispatch, type GithubWorkflowRun,
} from '../src/adapters/forge-github.ts'

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
