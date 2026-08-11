import type { ProjectAdapter } from '../src/adapters/project.ts'

export const stubProject: ProjectAdapter = {
  name: 'test',
  pullRequest: {
    categories: [
      { label: 'Features', title: { singular: 'feature', plural: 'features' } },
      { label: 'Bug Fixes', title: { singular: 'fix', plural: 'fixes' } },
    ],
    titleFallback: 'tooling and documentation only',
    classifyCommit: ({ subject }) => ({
      category: subject.startsWith('feat:') ? 'Features' : 'Bug Fixes',
    }),
    detectRisks: () => [],
  },
  mergeChecks: () => [],
  cycleSuite: () => [],
}
