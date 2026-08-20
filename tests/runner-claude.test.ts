import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReasoningEffort, RunnerStartOptions } from '../src/adapters/runner.ts'

const mocks = vi.hoisted(() => ({
  closeSync: vi.fn(),
  openSync: vi.fn((path: string) => path === 'task.log' ? 42 : 43),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  spawn: vi.fn(),
  startWindowsProcess: vi.fn(),
  writeFileSync: vi.fn(),
}))

vi.mock('node:fs', () => ({
  closeSync: mocks.closeSync,
  openSync: mocks.openSync,
  renameSync: mocks.renameSync,
  rmSync: mocks.rmSync,
  writeFileSync: mocks.writeFileSync,
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/adapters/windows-process.ts', () => ({
  startWindowsProcess: mocks.startWindowsProcess,
}))

import { createClaudeRunner, runClaudeProcess } from '../src/adapters/runner-claude.ts'
import { loadRunner } from '../src/adapters/runner.ts'

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
  stdout: EventEmitter
  unref: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    unref: vi.fn(),
  })
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  mocks.openSync.mockImplementation((path: string) => path === 'task.log' ? 42 : 43)
  mocks.startWindowsProcess.mockResolvedValue(5678)
  setPlatform('linux')
})

afterEach(() => {
  setPlatform(originalPlatform)
  vi.restoreAllMocks()
})

describe('createClaudeRunner', () => {
  it('renders canonical skills into the Claude repository discovery path', () => {
    const repoRoot = join('fixture', 'repository')
    const packageRoot = join(repoRoot, 'orchestration', 'ts')
    const sharedSkills = createClaudeRunner().sharedSkills
    const source = [
      '---',
      'name: git-commit',
      'allowed-tools: Bash',
      '---',
      '',
      'Run /git-review, then {{COMMAND_PREFIX}} loop-status.',
      '',
    ].join('\n')

    expect(sharedSkills.destinationRoot(repoRoot)).toBe(join(repoRoot, '.claude', 'skills'))
    expect(sharedSkills.legacyRoots).toBeUndefined()
    expect(sharedSkills.renderFile(
      Buffer.from(source),
      {
        repoRoot,
        packageRoot,
        commandPrefixPlaceholder: '{{COMMAND_PREFIX}}',
        packagePathPrefixPlaceholder: '{{PACKAGE_PATH_PREFIX}}',
      },
    ).toString('utf8')).toBe([
      '---',
      'name: git-commit',
      'allowed-tools: Bash',
      '---',
      '',
      "Run /git-review, then npm run -C 'orchestration/ts' loop-status.",
      '',
    ].join('\n'))
  })

  it.each<[ReasoningEffort, string]>([
    ['minimal', 'claude-minimal'],
    ['low', 'claude-low'],
    ['medium', 'claude-medium'],
    ['high', 'claude-high'],
  ])('maps %s effort to its configured model while delivering the prompt by stdin', async (
    effort,
    model,
  ) => {
    const child = mockChild(4321)
    mocks.spawn.mockReturnValue(child)
    const runner = createClaudeRunner({
      env: {
        RUNNER_CLAUDE_MODEL: 'claude-base',
        RUNNER_CLAUDE_MODEL_MINIMAL: 'claude-minimal',
        RUNNER_CLAUDE_MODEL_LOW: 'claude-low',
        RUNNER_CLAUDE_MODEL_MEDIUM: 'claude-medium',
        RUNNER_CLAUDE_MODEL_HIGH: 'claude-high',
      },
    })

    const started = runner.start({ ...options, effort })

    expect(mocks.openSync).toHaveBeenNthCalledWith(1, 'task.log', 'a')
    expect(mocks.openSync).toHaveBeenNthCalledWith(2, 'task.md', 'r')
    expect(mocks.spawn).toHaveBeenCalledWith(process.execPath, [
      expect.stringMatching(/runner-claude\.ts$/),
      '--claude-runner-wrapper',
      'final-message.txt',
      '-p',
      '--permission-mode', 'bypassPermissions',
      '--model', model,
    ], {
      cwd: 'worktree',
      detached: true,
      stdio: [43, 42, 42],
      windowsHide: true,
    })
    expect((mocks.spawn.mock.calls[0]?.[1] as string[])).not.toContain('--effort')

    child.emit('spawn')
    await expect(started).resolves.toBe(4321)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('prefers a task-specific model over the configured effort model', async () => {
    const child = mockChild()
    mocks.spawn.mockReturnValue(child)

    const started = createClaudeRunner({
      env: { RUNNER_CLAUDE_MODEL_HIGH: 'claude-high' },
    }).start({ ...options, model: 'task-model' })

    expect(mocks.spawn.mock.calls[0]?.[1]).toContain('task-model')
    expect(mocks.spawn.mock.calls[0]?.[1]).not.toContain('claude-high')
    child.emit('spawn')
    await expect(started).resolves.toBe(1234)
  })

  it('uses the configured base model for missing and empty effort variants', async () => {
    const child = mockChild()
    mocks.spawn.mockReturnValue(child)

    const started = createClaudeRunner({
      env: {
        RUNNER_CLAUDE_MODEL: 'claude-base',
        RUNNER_CLAUDE_MODEL_HIGH: '',
      },
    }).start(options)

    expect(mocks.spawn.mock.calls[0]?.[1]).toContain('claude-base')
    child.emit('spawn')
    await expect(started).resolves.toBe(1234)
  })

  it('uses the hidden process launcher on Windows with the default Opus model', async () => {
    setPlatform('win32')

    const started = createClaudeRunner().start(options)

    expect(mocks.startWindowsProcess).toHaveBeenCalledWith({
      args: [
        expect.stringMatching(/runner-claude\.ts$/),
        '--claude-runner-wrapper',
        'final-message.txt',
        '-p',
        '--permission-mode', 'bypassPermissions',
        '--model', 'claude-opus-5',
      ],
      command: process.execPath,
      cwd: 'worktree',
      inputFile: 'task.md',
      outputFile: 'task.log',
    })
    await expect(started).resolves.toBe(5678)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('closes inherited descriptors and rejects when the detached wrapper has no PID', async () => {
    const child = mockChild()
    child.pid = undefined
    mocks.spawn.mockReturnValue(child)

    const started = createClaudeRunner().start(options)
    child.emit('spawn')

    await expect(started).rejects.toThrow('claude runner spawned without a PID')
    expect(mocks.closeSync).toHaveBeenNthCalledWith(1, 43)
    expect(mocks.closeSync).toHaveBeenNthCalledWith(2, 42)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('closes the log and rejects when the prompt file cannot be opened', async () => {
    const error = new Error('prompt open failed')
    mocks.openSync.mockImplementation((path: string) => {
      if (path === 'task.log') return 42
      throw error
    })

    await expect(createClaudeRunner().start(options)).rejects.toBe(error)
    expect(mocks.closeSync).toHaveBeenCalledWith(42)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})

describe('Claude process wrapper', () => {
  it('runs a fake claude executable and publishes its marker output as the final message', async () => {
    const child = mockChild()
    mocks.spawn.mockReturnValue(child)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    const completed = runClaudeProcess('final-message.txt', [
      '-p', '--permission-mode', 'bypassPermissions', '--model', 'claude-opus-5',
    ])
    const finalOutput = Buffer.from('Finished.\nNO_CHANGE_WARRANTED\nTASK_COMPLETE\n')
    child.stdout.emit('data', finalOutput)
    child.emit('close', 0)

    await expect(completed).resolves.toBe(0)
    expect(mocks.spawn).toHaveBeenCalledWith('claude', [
      '-p', '--permission-mode', 'bypassPermissions', '--model', 'claude-opus-5',
    ], {
      detached: false,
      stdio: ['inherit', 'pipe', 'inherit'],
      windowsHide: true,
    })
    expect(stdout).toHaveBeenCalledWith(finalOutput)
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      `final-message.txt.${process.pid}.tmp`, finalOutput,
    )
    expect(mocks.renameSync).toHaveBeenCalledWith(
      `final-message.txt.${process.pid}.tmp`, 'final-message.txt',
    )
  })

  it('routes the fake claude executable through Bash on Windows', async () => {
    setPlatform('win32')
    const child = mockChild()
    mocks.spawn.mockReturnValue(child)

    const completed = runClaudeProcess('final-message.txt', ['-p'])
    child.emit('close', 7)

    await expect(completed).resolves.toBe(7)
    expect(mocks.spawn).toHaveBeenCalledWith('bash', [
      '-c', 'exec claude "$@"', 'claude', '-p',
    ], expect.any(Object))
  })
})

describe('loadRunner', () => {
  it('loads Claude and lists both supported runners in errors', async () => {
    const runner = await loadRunner('claude')
    expect(runner.sharedSkills.destinationRoot('repo'))
      .toBe(join('repo', '.claude', 'skills'))
    await expect(loadRunner('missing')).rejects.toThrow(
      "Unknown RUNNER 'missing' (supported: codex, claude)",
    )
  })
})
