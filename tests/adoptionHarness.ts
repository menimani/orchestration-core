// The helpers the merger adoption test files share. The state their tests replace, and
// the helpers that read it, stay in each file, as do the vi.mock calls, because Vitest
// hoists a mock only within the file that calls it.

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Runner } from '../src/adapters/runner.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

export const runner: Runner = {
  sharedSkills: fakeRunnerSharedSkills,
  start: async () => process.pid,
}

/** A merger and a worker checkout sharing one bare origin, all beside each other. */
export function buildCheckouts(root: string): void {
  const merger = join(root, 'merger')
  const worker = join(root, 'worker')
  const bareOrigin = join(root, 'origin.git')
  git(root, ['init', '-q', '-b', 'main', merger])
  git(root, ['init', '-q', '--bare', bareOrigin])
  git(merger, ['config', 'user.email', 'test@example.com'])
  git(merger, ['config', 'user.name', 'Test'])
  writeFileSync(join(merger, 'README.md'), '# repo\n')
  git(merger, ['add', 'README.md'])
  git(merger, ['commit', '-qm', 'chore: initial commit'])
  git(merger, ['remote', 'add', 'origin', bareOrigin])
  git(merger, ['push', '-q', '-u', 'origin', 'main'])
  git(root, ['clone', '-q', '-b', 'main', bareOrigin, worker])
  git(worker, ['config', 'user.email', 'worker@example.com'])
  git(worker, ['config', 'user.name', 'Worker'])
}
