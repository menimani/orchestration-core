import type { MergeCheck, ProjectAdapter, SuiteStep } from './project.ts'

// What this repository's checks are and when they apply. The i18n check runs on either
// side of the translation contract, because a backend-only change can still leave a
// user looking at a raw messageId. The English check is repository-wide and cheap, so
// it runs whatever changed. The full/light distinction: "full" runs the suites on every
// task merge; "light" proves the tree builds and lints, and leaves the suites to the
// cycle gate so a cycle pays for them once instead of once per task.

const I18N_PATHS = /^src\/frontend\/src\/i18n\/|^src\/backend\/src\/main\/resources\/messages/

export const shioraProject: ProjectAdapter = {
  name: 'shiora',
  deployment: { workflow: 'deploy.yml', url: 'https://shiora.jp' },

  mergeChecks(taskGate: 'full' | 'light'): MergeCheck[] {
    return [
      {
        label: 'Frontend gate',
        cwd: 'src/frontend',
        command: taskGate === 'light' ? 'npm run lint && npm run build' : 'npm run test',
        appliesTo: (changed) => changed.some((file) => file.startsWith('src/frontend/')),
        requires: 'src/frontend',
      },
      {
        // A clean build, because a task that removed a compiled migration to prove its
        // own test fails leaves that hole behind, and an incremental run then tests a
        // schema nobody will deploy.
        label: 'Backend gate',
        cwd: 'src/backend',
        command: taskGate === 'light' ? 'mvn clean test-compile -q' : 'mvn clean test -q',
        appliesTo: (changed) => changed.some((file) => file.startsWith('src/backend/')),
        requires: 'src/backend',
      },
      {
        // npm ci first: the gate runs in a fresh task worktree, which has the lockfile
        // but no node_modules — without the install every orchestration-touching merge
        // fails on missing tools, not on its diff.
        label: 'Orchestration gate',
        cwd: 'orchestration/ts',
        command: 'npm ci --no-audit --no-fund && npm run typecheck && npm run test -- --pool=threads --poolOptions.threads.singleThread',
        appliesTo: (changed) => changed.some((file) => file.startsWith('orchestration/')),
        requires: 'orchestration/ts/package.json',
      },
      {
        label: 'Translation completeness',
        cwd: '',
        command: 'node checks/i18n-keys.js',
        appliesTo: (changed) => changed.some((file) => I18N_PATHS.test(file)),
        requires: 'checks/i18n-keys.js',
      },
      {
        label: 'English only',
        cwd: '',
        command: 'node checks/english-only.mjs',
        requires: 'checks/english-only.mjs',
      },
    ]
  },

  cycleSuite(): SuiteStep[] {
    return [
      {
        label: 'Frontend suite',
        cwd: 'src/frontend',
        command: 'npm run test',
        requires: 'src/frontend',
        // The vitest launcher shims in node_modules/.bin vanished twice while the
        // package itself stayed installed, and each time the suite reported the tree as
        // failing when only the environment was broken. Reinstalling is cheap against
        // an intact lockfile.
        repairWhenMissing: {
          path: 'src/frontend/node_modules/.bin/vitest',
          command: 'npm install --no-audit --no-fund',
          message: 'the vitest launcher is missing — running npm install to restore it',
        },
      },
      {
        label: 'Backend suite',
        cwd: 'src/backend',
        command: 'mvn clean test -q',
        requires: 'src/backend',
      },
      {
        label: 'Translation completeness',
        cwd: '',
        command: 'node checks/i18n-keys.js',
        requires: 'checks/i18n-keys.js',
      },
      {
        label: 'English only',
        cwd: '',
        command: 'node checks/english-only.mjs',
        requires: 'checks/english-only.mjs',
      },
    ]
  },
}
