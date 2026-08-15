import type { ProjectAdapter } from '../src/adapters/project.ts'
import { createClaudeSharedSkills } from '../src/adapters/shared-skills-claude.ts'

export const stubProject: ProjectAdapter = {
  sharedSkills: [createClaudeSharedSkills()],
  preCommitChecks: [],
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
