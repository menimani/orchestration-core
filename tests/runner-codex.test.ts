import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

function mockChild(pid: number | undefined = 1234): EventEmitter & {
  pid: number | undefined
  unref: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), { pid, unref: vi.fn() })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createCodexRunner', () => {
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
})
