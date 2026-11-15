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

/** One read of the current branch and the repository remotes, shared by the questions about them. */
interface BranchRemoteState {
  branch: string
  remotes: Set<string>
  // Each configured candidate is looked up at most once, and only when asked for.
  candidate: (name: RemoteCandidate) => string
}

type RemoteCandidate = 'pushRemote' | 'pushDefault' | 'upstream' | 'branchRemote'

const PUSH_PRECEDENCE: RemoteCandidate[] = ['pushRemote', 'pushDefault', 'upstream', 'branchRemote']
const TRACKING_PRECEDENCE: RemoteCandidate[] = ['upstream', 'branchRemote', 'pushRemote', 'pushDefault']

function readBranchRemoteState(repoRoot: string, currentBranch?: string): BranchRemoteState {
  const branch = currentBranch ?? git(repoRoot, ['branch', '--show-current'])
  if (branch === '') throw new Error('the current checkout is not on a branch')

  const lookups: Record<RemoteCandidate, string[]> = {
    pushRemote: ['config', '--get', `branch.${branch}.pushRemote`],
    pushDefault: ['config', '--get', 'remote.pushDefault'],
    upstream: ['for-each-ref', '--format=%(upstream:remotename)', `refs/heads/${branch}`],
    branchRemote: ['config', '--get', `branch.${branch}.remote`],
  }
  const answers = new Map<RemoteCandidate, string>()
  return {
    branch,
    remotes: repositoryRemotes(repoRoot),
    candidate: (name) => {
      if (!answers.has(name)) answers.set(name, optionalGit(repoRoot, lookups[name]))
      return answers.get(name)!
    },
  }
}

function resolveCurrentBranchRemote(state: BranchRemoteState, precedence: RemoteCandidate[]): string {
  const { branch, remotes } = state
  for (const name of precedence) {
    const remote = state.candidate(name)
    if (remotes.has(remote)) return remote
  }

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
  return resolveCurrentBranchRemote(readBranchRemoteState(repoRoot), PUSH_PRECEDENCE)
}

/** Return the tracking/base remote before considering a configured push target. */
export function currentBranchTrackingRemote(repoRoot: string): string {
  return resolveCurrentBranchRemote(readBranchRemoteState(repoRoot), TRACKING_PRECEDENCE)
}

/**
 * Return both the push and the tracking remote from one read of the current branch and
 * the repository remotes. A caller that already holds the current branch passes it.
 */
export function currentBranchRemotes(repoRoot: string, currentBranch?: string): {
  push: string
  tracking: string
} {
  const state = readBranchRemoteState(repoRoot, currentBranch)
  return {
    push: resolveCurrentBranchRemote(state, PUSH_PRECEDENCE),
    tracking: resolveCurrentBranchRemote(state, TRACKING_PRECEDENCE),
  }
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
