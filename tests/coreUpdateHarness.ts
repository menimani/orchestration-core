// The git helpers the core update test files share. The fixture state their tests replace,
// and the helpers that read it, stay in each file.

import { execFileSync } from 'node:child_process'

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

export function configureRepository(root: string): void {
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'core-update@example.test'])
  git(root, ['config', 'user.name', 'Core Update Test'])
}

export function commit(root: string, message: string): string {
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}
