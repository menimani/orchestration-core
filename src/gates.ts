import { join } from 'node:path'
import type { OrchPaths } from './paths.ts'

// Per-task gate commands, selected by TASK_GATE. "full" runs the suites on every task
// merge; "light" proves the tree builds and lints, and leaves the suites to run once at
// the cycle gate, so a cycle pays for them once instead of once per task. Failure
// attribution survives because a semantic conflict or broken build still stops the task
// that introduced it.

export function frontendGateCmd(taskGate: 'full' | 'light'): string {
  return taskGate === 'light' ? 'npm run lint && npm run build' : 'npm run test'
}

export function backendGateCmd(taskGate: 'full' | 'light'): string {
  return taskGate === 'light' ? 'mvn clean test-compile -q' : 'mvn clean test -q'
}

// Maps a finding's tag to the pitfall list its implementer checks a diff against.
// The lists are curated by hand: at most 20 entries each, a pattern admitted only
// after reviews flagged it twice, the lowest-impact entry dropped at the cap and
// restored past the cap when a dropped pattern recurs.
export function pitfallsFileForDesc(paths: OrchPaths, description: string): string {
  const name = description.startsWith('[TEST]') ? 'tests'
    : description.startsWith('[DOCS]') ? 'docs'
      : 'code'
  return join(paths.root, 'templates', 'pitfalls', `${name}.md`)
}
