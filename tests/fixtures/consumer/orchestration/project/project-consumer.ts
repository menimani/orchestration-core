import type {
  MergeCheck,
  ProjectAdapter,
  SuiteStep,
} from '../ts/src/adapters/project.ts'

const ENVIRONMENT_CHECK = 'orchestration/project/scripts/ensure-environment.ts'
const ORCHESTRATION_MANIFEST = 'orchestration/ts/package.json'

export const consumerProject: ProjectAdapter = {
  name: 'consumer',
  preCommitChecks: [],
  scanWorktreeSetup: [
    {
      label: 'Consumer environment',
      cwd: '',
      command: `node ${ENVIRONMENT_CHECK}`,
      requires: ENVIRONMENT_CHECK,
    },
  ],

  mergeChecks(_taskGate: 'full' | 'light'): MergeCheck[] {
    return [
      {
        label: 'Orchestration package',
        cwd: 'orchestration/ts',
        command: 'npm run typecheck',
        requires: ORCHESTRATION_MANIFEST,
      },
    ]
  },

  cycleSuite(): SuiteStep[] {
    return [
      {
        label: 'Orchestration suite',
        cwd: 'orchestration/ts',
        command: 'npm test',
        requires: ORCHESTRATION_MANIFEST,
      },
    ]
  },

  pullRequest: {
    categories: [
      { label: 'Features', title: { singular: 'feature', plural: 'features' } },
      { label: 'Bug Fixes', title: { singular: 'fix', plural: 'fixes' } },
    ],
    titleFallback: 'tooling only',
    classifyCommit: ({ subject }) => ({
      category: subject.startsWith('feat:') ? 'Features' : 'Bug Fixes',
    }),
    detectRisks: () => [],
  },
}
