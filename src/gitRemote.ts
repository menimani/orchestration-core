import { execFileSync } from 'node:child_process'

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

/** Return the remote named by the current local branch's configured upstream. */
export function currentBranchRemote(repoRoot: string): string {
  const branch = git(repoRoot, ['branch', '--show-current'])
  if (branch === '') throw new Error('the current checkout is not on a branch')

  const remote = git(repoRoot, [
    'for-each-ref', '--format=%(upstream:remotename)', `refs/heads/${branch}`,
  ])
  if (remote === '') throw new Error(`current branch '${branch}' has no upstream`)
  return remote
}
