import type { MergeCheck, ProjectAdapter, SuiteStep } from '../../src/adapters/project.ts'

// The package this adapter gates is the same one running the loop, so both gates are the
// package's own two commands: the type checker the sources are executed under, and the
// suite that pins SPEC.md. A task runs in a fresh worktree, which carries the lockfile but
// no node_modules, so every command installs first.
//
// The suite is single-threaded because its fixtures drive real git repositories in
// temporary directories, and parallel workers made those fixtures race.

const INSTALL = 'npm ci --no-audit --no-fund'
const TYPECHECK = 'npx tsc --noEmit'
const SUITE = 'npm test -- --pool=threads --poolOptions.threads.singleThread'

export const coreProject: ProjectAdapter = {
  name: 'core',
  verifyDependencyIsolation: true,

  preCommitChecks: [
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
          ? `${INSTALL} && ${TYPECHECK}`
          : `${INSTALL} && ${TYPECHECK} && ${SUITE}`,
      },
    ]
  },

  cycleSuite(): SuiteStep[] {
    return [
      {
        label: 'Core suite',
        cwd: '',
        command: `${INSTALL} && ${TYPECHECK} && ${SUITE}`,
      },
    ]
  },
}
