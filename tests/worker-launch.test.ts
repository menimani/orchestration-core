import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { orchPaths } from '../src/paths.ts'
import {
  runWorkerCommand, verifyWorkerModeSupported, type WorkerCommandDependencies,
} from '../src/worker.ts'

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
    const launch = vi.fn<WorkerCommandDependencies['launchDaemon']>(() => 0)
    const workerDependencies: WorkerCommandDependencies = {
      verifyWorkerSupport: verifyWorkerModeSupported,
      launchDaemon: launch,
    }

    await expect(runWorkerCommand(orchPaths(worker), 'origin/main', workerDependencies))
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
