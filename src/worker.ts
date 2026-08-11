import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { capturedSpawnOptions } from './childProcess.ts'
import { currentBranchRemote } from './gitRemote.ts'
import type { OrchPaths } from './paths.ts'

/**
 * Where this package sits inside the checkout being launched. Both of these read the
 * checkout's own code rather than the code doing the checking: the point of the
 * self-check is to judge what the worker is about to run. A consumer keeps the package
 * under orchestration/ts; the repository that owns it keeps it at the root.
 */
function checkoutPackageFile(paths: OrchPaths, ...segments: string[]): string {
  const nested = join(paths.root, 'ts', ...segments)
  return existsSync(nested) ? nested : join(paths.repoRoot, ...segments)
}

export interface WorkerCommandDependencies {
  verifyWorkerSupport: (paths: OrchPaths, env: NodeJS.ProcessEnv) => void
  launchDaemon: (paths: OrchPaths, env: NodeJS.ProcessEnv) => number
}

interface ProcessResult {
  status: number | null
  stdout: string
  stderr: string
}

function gitResult(paths: OrchPaths, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, capturedSpawnOptions({
      cwd: paths.repoRoot,
      windowsHide: true,
    }))
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })
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

async function updateWorkerCheckout(
  paths: OrchPaths,
  baseRef: string,
): Promise<'current' | 'fast-forwarded'> {
  const remote = currentBranchRemote(paths.repoRoot)
  await git(paths, ['fetch', '--quiet', remote])
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
    await git(paths, ['merge', '--quiet', '--ff-only', baseRef])
    return 'fast-forwarded'
  }
  // A checkout AHEAD of the base carries commits the base never saw; every task
  // branch would fork from them and the merger would adopt them unreviewed.
  if (baseBehindHead && !headBehindBase) {
    throw new Error(
      `Refusing to start worker: HEAD is ahead of base ref '${baseRef}', so local commits would leak into every worker branch. Start from the base ref itself.`,
    )
  }
  return 'current'
}

const WORKER_SUPPORT_CHECK = `
const { loadConfig } = await import(process.argv[1])
if (loadConfig().workerMode !== true) {
  console.error('config.workerMode is missing')
  process.exitCode = 1
}
`

export function verifyWorkerModeSupported(paths: OrchPaths, env: NodeJS.ProcessEnv): void {
  const configUrl = pathToFileURL(checkoutPackageFile(paths, 'src', 'config.ts')).href
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', WORKER_SUPPORT_CHECK, configUrl],
    {
      cwd: paths.repoRoot,
      env,
      encoding: 'utf8',
      windowsHide: true,
    },
  )
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(
      `Refusing to start worker: the updated checkout does not support worker mode${detail === '' ? '.' : `: ${detail}`}`,
    )
  }
}

function launchDaemon(paths: OrchPaths, env: NodeJS.ProcessEnv): number {
  const result = spawnSync(
    process.execPath,
    [checkoutPackageFile(paths, 'src', 'cli.ts'), 'loop', '--daemon'],
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

const defaults: WorkerCommandDependencies = {
  verifyWorkerSupport: verifyWorkerModeSupported,
  launchDaemon,
}

export async function runWorkerCommand(
  paths: OrchPaths,
  baseRef: string,
  dependencies: WorkerCommandDependencies = defaults,
): Promise<number> {
  await updateWorkerCheckout(paths, baseRef)
  const workerEnv = {
    ...process.env,
    ISSUE_QUEUE_ENABLED: 'true',
    WORKER_MODE: 'true',
  }
  dependencies.verifyWorkerSupport(paths, workerEnv)
  return dependencies.launchDaemon(paths, workerEnv)
}
