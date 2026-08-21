import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { orchPaths } from '../src/paths.ts'
import {
  runWorkerCommand, verifyWorkerModeSupported, type WorkerCommandDependencies,
} from '../src/worker.ts'
import { resolvedPath } from './pathComparison.ts'

let tempRoot: string
let origin: string
let merger: string
let worker: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function commit(cwd: string, file: string, contents: string, message: string): void {
  mkdirSync(join(cwd, file, '..'), { recursive: true })
  writeFileSync(join(cwd, file), contents)
  git(cwd, ['add', file])
  git(cwd, ['commit', '-qm', message])
}

function dependencies(launchDaemon = vi.fn(() => 0)): WorkerCommandDependencies {
  return {
    verifyWorkerSupport: () => {},
    launchDaemon,
  }
}

const unsupportedConfig = 'export function loadConfig() { return {} }\n'
const supportedConfig = 'export function loadConfig() { return { workerMode: true } }\n'
const WORKER_MODULE = pathToFileURL(join(import.meta.dirname, '..', 'src', 'worker.ts')).href
const PATHS_MODULE = pathToFileURL(join(import.meta.dirname, '..', 'src', 'paths.ts')).href

interface LaunchProbe {
  command: string
  args: string[]
  cwd: string
  issueQueueEnabled: string | undefined
  workerMode: string | undefined
  parentSentinel: string | undefined
}

interface LaunchOutcome {
  status?: number
  error?: { name: string, message: string, code?: string }
}

function runProductionLaunchProbe(
  daemonStatus: number,
  spawnError = false,
): { probe: LaunchProbe, outcome: LaunchOutcome } {
  const preload = join(tempRoot, `worker-spawn-probe-${daemonStatus}-${spawnError}.cjs`)
  const harness = join(tempRoot, `worker-launch-harness-${daemonStatus}-${spawnError}.ts`)
  const probeFile = join(tempRoot, `worker-spawn-probe-${daemonStatus}-${spawnError}.json`)
  const outcomeFile = join(tempRoot, `worker-launch-outcome-${daemonStatus}-${spawnError}.json`)
  writeFileSync(preload, [
    "const childProcess = require('node:child_process')",
    "const { writeFileSync } = require('node:fs')",
    "const { syncBuiltinESMExports } = require('node:module')",
    'const originalSpawnSync = childProcess.spawnSync',
    'childProcess.spawnSync = function (command, args, options) {',
    "  if (args?.[0] === '--input-type=module') {",
    "    return { status: 0, signal: null, stdout: '', stderr: '' }",
    '  }',
    "  if (args?.[1] === 'loop' && args?.includes('--daemon')) {",
    '    writeFileSync(process.env.ORCH_WORKER_LAUNCH_PROBE, JSON.stringify({',
    '      command, args, cwd: options?.cwd,',
    '      issueQueueEnabled: options?.env?.ISSUE_QUEUE_ENABLED,',
    '      workerMode: options?.env?.WORKER_MODE,',
    '      parentSentinel: options?.env?.ORCH_WORKER_PARENT_SENTINEL,',
    '    }))',
    "    if (process.env.ORCH_WORKER_SPAWN_ERROR === 'true') {",
    "      const error = Object.assign(new Error('synthetic daemon spawn failure'), { code: 'ENOENT' })",
    "      return { error, status: null, signal: null, stdout: '', stderr: '' }",
    '    }',
    '    return { status: Number(process.env.ORCH_WORKER_DAEMON_STATUS), signal: null,',
    "      stdout: '', stderr: '' }",
    '  }',
    '  return originalSpawnSync.apply(this, arguments)',
    '}',
    'syncBuiltinESMExports()',
    '',
  ].join('\n'))
  writeFileSync(harness, [
    `import { runWorkerCommand } from ${JSON.stringify(WORKER_MODULE)}`,
    `import { orchPaths } from ${JSON.stringify(PATHS_MODULE)}`,
    "import { writeFileSync } from 'node:fs'",
    `const paths = orchPaths(${JSON.stringify(worker)})`,
    'try {',
    "  const status = await runWorkerCommand(paths, 'origin/main')",
    '  writeFileSync(process.env.ORCH_WORKER_OUTCOME, JSON.stringify({ status }))',
    '} catch (error) {',
    '  writeFileSync(process.env.ORCH_WORKER_OUTCOME, JSON.stringify({ error: {',
    '    name: error?.name, message: error?.message, code: error?.code,',
    '  } }))',
    '}',
    '',
  ].join('\n'))

  const result = spawnSync(process.execPath, [harness], {
    cwd: tempRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require="${preload.replaceAll('\\', '\\\\')}"`.trim(),
      ORCH_WORKER_DAEMON_STATUS: String(daemonStatus),
      ORCH_WORKER_LAUNCH_PROBE: probeFile,
      ORCH_WORKER_OUTCOME: outcomeFile,
      ORCH_WORKER_PARENT_SENTINEL: 'preserved',
      ORCH_WORKER_SPAWN_ERROR: String(spawnError),
    },
    windowsHide: true,
  })
  expect(result.status, result.stderr).toBe(0)
  return {
    probe: JSON.parse(readFileSync(probeFile, 'utf8')) as LaunchProbe,
    outcome: JSON.parse(readFileSync(outcomeFile, 'utf8')) as LaunchOutcome,
  }
}

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'orch-worker-launch-'))
  origin = join(tempRoot, 'origin.git')
  merger = join(tempRoot, 'merger')
  worker = join(tempRoot, 'worker')
  git(tempRoot, ['init', '-q', '--bare', origin])
  git(tempRoot, ['clone', '-q', origin, merger])
  git(merger, ['config', 'user.email', 'test@example.com'])
  git(merger, ['config', 'user.name', 'Test'])
  commit(merger, 'README.md', '# repo\n', 'chore: initial commit')
  commit(merger, 'orchestration/ts/src/config.ts', unsupportedConfig, 'chore: add old config')
  git(merger, ['push', '-q', '-u', 'origin', 'HEAD:main'])
  git(tempRoot, ['clone', '-q', '--branch', 'main', origin, worker])
  git(worker, ['config', 'user.email', 'test@example.com'])
  git(worker, ['config', 'user.name', 'Test'])
})

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('worker command checkout validation', () => {
  it('fast-forwards a checkout that is strictly behind the base ref before launching', async () => {
    commit(merger, 'orchestration/ts/src/config.ts', supportedConfig, 'feat: add worker support')
    git(merger, ['push', '-q', 'origin', 'HEAD:main'])
    git(worker, ['remote', 'rename', 'origin', 'shared'])
    const launch = vi.fn<WorkerCommandDependencies['launchDaemon']>(() => 0)
    const workerDependencies: WorkerCommandDependencies = {
      verifyWorkerSupport: verifyWorkerModeSupported,
      launchDaemon: launch,
    }

    await expect(runWorkerCommand(orchPaths(worker), 'shared/main', workerDependencies))
      .resolves.toBe(0)

    expect(readFileSync(join(worker, 'orchestration/ts/src/config.ts'), 'utf8').trim())
      .toBe(supportedConfig.trim())
    expect(git(worker, ['rev-parse', 'HEAD']).trim()).toBe(git(merger, ['rev-parse', 'HEAD']).trim())
    expect(launch).toHaveBeenCalledOnce()
    expect(launch.mock.calls[0]?.[1]).toMatchObject({
      ISSUE_QUEUE_ENABLED: 'true',
      WORKER_MODE: 'true',
    })
  })

  it('refuses when the checkout and base ref have diverged', async () => {
    commit(merger, 'merger.txt', 'merger\n', 'feat: merger change')
    git(merger, ['push', '-q', 'origin', 'HEAD:main'])
    commit(worker, 'worker.txt', 'worker\n', 'feat: worker change')
    const launch = vi.fn<WorkerCommandDependencies['launchDaemon']>(() => 0)

    await expect(runWorkerCommand(orchPaths(worker), 'origin/main', dependencies(launch)))
      .rejects.toThrow(/HEAD and base ref 'origin\/main' have diverged/)
    expect(launch).not.toHaveBeenCalled()
  })

  it('refuses a checkout ahead of the base ref, whose local commits would leak into worker branches', async () => {
    commit(worker, 'ahead.txt', 'ahead\n', 'feat: local-only change')
    const launch = vi.fn<WorkerCommandDependencies['launchDaemon']>(() => 0)

    await expect(runWorkerCommand(orchPaths(worker), 'origin/main', dependencies(launch)))
      .rejects.toThrow(/HEAD is ahead of base ref 'origin\/main'/)
    expect(launch).not.toHaveBeenCalled()
  })

  it('fetches the remote named by the base ref when pushes use a fork', async () => {
    const upstream = join(tempRoot, 'upstream.git')
    git(tempRoot, ['init', '-q', '--bare', upstream])
    git(merger, ['remote', 'add', 'upstream', upstream])
    git(merger, ['push', '-q', 'upstream', 'HEAD:main'])
    commit(merger, 'upstream.txt', 'upstream\n', 'feat: upstream change')
    git(merger, ['push', '-q', 'upstream', 'HEAD:main'])
    git(worker, ['remote', 'add', 'upstream', upstream])
    git(worker, ['config', 'branch.main.remote', 'upstream'])
    git(worker, ['config', 'branch.main.merge', 'refs/heads/main'])
    git(worker, ['config', 'branch.main.pushRemote', 'origin'])
    const launch = vi.fn<WorkerCommandDependencies['launchDaemon']>(() => 0)

    await expect(runWorkerCommand(orchPaths(worker), 'upstream/main', dependencies(launch)))
      .resolves.toBe(0)

    expect(readFileSync(join(worker, 'upstream.txt'), 'utf8').trim()).toBe('upstream')
    expect(launch).toHaveBeenCalledOnce()
  })
})

describe('worker mode self-check', () => {
  it('refuses updated checkout code that does not carry workerMode', async () => {
    commit(merger, 'new.txt', 'new code\n', 'feat: update without worker support')
    git(merger, ['push', '-q', 'origin', 'HEAD:main'])
    const launch = vi.fn<WorkerCommandDependencies['launchDaemon']>(() => 0)
    const workerDependencies: WorkerCommandDependencies = {
      verifyWorkerSupport: verifyWorkerModeSupported,
      launchDaemon: launch,
    }

    await expect(runWorkerCommand(orchPaths(worker), 'origin/main', workerDependencies))
      .rejects.toThrow(/updated checkout does not support worker mode.*config\.workerMode is missing/)
    expect(readFileSync(join(worker, 'new.txt'), 'utf8').trim()).toBe('new code')
    expect(launch).not.toHaveBeenCalled()
  })
})

describe('worker daemon subprocess boundary', () => {
  beforeEach(() => {
    commit(merger, 'orchestration/ts/src/config.ts', supportedConfig, 'feat: add worker support')
    commit(merger, 'orchestration/ts/src/cli.ts', '// updated worker CLI\n', 'feat: add updated CLI')
    git(merger, ['push', '-q', 'origin', 'HEAD:main'])
  })

  it('launches the updated issue-mode CLI from the repository with the worker environment', () => {
    const { probe, outcome } = runProductionLaunchProbe(23)

    expect(outcome).toEqual({ status: 23 })
    expect(resolvedPath(probe.command)).toBe(resolvedPath(process.execPath))
    expect(resolvedPath(probe.args[0] ?? ''))
      .toBe(resolvedPath(join(worker, 'orchestration', 'ts', 'src', 'cli.ts')))
    expect(probe.args.slice(1)).toEqual([
      'loop', '--approve-mode', 'issue', '--daemon',
    ])
    expect(resolvedPath(probe.cwd)).toBe(resolvedPath(worker))
    expect(probe).toMatchObject({
      issueQueueEnabled: 'true',
      workerMode: 'true',
      parentSentinel: 'preserved',
    })
  })

  it('surfaces a daemon spawn error from the production handoff', () => {
    const { outcome } = runProductionLaunchProbe(0, true)

    expect(outcome).toEqual({
      error: {
        name: 'Error',
        message: 'synthetic daemon spawn failure',
        code: 'ENOENT',
      },
    })
  })
})
