import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import type { OrchPaths } from './paths.ts'

type ConfigLoader = (env: NodeJS.ProcessEnv) => { workerMode?: unknown }

export interface WorkerCommandDependencies {
  loadConfig: ConfigLoader
  launchDaemon: (paths: OrchPaths, env: NodeJS.ProcessEnv) => number
}

interface ProcessResult {
  status: number | null
  stdout: string
  stderr: string
}

function gitResult(paths: OrchPaths, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: paths.repoRoot, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

async function git(paths: OrchPaths, args: string[]): Promise<string> {
  const result = await gitResult(paths, args)
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(`git ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`)
  }
  return result.stdout.trim()
}

async function isAncestor(paths: OrchPaths, ancestor: string, descendant: string): Promise<boolean> {
  const result = await gitResult(paths, ['merge-base', '--is-ancestor', ancestor, descendant])
  if (result.status === 0) return true
  if (result.status === 1) return false
  const detail = (result.stderr || result.stdout).trim()
  throw new Error(`Could not compare HEAD with '${descendant}'${detail === '' ? '' : `: ${detail}`}`)
}

export async function updateWorkerCheckout(
  paths: OrchPaths,
  baseRef: string,
): Promise<'current' | 'fast-forwarded'> {
  await git(paths, ['fetch', 'origin'])
  await git(paths, ['rev-parse', '--verify', `${baseRef}^{commit}`])

  const [headBehindBase, baseBehindHead] = await Promise.all([
    isAncestor(paths, 'HEAD', baseRef),
    isAncestor(paths, baseRef, 'HEAD'),
  ])
  if (!headBehindBase && !baseBehindHead) {
    throw new Error(
      `Refusing to start worker: HEAD and base ref '${baseRef}' have diverged. Check out a branch that can be fast-forwarded to the base ref.`,
    )
  }
  if (headBehindBase && !baseBehindHead) {
    await git(paths, ['merge', '--ff-only', baseRef])
    return 'fast-forwarded'
  }
  return 'current'
}

export function assertWorkerModeSupported(configLoader: ConfigLoader = loadConfig): void {
  const config = configLoader({
    ...process.env,
    ISSUE_QUEUE_ENABLED: 'true',
    WORKER_MODE: 'true',
  })
  if (config.workerMode !== true) {
    throw new Error(
      'Refusing to start worker: this checkout does not support worker mode (config.workerMode is missing).',
    )
  }
}

function launchDaemon(paths: OrchPaths, env: NodeJS.ProcessEnv): number {
  const result = spawnSync(
    process.execPath,
    [join(paths.root, 'ts', 'src', 'cli.ts'), 'loop', '--daemon'],
    {
      cwd: paths.repoRoot,
      env,
      stdio: 'inherit',
      windowsHide: true,
    },
  )
  if (result.error !== undefined) throw result.error
  return result.status ?? 1
}

const defaults: WorkerCommandDependencies = { loadConfig, launchDaemon }

export async function runWorkerCommand(
  paths: OrchPaths,
  baseRef: string,
  dependencies: WorkerCommandDependencies = defaults,
): Promise<number> {
  await updateWorkerCheckout(paths, baseRef)
  assertWorkerModeSupported(dependencies.loadConfig)
  return dependencies.launchDaemon(paths, {
    ...process.env,
    ISSUE_QUEUE_ENABLED: 'true',
    WORKER_MODE: 'true',
  })
}
