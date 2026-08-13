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

function resolveCurrentBranchRemote(
  repoRoot: string,
  configuredRemotes: (branch: string) => string[],
): string {
  const branch = git(repoRoot, ['branch', '--show-current'])
  if (branch === '') throw new Error('the current checkout is not on a branch')

  const remotes = repositoryRemotes(repoRoot)
  const configured = configuredRemotes(branch).find((remote) => remotes.has(remote))
  if (configured !== undefined) return configured

  if (remotes.size === 1) return [...remotes][0]!
  if (remotes.size === 0) throw new Error('repository has no configured remote')
  const remoteNames = [...remotes].sort().join(', ')
  throw new Error(
    `current branch '${branch}' has no upstream and the repository has multiple remotes: ${remoteNames}; `
      + `push the branch with an upstream, or configure branch.${branch}.remote`,
  )
}

/** Return the push remote using Git's configured precedence, or the only remote. */
export function currentBranchPushRemote(repoRoot: string): string {
  return resolveCurrentBranchRemote(repoRoot, (branch) => [
    optionalGit(repoRoot, ['config', '--get', `branch.${branch}.pushRemote`]),
    optionalGit(repoRoot, ['config', '--get', 'remote.pushDefault']),
    optionalGit(repoRoot, [
      'for-each-ref', '--format=%(upstream:remotename)', `refs/heads/${branch}`,
    ]),
    optionalGit(repoRoot, ['config', '--get', `branch.${branch}.remote`]),
  ])
}

/** Return the tracking/base remote before considering a configured push target. */
export function currentBranchTrackingRemote(repoRoot: string): string {
  return resolveCurrentBranchRemote(repoRoot, (branch) => [
    optionalGit(repoRoot, [
      'for-each-ref', '--format=%(upstream:remotename)', `refs/heads/${branch}`,
    ]),
    optionalGit(repoRoot, ['config', '--get', `branch.${branch}.remote`]),
    optionalGit(repoRoot, ['config', '--get', `branch.${branch}.pushRemote`]),
    optionalGit(repoRoot, ['config', '--get', 'remote.pushDefault']),
  ])
}

/** Return the branch advertised as HEAD by the current branch's tracking/base remote. */
export function currentRemoteDefaultBranch(repoRoot: string): {
  branch: string
  remote: string
} {
  const remote = currentBranchTrackingRemote(repoRoot)
  const advertised = git(repoRoot, ['ls-remote', '--symref', remote, 'HEAD'])
  const branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(advertised)?.[1]
  if (branch === undefined || branch === '') {
    throw new Error(`remote '${remote}' does not advertise a default branch`)
  }
  return { branch, remote }
}

/** Return the repository remote explicitly named by a remote-tracking base ref. */
export function remoteForBaseRef(repoRoot: string, baseRef: string): string | undefined {
  return [...repositoryRemotes(repoRoot)]
    .sort((left, right) => right.length - left.length)
    .find((remote) => baseRef.startsWith(`${remote}/`)
      || baseRef.startsWith(`refs/remotes/${remote}/`))
}
