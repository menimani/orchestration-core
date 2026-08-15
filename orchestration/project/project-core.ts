import type { MergeCheck, ProjectAdapter, SuiteStep } from '../../src/adapters/project.ts'
import { createClaudeSharedSkills } from '../../src/adapters/shared-skills-claude.ts'

// The package this adapter gates is the same one running the loop, so both gates are the
// package's own checks: its source-language rule, the type checker the sources are
// executed under, and the suite that pins SPEC.md. A task runs in a fresh worktree, which
// carries the lockfile but no node_modules, so commands that need dependencies install first.
//
// The suite is single-threaded because its fixtures drive real git repositories in
// temporary directories, and parallel workers made those fixtures race.

const INSTALL = 'node orchestration/project/safe-npm-ci.ts'
const ENGLISH_ONLY = 'node checks/english-only.ts'
const TYPECHECK = 'npx tsc --noEmit'
const SUITE = 'npm test -- --pool=threads --poolOptions.threads.singleThread'

export const coreProject: ProjectAdapter = {
  name: 'core',
  sharedSkills: [createClaudeSharedSkills()],
  verifyDependencyIsolation: true,
  integrationWorktreeSetup: [{
    label: 'Core dependencies',
    cwd: '',
    command: INSTALL,
  }],

  preCommitChecks: [
    {
      label: 'English-only sources',
      cwd: '',
      command: ENGLISH_ONLY,
    },
    {
      label: 'TypeScript typecheck',
      cwd: '',
      command: 'npm run typecheck',
      appliesTo: (files) => files.some((file) => file.endsWith('.ts')),
    },
  ],

  pullRequest: {
    categories: [
      { label: 'Features', title: { singular: 'feature', plural: 'features' } },
      { label: 'Bug Fixes', title: { singular: 'fix', plural: 'fixes' } },
      { label: 'Security', title: { singular: 'security fix', plural: 'security fixes' } },
      { label: 'Project Operations' },
    ],
    titleFallback: 'tooling and documentation only',
    classifyCommit({ subject, files }) {
      if (/security|escape|token|injection|permission/i.test(subject)) {
        return { category: 'Security', area: 'Core' }
      }
      if (files.length > 0 && files.every((file) =>
        file.startsWith('orchestration/') || file.startsWith('.github/'))) {
        return { category: 'Project Operations' }
      }
      const category = subject.startsWith('feat:') ? 'Features' : 'Bug Fixes'
      if (files.some((file) => file.startsWith('src/adapters/'))) {
        return { category, area: 'Adapters' }
      }
      if (files.some((file) => file.startsWith('src/'))) return { category, area: 'Core' }
      if (files.some((file) => file.startsWith('tests/'))) return { category, area: 'Tests' }
      return { category }
    },
    detectRisks({ files, deletedFiles }) {
      const risks: string[] = []
      const deletedTests = deletedFiles.filter((file) => /test/i.test(file))
      if (deletedTests.length > 0) {
        risks.push(`Deletes test files, removing the verification they provided:\n${deletedTests
          .map((file) => `  - ${file}`).join('\n')}`)
      }
      if (files.some((file) => file === 'package.json' || file === 'package-lock.json')) {
        risks.push('Changes the package manifest or dependency lockfile')
      }
      if (files.includes('src/adapters/project.ts')) {
        risks.push('Changes the project-adapter contract consumed outside this package')
      }
      return risks
    },
  },

  mergeChecks(taskGate: 'full' | 'light'): MergeCheck[] {
    return [
      {
        label: 'Core gate',
        cwd: '',
        command: taskGate === 'light'
          ? `${ENGLISH_ONLY} && ${INSTALL} && ${TYPECHECK}`
          : `${ENGLISH_ONLY} && ${INSTALL} && ${TYPECHECK} && ${SUITE}`,
      },
    ]
  },

  cycleSuite(): SuiteStep[] {
    return [
      {
        label: 'Core suite',
        cwd: '',
        command: `${ENGLISH_ONLY} && ${INSTALL} && ${TYPECHECK} && ${SUITE}`,
      },
    ]
  },
}
