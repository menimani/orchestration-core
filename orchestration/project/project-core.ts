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
