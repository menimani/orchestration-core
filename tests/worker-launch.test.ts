import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { orchPaths } from '../src/paths.ts'
import {
  assertWorkerModeSupported, runWorkerCommand, type WorkerCommandDependencies,
} from '../src/worker.ts'

let tempRoot: string
let origin: string
let merger: string
let worker: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

function commit(cwd: string, file: string, contents: string, message: string): void {
  writeFileSync(join(cwd, file), contents)
  git(cwd, ['add', file])
  git(cwd, ['commit', '-qm', message])
}

function dependencies(launchDaemon = vi.fn(() => 0)): WorkerCommandDependencies {
  return {
    loadConfig: () => ({ workerMode: true }),
    launchDaemon,
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
    commit(merger, 'new.txt', 'new code\n', 'feat: add worker support')
    git(merger, ['push', '-q', 'origin', 'HEAD:main'])
    const launch = vi.fn<WorkerCommandDependencies['launchDaemon']>(() => 0)

    await expect(runWorkerCommand(orchPaths(worker), 'origin/main', dependencies(launch)))
      .resolves.toBe(0)

    expect(readFileSync(join(worker, 'new.txt'), 'utf8').trim()).toBe('new code')
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
})

describe('worker mode self-check', () => {
  it('refuses a config implementation that does not carry workerMode', () => {
    expect(() => assertWorkerModeSupported(() => ({}))).toThrow(
      /does not support worker mode.*config\.workerMode is missing/,
    )
  })
})
