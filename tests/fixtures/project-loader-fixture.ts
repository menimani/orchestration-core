import type { ProjectAdapter } from '../../src/adapters/project.ts'

export const loaderFixtureProject: ProjectAdapter = {
  name: 'shiora',
  deployment: {
    workflow: 'fixture.yml',
    revisionUrl: 'https://example.com/fixture-revision',
  },
  mergeChecks: () => [],
  cycleSuite: () => [],
}
