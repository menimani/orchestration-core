import type { ProjectAdapter } from '../../src/adapters/project.ts'

export const loaderFixtureProject: ProjectAdapter = {
  preCommitChecks: [],
  name: 'shiora',
  pullRequest: {
    categories: [{ label: 'Changes' }],
    titleFallback: 'no changes',
    classifyCommit: () => ({ category: 'Changes' }),
    detectRisks: () => [],
  },
  deployment: {
    workflow: 'fixture.yml',
    revisionUrl: 'https://example.com/fixture-revision',
  },
  mergeChecks: () => [],
  cycleSuite: () => [],
}
