import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { platform } from 'node:os'
import { basename, join } from 'node:path'
import type { CreateIssueInRepositoryOptions, Forge } from './adapters/forge.ts'
import { PACKAGE_ROOT, packageSubtreePrefix, type OrchPaths } from './paths.ts'

interface PackageMetadata {
  version?: unknown
  upstreamRepo?: unknown
}

export interface ReportUpstreamRuntime {
  env: NodeJS.ProcessEnv
  nodeVersion: string
  platform: string
  packageRoot?: string
  git(repoRoot: string, args: string[]): string
}

export type UpstreamReport = CreateIssueInRepositoryOptions

const defaultRuntime: ReportUpstreamRuntime = {
  env: process.env,
  nodeVersion: process.version,
  platform: platform(),
  git: (repoRoot, args) => execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  }),
}

function configuredString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function repositoryFromRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git$/, '')
  const scpPath = /^[^@]+@[^:]+:(.+)$/.exec(trimmed)?.[1]
  if (scpPath !== undefined) return scpPath.replace(/^\/+|\/+$/g, '') || undefined
  try {
    const path = new URL(trimmed).pathname.replace(/^\/+|\/+$/g, '')
    return path || undefined
  } catch {
    return undefined
  }
}

function currentBranchRemote(paths: OrchPaths, runtime: ReportUpstreamRuntime): string | undefined {
  try {
    const branch = runtime.git(paths.repoRoot, ['branch', '--show-current']).trim()
    if (branch === '') return undefined
    return configuredString(runtime.git(paths.repoRoot, [
      'config', '--get', `branch.${branch}.remote`,
    ]))
  } catch {
    return undefined
  }
}

function reportingRepository(paths: OrchPaths, runtime: ReportUpstreamRuntime): string {
  const configuredRemote = currentBranchRemote(paths, runtime)
  const remotes = configuredRemote === undefined || configuredRemote === 'origin'
    ? ['origin']
    : [configuredRemote, 'origin']
  for (const remote of remotes) {
    try {
      const repository = repositoryFromRemote(
        runtime.git(paths.repoRoot, ['remote', 'get-url', remote]),
      )
      if (repository !== undefined) return repository
    } catch {
      // Try the conventional remote before falling back to the local directory name.
    }
  }
  return basename(paths.repoRoot)
}

function subtreeCommit(
  paths: OrchPaths,
  packageRoot: string,
  runtime: ReportUpstreamRuntime,
): string | undefined {
  const subtreePath = packageSubtreePrefix(paths.repoRoot, packageRoot)
  if (subtreePath === undefined) return undefined
  try {
    const message = runtime.git(paths.repoRoot, [
      'log', '-1', '--format=%B', '--grep=git-subtree-split', '--fixed-strings',
      '--', subtreePath,
    ])
    return /^git-subtree-split:\s*([0-9a-f]{7,40})\s*$/im.exec(message)?.[1]
  } catch {
    return undefined
  }
}

export function prepareUpstreamReport(
  paths: OrchPaths,
  description: string,
  runtime: ReportUpstreamRuntime = defaultRuntime,
): UpstreamReport {
  const trimmedDescription = description.trim()
  if (trimmedDescription === '') {
    throw new Error('The report description must not be empty or whitespace only.')
  }
  const packageRoot = runtime.packageRoot ?? PACKAGE_ROOT
  const packageFile = join(packageRoot, 'package.json')
  const metadata = JSON.parse(readFileSync(packageFile, 'utf8')) as PackageMetadata
  const upstreamRepository = configuredString(runtime.env.UPSTREAM_REPO)
    ?? configuredString(metadata.upstreamRepo)
  if (upstreamRepository === undefined) {
    throw new Error(
      'No upstream repository is configured. Set UPSTREAM_REPO or upstreamRepo in package.json.',
    )
  }

  const coreVersion = subtreeCommit(paths, packageRoot, runtime) ?? configuredString(metadata.version)
  if (coreVersion === undefined) {
    throw new Error(
      'No core version is available. Record a git subtree commit or set version in package.json.',
    )
  }
  const repository = reportingRepository(paths, runtime)
  const body = [
    '## Requirement',
    '',
    trimmedDescription,
    '',
    '## Reporter',
    '',
    `- Repository: \`${repository}\``,
    `- Core version: \`${coreVersion}\``,
    `- Platform: \`${runtime.platform}\``,
    `- Node version: \`${runtime.nodeVersion}\``,
  ].join('\n')

  return {
    repository: upstreamRepository,
    title: `Core defect reported by ${repository}`,
    body,
    optionalLabels: ['upstream:report'],
  }
}

export async function submitUpstreamReport(
  report: UpstreamReport,
  forge: Forge,
): Promise<string> {
  return forge.createIssueInRepository(report)
}
