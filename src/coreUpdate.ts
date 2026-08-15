import { execFileSync } from 'node:child_process'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { LoopConfig } from './config.ts'
import type { Forge } from './adapters/forge.ts'
import type { ProjectAdapter } from './adapters/project.ts'
import type { Runner } from './adapters/runner.ts'
import { PACKAGE_ROOT, packageSubtreePrefix, type OrchPaths } from './paths.ts'
import { sharedSkillManagedTargets, syncSharedSkills } from './sharedSkills.ts'

export type CoreUpdateOutcome = 'continue' | 'restart'

export type CoreUpdateEvent = (
  name: 'Updated' | 'Restarting' | 'WARN',
  subject: string,
  detail?: string,
) => void

export interface CoreUpdateRuntime {
  packageRoot?: string
  git(repoRoot: string, args: string[]): string
}

const defaultRuntime: CoreUpdateRuntime = {
  git: (repoRoot, args) => execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }),
}

function summary(error: unknown): string {
  const candidate = error as { stderr?: string | Buffer }
  const stderr = Buffer.isBuffer(candidate.stderr)
    ? candidate.stderr.toString('utf8')
    : candidate.stderr
  return (stderr?.trim() || (error instanceof Error ? error.message : String(error)))
    .replaceAll(/\s+/g, ' ')
}

function importSplit(message: string, prefix: string): string | undefined {
  const dir = /^git-subtree-dir:\s*(.+?)\s*$/im.exec(message)?.[1]
  const split = /^git-subtree-split:\s*([0-9a-f]{7,64})\s*$/im.exec(message)?.[1]
  return dir === prefix ? split : undefined
}

function warn(event: CoreUpdateEvent, message: string): void {
  event('WARN', message)
}

function repositoryPaths(repoRoot: string, paths: string[]): string[] {
  return paths.map((path) => {
    const repositoryPath = relative(repoRoot, path)
    if (repositoryPath === '' || repositoryPath === '..'
      || repositoryPath.startsWith(`..${sep}`) || isAbsolute(repositoryPath)) {
      throw new Error(`shared skill output escaped the repository: ${path}`)
    }
    return repositoryPath.replaceAll('\\', '/')
  })
}

function syncSkills(
  repoRoot: string,
  packageRoot: string,
  runner: Runner,
  project: ProjectAdapter,
  isConsumer: boolean,
  event: CoreUpdateEvent,
  runtime: CoreUpdateRuntime,
): void {
  const sharedSkills = [runner.sharedSkills, ...(project.sharedSkills ?? [])]
  if (isConsumer) {
    for (const target of sharedSkillManagedTargets(repoRoot, packageRoot, sharedSkills)) {
      const managedPaths = repositoryPaths(repoRoot, target.managedPaths)
      let alreadyStaged: string
      try {
        alreadyStaged = runtime.git(repoRoot, [
          'diff', '--cached', '--name-only', '--', ...managedPaths,
        ]).trim()
      } catch (error) {
        throw new Error(`shared skill sync could not verify a clean managed index: ${summary(error)}`)
      }
      if (alreadyStaged !== '') {
        throw new Error(
          `shared skill sync requires a clean managed index: staged changes exist at ${alreadyStaged.replaceAll(/\r?\n/g, ', ')}`,
        )
      }
    }
  }

  let result: ReturnType<typeof syncSharedSkills>
  try {
    result = syncSharedSkills(repoRoot, packageRoot, sharedSkills)
  } catch (error) {
    event('WARN', `shared skill sync failed: ${summary(error)}`)
    return
  }
  for (const failure of result.failures) {
    event('WARN', `shared skill sync failed: ${failure}`)
  }
  for (const skill of result.conflicts) {
    event('WARN', `shared skill ${skill} differs from the last synced copy; left unchanged`)
  }
  for (const path of result.migrationConflicts) {
    event('WARN',
      `legacy shared skill ${relative(repoRoot, path).replaceAll('\\', '/')} differs from the last synced copy; left unchanged`)
  }
  if (isConsumer) {
    const managed = repositoryPaths(repoRoot, result.managedPaths)
    const removed = repositoryPaths(repoRoot, result.removedPaths)
    const scope = [...managed, ...removed]
    if (scope.length > 0) {
      const alreadyStaged = runtime.git(repoRoot, [
        'diff', '--cached', '--name-only', '--', ...scope,
      ]).trim()
      if (alreadyStaged !== '') {
        throw new Error(
          `shared skill sync requires a clean managed index: staged changes exist at ${alreadyStaged.replaceAll(/\r?\n/g, ', ')}`,
        )
      }
      try {
        if (managed.length > 0) runtime.git(repoRoot, ['add', '-f', '--', ...managed])
        const trackedRemoved = removed.length === 0
          ? []
          : runtime.git(repoRoot, ['ls-files', '--deleted', '--', ...removed])
            .split(/\r?\n/).filter((path) => path !== '')
        if (trackedRemoved.length > 0) {
          runtime.git(repoRoot, ['add', '-u', '--', ...trackedRemoved])
        }
        const commitPaths = [...managed, ...trackedRemoved]
        if (commitPaths.length > 0) {
          const staged = runtime.git(repoRoot, [
            'diff', '--cached', '--name-only', '--', ...commitPaths,
          ]).trim()
          if (staged !== '') {
            runtime.git(repoRoot, [
              'commit', '-m', 'chore: sync shared orchestration skills', '--', ...commitPaths,
            ])
          }
        }
      } catch (error) {
        throw new Error(`shared skill sync could not be committed: ${summary(error)}`)
      }
    }
  }

  if (result.changedPaths.length === 0) return
  for (const skill of result.installed) event('Updated', 'skill', `installed ${skill}`)
  for (const skill of result.updated) event('Updated', 'skill', `refreshed ${skill}`)
}

/**
 * Pull a consumed core subtree only at the caller's idle pre-cycle boundary. A changed
 * package asks the daemon to restart; every recoverable Git failure leaves this process
 * running on the old code.
 */
export async function updateCoreBeforeCycle(
  paths: OrchPaths,
  config: Pick<LoopConfig,
    'coreAutoUpdate' | 'upstreamRemote' | 'upstreamBranch' | 'integrationBranch'>,
  forge: Forge,
  runner: Runner,
  project: ProjectAdapter,
  cycle: number,
  event: CoreUpdateEvent,
  runtime: CoreUpdateRuntime = defaultRuntime,
): Promise<CoreUpdateOutcome> {
  if (!config.coreAutoUpdate) return 'continue'

  const stateRepoRoot = dirname(paths.root)
  const packageRoot = runtime.packageRoot ?? (config.integrationBranch === ''
    ? PACKAGE_ROOT
    : join(paths.repoRoot, relative(stateRepoRoot, PACKAGE_ROOT)))
  const prefix = packageSubtreePrefix(paths.repoRoot, packageRoot)
  // The core repository itself and a CLI aimed at another checkout are not subtree
  // consumers. Only the owning repository receives local, ignored generated copies.
  if (prefix === undefined) {
    if (relative(paths.repoRoot, packageRoot) === '') {
      syncSkills(paths.repoRoot, packageRoot, runner, project, false, event, runtime)
    }
    return 'continue'
  }
  const finish = (outcome: CoreUpdateOutcome): CoreUpdateOutcome => {
    syncSkills(paths.repoRoot, packageRoot, runner, project, true, event, runtime)
    return outcome
  }
  if (config.upstreamRemote.trim() === '') {
    warn(event, 'core update skipped: UPSTREAM_REMOTE is not configured')
    return finish('continue')
  }

  let imported: string | undefined
  try {
    imported = importSplit(runtime.git(paths.repoRoot, [
      'log', '-1', '--format=%B', `--grep=git-subtree-dir: ${prefix}`, '--fixed-strings',
    ]), prefix)
  } catch (error) {
    warn(event, `core update check failed: ${summary(error)}`)
    return finish('continue')
  }
  if (imported === undefined) {
    warn(event, `core update skipped: ${prefix} has no git subtree import`)
    return finish('continue')
  }

  const remote = forge.resolveGitRemote(config.upstreamRemote.trim())
  try {
    runtime.git(paths.repoRoot, ['fetch', '--quiet', remote, config.upstreamBranch])
  } catch (error) {
    warn(event, `core update fetch failed: ${summary(error)}`)
    return finish('continue')
  }

  let upstream: string
  try {
    upstream = runtime.git(paths.repoRoot, ['rev-parse', 'FETCH_HEAD']).trim()
    if (upstream !== imported) {
      runtime.git(paths.repoRoot, ['merge-base', '--is-ancestor', imported, upstream])
    }
  } catch {
    warn(event,
      `core update skipped: imported ${imported.slice(0, 8)} is not behind ${config.upstreamBranch}`)
    return finish('continue')
  }
  if (upstream === imported) return finish('continue')

  let dirty: boolean
  try {
    dirty = runtime.git(paths.repoRoot, ['status', '--porcelain']).trim() !== ''
  } catch (error) {
    warn(event, `core update status check failed: ${summary(error)}`)
    return finish('continue')
  }
  if (dirty) {
    warn(event, 'core update skipped: working tree is dirty')
    return finish('continue')
  }

  const oldHead = runtime.git(paths.repoRoot, ['rev-parse', 'HEAD']).trim()
  try {
    runtime.git(paths.repoRoot, [
      'subtree', 'pull', `--prefix=${prefix}`, remote, config.upstreamBranch, '--squash',
    ])
  } catch (error) {
    try {
      runtime.git(paths.repoRoot, ['merge', '--abort'])
    } catch {
      // A subtree failure before merge creation has nothing to abort.
    }
    warn(event, `core update pull conflicted; continuing on old code: ${summary(error)}`)
    return finish('continue')
  }

  syncSkills(paths.repoRoot, packageRoot, runner, project, true, event, runtime)
  const newHead = runtime.git(paths.repoRoot, ['rev-parse', 'HEAD']).trim()
  const changed = runtime.git(paths.repoRoot, [
    'diff', '--name-only', oldHead, newHead, '--', prefix,
  ]).trim()
  if (changed === '') return 'continue'

  event('Updated', 'core', `${imported.slice(0, 8)}..${upstream.slice(0, 8)}`)
  // The updated source belongs to the integration branch. This daemon deliberately
  // keeps executing the fixed source it started with; the update becomes active only
  // when a later run starts from the promoted result.
  if (config.integrationBranch !== '') return 'continue'
  event('Restarting', 'core', `for cycle ${cycle}`)
  return 'restart'
}
