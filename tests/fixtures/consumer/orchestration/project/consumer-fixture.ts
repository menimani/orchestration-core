import type {
  MergeCheck,
  SuiteStep,
  WorktreeSetupStep,
} from '../ts/src/adapters/project.ts'

const ENVIRONMENT_CHECK = 'orchestration/project/scripts/ensure-environment.ts'
const ORCHESTRATION_MANIFEST = 'orchestration/ts/package.json'

export const consumerFixture: {
  scanWorktreeSetup: WorktreeSetupStep[]
  mergeChecks: MergeCheck[]
  cycleSuite: SuiteStep[]
} = {
  scanWorktreeSetup: [
    {
      label: 'Consumer environment',
      cwd: '',
      command: `node ${ENVIRONMENT_CHECK}`,
      requires: ENVIRONMENT_CHECK,
    },
  ],
  mergeChecks: [
    {
      label: 'Orchestration package',
      cwd: 'orchestration/ts',
      command: 'npm run typecheck',
      requires: ORCHESTRATION_MANIFEST,
    },
  ],
  cycleSuite: [
    {
      label: 'Orchestration suite',
      cwd: 'orchestration/ts',
      command: 'npm test',
      requires: ORCHESTRATION_MANIFEST,
    },
  ],
}
