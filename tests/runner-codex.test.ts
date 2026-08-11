import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerStartOptions } from '../src/adapters/runner.ts'

const mocks = vi.hoisted(() => ({
  closeSync: vi.fn(),
  openSync: vi.fn(() => 42),
  readFileSync: vi.fn(() => 'task specification'),
  spawn: vi.fn(),
}))

vi.mock('node:fs', () => ({
  closeSync: mocks.closeSync,
  openSync: mocks.openSync,
  readFileSync: mocks.readFileSync,
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))

import { createCodexRunner } from '../src/adapters/runner-codex.ts'

const options: RunnerStartOptions = {
  effort: 'high',
  finalMessageFile: 'final-message.txt',
  logFile: 'task.log',
  specFile: 'task.md',
  worktree: 'worktree',
}

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function mockChild(pid: number | undefined = 1234): EventEmitter & {
  pid: number | undefined
  unref: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), { pid, unref: vi.fn() })
}

beforeEach(() => {
  mocks.closeSync.mockReset()
  mocks.openSync.mockReset().mockReturnValue(42)
  mocks.readFileSync.mockReset().mockReturnValue('task specification')
  mocks.spawn.mockReset()
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('createCodexRunner', () => {
  it('spawns codex directly on POSIX with the final-message, model, effort, and prompt arguments', async () => {
    setPlatform('linux')
    mocks.readFileSync.mockReturnValue('first line\nsecond line')
    const child = mockChild(4321)
    mocks.spawn.mockReturnValue(child)

    const started = createCodexRunner().start({
      ...options,
      effort: 'low',
      model: 'gpt-5-codex',
    })

    expect(mocks.readFileSync).toHaveBeenCalledWith('task.md', 'utf8')
    expect(mocks.openSync).toHaveBeenCalledWith('task.log', 'a')
    expect(mocks.spawn).toHaveBeenCalledWith('codex', [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--output-last-message', 'final-message.txt',
      '--model', 'gpt-5-codex',
      '--config', 'model_reasoning_effort=low',
      'first line\nsecond line',
    ], {
      cwd: 'worktree',
      detached: true,
      stdio: ['ignore', 42, 42],
      windowsHide: true,
    })

    child.emit('spawn')
    await expect(started).resolves.toBe(4321)
  })

  it('routes through Bash on Windows without adding an empty model argument', async () => {
    setPlatform('win32')
    const child = mockChild(5678)
    mocks.spawn.mockReturnValue(child)

    const started = createCodexRunner().start({ ...options, model: '' })

    expect(mocks.spawn).toHaveBeenCalledWith('bash', [
      '-c', 'exec codex "$@"', 'codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--output-last-message', 'final-message.txt',
      '--config', 'model_reasoning_effort=high',
      'task specification',
    ], {
      cwd: 'worktree',
      detached: true,
      stdio: ['ignore', 42, 42],
      windowsHide: true,
    })

    child.emit('spawn')
    await expect(started).resolves.toBe(5678)
  })

  it('closes the parent log descriptor after the child inherits it', async () => {
    const child = mockChild()
    mocks.spawn.mockReturnValue(child)

    const started = createCodexRunner().start(options)
    child.emit('spawn')

    await expect(started).resolves.toBe(1234)
    expect(mocks.closeSync).toHaveBeenCalledOnce()
    expect(mocks.closeSync).toHaveBeenCalledWith(42)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('closes the parent log descriptor when spawning fails', async () => {
    const child = mockChild()
    const error = new Error('spawn failed')
    mocks.spawn.mockReturnValue(child)

    const started = createCodexRunner().start(options)
    child.emit('error', error)

    await expect(started).rejects.toBe(error)
    expect(mocks.closeSync).toHaveBeenCalledOnce()
    expect(mocks.closeSync).toHaveBeenCalledWith(42)
  })

  it('closes the parent log descriptor when spawn throws synchronously', async () => {
    const error = new Error('spawn threw')
    mocks.spawn.mockImplementation(() => {
      throw error
    })

    await expect(createCodexRunner().start(options)).rejects.toBe(error)
    expect(mocks.closeSync).toHaveBeenCalledOnce()
    expect(mocks.closeSync).toHaveBeenCalledWith(42)
  })

  it('rejects and detaches a spawned child that has no PID', async () => {
    const child = mockChild()
    child.pid = undefined
    mocks.spawn.mockReturnValue(child)

    const started = createCodexRunner().start(options)
    child.emit('spawn')

    await expect(started).rejects.toThrow('codex spawned without a PID')
    expect(child.unref).toHaveBeenCalledOnce()
    expect(mocks.closeSync).toHaveBeenCalledOnce()
  })
})
