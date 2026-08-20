import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { WorktreeSetupStep } from './adapters/project.ts'
import { currentBranchTrackingRemote } from './gitRemote.ts'
import { integrationWorktreeDir, PACKAGE_ROOT, type OrchPaths } from './paths.ts'
import { execShellSync } from './shell.ts'

export interface BranchTopology {
  paths: OrchPaths
  packageRoot: string
  daemonBranch: string
  daemonHead: string
  integrationBranch?: string
  validateDaemonCheckout(): string | undefined
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function marker(paths: OrchPaths, name: string): string {
  return join(paths.queueDir, name)
}

function readMarker(paths: OrchPaths, name: string): string | undefined {
  const file = marker(paths, name)
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined
}

function checkoutProblem(repoRoot: string, branch: string, head: string): string | undefined {
  const currentBranch = git(repoRoot, ['branch', '--show-current']).trim()
  if (currentBranch !== branch) {
    return `daemon checkout ${currentBranch} does not match fixed branch ${branch}`
  }
  const currentHead = git(repoRoot, ['rev-parse', 'HEAD']).trim()
  if (currentHead !== head) {
    return `daemon branch ${branch} moved from fixed commit ${head.slice(0, 8)} to ${currentHead.slice(0, 8)}`
  }
  if (git(repoRoot, ['status', '--porcelain']).trim() !== '') {
    return `daemon checkout ${branch} has uncommitted changes`
  }
  return undefined
}

/**
 * Resolve the checkout used for merges. An empty integration branch retains the direct
 * layout. Otherwise the daemon checkout and exact commit are durable run identity, while
 * the integration worktree may advance during a stop without changing the code executing
 * the resumed run.
 */
export function prepareBranchTopology(
  paths: OrchPaths,
  integrationBranch: string,
  packageRoot = PACKAGE_ROOT,
): BranchTopology {
  const recordedBranch = readMarker(paths, 'integration-branch.txt')
  if (recordedBranch !== undefined && recordedBranch !== integrationBranch) {
    throw new Error(
      `This run uses integration branch ${recordedBranch}; refusing ${integrationBranch || 'direct mode'}.`,
    )
  }
  if (integrationBranch === '') {
    return {
      paths,
      packageRoot,
      daemonBranch: '',
      daemonHead: '',
      validateDaemonCheckout: () => undefined,
    }
  }

  const daemonBranch = git(paths.repoRoot, ['branch', '--show-current']).trim()
  const daemonHead = git(paths.repoRoot, ['rev-parse', 'HEAD']).trim()
  if (daemonBranch === '') throw new Error('The daemon checkout must be on a branch.')

  git(paths.repoRoot, ['check-ref-format', '--branch', integrationBranch])
  const recordedDaemonBranch = readMarker(paths, 'daemon-branch.txt')
  const recordedDaemonHead = readMarker(paths, 'daemon-head.txt')
  const resuming = recordedBranch !== undefined
  if (resuming && (recordedDaemonBranch !== daemonBranch || recordedDaemonHead !== daemonHead)) {
    throw new Error(
      `The resumed run is fixed to ${recordedDaemonBranch ?? '(unknown)'} at `
      + `${recordedDaemonHead?.slice(0, 8) ?? '(unknown)'}; the daemon checkout is `
      + `${daemonBranch} at ${daemonHead.slice(0, 8)}.`,
    )
  }
  const problem = checkoutProblem(paths.repoRoot, daemonBranch, daemonHead)
  if (problem !== undefined) throw new Error(problem)

  const worktree = integrationWorktreeDir(paths)
  if (!resuming && existsSync(worktree)) {
    const existingBranch = git(worktree, ['branch', '--show-current']).trim()
    if (existingBranch !== integrationBranch) {
      if (git(worktree, ['status', '--porcelain']).trim() !== '') {
        throw new Error(
          `Previous integration worktree ${worktree} has uncommitted changes on ${existingBranch}.`,
        )
      }
      git(paths.repoRoot, ['worktree', 'remove', worktree])
    }
  }
  if (!existsSync(worktree)) {
    let branchExists = true
    try {
      git(paths.repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${integrationBranch}`])
    } catch {
      branchExists = false
    }
    git(paths.repoRoot, branchExists
      ? ['worktree', 'add', '--quiet', worktree, integrationBranch]
      : ['worktree', 'add', '--quiet', worktree, '-b', integrationBranch, daemonHead])
  }
  const checkedOutBranch = git(worktree, ['branch', '--show-current']).trim()
  if (checkedOutBranch !== integrationBranch) {
    throw new Error(
      `Integration worktree ${worktree} is on ${checkedOutBranch}, expected ${integrationBranch}.`,
    )
  }
  if (!resuming) {
    try {
      git(paths.repoRoot, ['merge-base', '--is-ancestor', daemonHead, integrationBranch])
    } catch {
      throw new Error(
        `Integration branch ${integrationBranch} does not derive from daemon commit ${daemonHead.slice(0, 8)}.`,
      )
    }
  }

  writeFileSync(marker(paths, 'daemon-branch.txt'), `${daemonBranch}\n`)
  writeFileSync(marker(paths, 'daemon-head.txt'), `${daemonHead}\n`)
  writeFileSync(marker(paths, 'integration-branch.txt'), `${integrationBranch}\n`)
  return {
    paths: { ...paths, repoRoot: worktree },
    packageRoot: join(worktree, relative(paths.repoRoot, packageRoot)),
    daemonBranch,
    daemonHead,
    integrationBranch,
    validateDaemonCheckout: () => checkoutProblem(paths.repoRoot, daemonBranch, daemonHead),
  }
}

/** Run adapter-owned setup with all child output kept in its own log. */
export function prepareIntegrationWorktree(
  paths: OrchPaths,
  steps: readonly WorktreeSetupStep[],
  report: (line: string) => void,
): void {
  if (steps.length === 0) return
  const setupLog = join(paths.logsDir, 'integration-setup.log')
  for (const step of steps) {
    if (step.requires !== undefined && !existsSync(join(paths.repoRoot, step.requires))) continue
    report(`Preparing integration worktree: ${step.label}`)
    const fd = openSync(setupLog, 'a')
    try {
      execShellSync(step.command, {
        cwd: join(paths.repoRoot, step.cwd),
        encoding: 'utf8',
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      })
    } finally {
      closeSync(fd)
    }
  }
}

function errorSummary(error: unknown): string {
  const failure = error as { stderr?: string | Buffer }
  const stderr = Buffer.isBuffer(failure.stderr)
    ? failure.stderr.toString('utf8')
    : failure.stderr
  return (stderr?.trim() || (error instanceof Error ? error.message : String(error)))
    .replaceAll(/\s+/g, ' ')
}

/** Merge the advertised default branch into the integration branch at an idle boundary. */
export function absorbDefaultBranch(
  paths: OrchPaths,
  event: (name: 'Updated' | 'WARN', subject: string, detail?: string) => void,
  gitCommand: (cwd: string, args: string[]) => string = git,
): void {
  let remote: string
  let baseCommit: string
  let baseRef: string
  try {
    remote = currentBranchTrackingRemote(paths.repoRoot)
    const advertised = gitCommand(paths.repoRoot, [
      'ls-remote', '--symref', remote, 'HEAD',
    ])
    const branch = /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m.exec(advertised)?.[1]
    if (branch === undefined) throw new Error(`${remote} does not advertise a default branch`)
    gitCommand(paths.repoRoot, ['fetch', '--quiet', remote, branch])
    baseCommit = gitCommand(paths.repoRoot, ['rev-parse', 'FETCH_HEAD']).trim()
    baseRef = `${remote}/${branch}`
  } catch (error) {
    event('WARN', `default branch update failed; continuing: ${errorSummary(error)}`)
    return
  }

  try {
    gitCommand(paths.repoRoot, ['merge-base', '--is-ancestor', baseCommit, 'HEAD'])
    return
  } catch {
    // A merge is needed.
  }
  try {
    if (gitCommand(paths.repoRoot, ['status', '--porcelain']).trim() !== '') {
      event('WARN', 'default branch update skipped: integration worktree is dirty')
      return
    }
  } catch (error) {
    event('WARN', `default branch status check failed; continuing: ${errorSummary(error)}`)
    return
  }
  const oldHead = gitCommand(paths.repoRoot, ['rev-parse', 'HEAD']).trim()
  try {
    gitCommand(paths.repoRoot, ['merge', '--no-edit', baseCommit])
    gitCommand(paths.repoRoot, ['merge-base', '--is-ancestor', baseCommit, 'HEAD'])
    event('Updated', 'default branch', baseRef)
  } catch (error) {
    try {
      gitCommand(paths.repoRoot, ['merge', '--abort'])
    } catch (abortError) {
      throw new Error(
        `default branch merge failed and merge abort failed: ${errorSummary(abortError)}; `
        + `merge failure: ${errorSummary(error)}`,
      )
    }
    let recoveredHead: string
    let recoveredStatus: string
    try {
      recoveredHead = gitCommand(paths.repoRoot, ['rev-parse', 'HEAD']).trim()
      recoveredStatus = gitCommand(paths.repoRoot, ['status', '--porcelain']).trim()
    } catch (verificationError) {
      throw new Error(
        `default branch merge failed and recovery could not be verified: `
        + `${errorSummary(verificationError)}; merge failure: ${errorSummary(error)}`,
      )
    }
    if (recoveredHead !== oldHead || recoveredStatus !== '') {
      throw new Error(
        `default branch merge failed and merge abort did not restore the repository: expected HEAD `
        + `${oldHead.slice(0, 8)}, found ${recoveredHead.slice(0, 8)}; `
        + `working tree ${recoveredStatus === '' ? 'clean' : `dirty (${recoveredStatus.replaceAll(/\r?\n/g, ', ')})`}`,
      )
    }
    event('WARN', `default branch merge conflicted; continuing: ${errorSummary(error)}`)
  }
}
