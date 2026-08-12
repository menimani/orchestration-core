import { execFileSync } from 'node:child_process'

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

function optionalGit(repoRoot: string, args: string[]): string {
  try {
    return git(repoRoot, args)
  } catch {
    return ''
  }
}

function repositoryRemotes(repoRoot: string): Set<string> {
  return new Set(
    optionalGit(repoRoot, ['remote']).split(/\r?\n/).filter((remote) => remote !== ''),
  )
}

/** Return the push remote using Git's configured precedence, or the only remote. */
export function currentBranchRemote(repoRoot: string): string {
  const branch = git(repoRoot, ['branch', '--show-current'])
  if (branch === '') throw new Error('the current checkout is not on a branch')

  const remotes = repositoryRemotes(repoRoot)
  const configured = [
    optionalGit(repoRoot, ['config', '--get', `branch.${branch}.pushRemote`]),
    optionalGit(repoRoot, ['config', '--get', 'remote.pushDefault']),
    optionalGit(repoRoot, [
      'for-each-ref', '--format=%(upstream:remotename)', `refs/heads/${branch}`,
    ]),
    optionalGit(repoRoot, ['config', '--get', `branch.${branch}.remote`]),
  ].find((remote) => remotes.has(remote))
  if (configured !== undefined) return configured

  if (remotes.size === 1) return [...remotes][0]!
  if (remotes.size === 0) throw new Error('repository has no configured remote')
  throw new Error(
    `current branch '${branch}' has no upstream and the repository has multiple remotes`,
  )
}

/** Return the repository remote explicitly named by a remote-tracking base ref. */
export function remoteForBaseRef(repoRoot: string, baseRef: string): string | undefined {
  return [...repositoryRemotes(repoRoot)]
    .sort((left, right) => right.length - left.length)
    .find((remote) => baseRef.startsWith(`${remote}/`)
      || baseRef.startsWith(`refs/remotes/${remote}/`))
}
