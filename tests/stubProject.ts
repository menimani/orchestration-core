import type { ProjectAdapter } from '../src/adapters/project.ts'

export const stubProject: ProjectAdapter = {
  name: 'test',
  mergeChecks: () => [],
  cycleSuite: () => [],
}
