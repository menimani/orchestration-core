import { type ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LOOP_RESTART_READY_FILE_ENV, startLoopReplacement,
} from '../src/restart.ts'

const fixtureRoots: string[] = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fakeChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    kill: vi.fn(() => true),
    unref: vi.fn(),
  }) as unknown as ChildProcess
}

describe('loop replacement startup', () => {
  it('reports success only after the replacement publishes its ready signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-restart-'))
    fixtureRoots.push(root)
    const readyFile = join(root, 'ready')
    const child = fakeChild(43210)
    const spawnProcess = vi.fn((_executable, _args, options) => {
      const env = options.env as NodeJS.ProcessEnv
      expect(env[LOOP_RESTART_READY_FILE_ENV]).toBe(readyFile)
      setTimeout(() => writeFileSync(readyFile, '43210\n'), 0)
      return child
    }) as unknown as typeof spawn

    await expect(startLoopReplacement(readyFile, {
      packageRoot: root,
      spawn: spawnProcess,
      startupTimeoutMs: 1_000,
      stdio: 'ignore',
    })).resolves.toEqual({ ok: true, pid: 43210 })
    expect(child.unref).toHaveBeenCalled()
  })

  it('reports a replacement that exits before publishing readiness', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-restart-'))
    fixtureRoots.push(root)
    const child = fakeChild(43211)
    const spawnProcess = vi.fn(() => {
      setTimeout(() => {
        Object.assign(child, { exitCode: 1 })
        child.emit('exit', 1, null)
      }, 0)
      return child
    }) as unknown as typeof spawn

    await expect(startLoopReplacement(join(root, 'ready'), {
      packageRoot: root,
      spawn: spawnProcess,
      startupTimeoutMs: 1_000,
      stdio: 'ignore',
    })).resolves.toEqual({
      ok: false,
      pid: 43211,
      error: 'replacement exited before becoming ready (exit code 1)',
    })
    expect(child.unref).not.toHaveBeenCalled()
  })
})
