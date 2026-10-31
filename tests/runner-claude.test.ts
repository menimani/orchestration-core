import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReasoningEffort, RunnerStartOptions } from '../src/adapters/runner.ts'

const mocks = vi.hoisted(() => ({
  agentCommand: vi.fn(),
  launchAgent: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  spawn: vi.fn(),
  writeFileSync: vi.fn(),
}))

vi.mock('node:fs', () => ({
  renameSync: mocks.renameSync,
  rmSync: mocks.rmSync,
  writeFileSync: mocks.writeFileSync,
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/adapters/os.ts', () => ({
  operatingSystem: { agentCommand: mocks.agentCommand, launchAgent: mocks.launchAgent },
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
  mocks.launchAgent.mockResolvedValue(4321)
  mocks.agentCommand.mockImplementation((program: string, args: readonly string[]) => ({
    command: program, args: [...args], verbatimArguments: false,
  }))
})

afterEach(() => {
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

    expect(mocks.launchAgent).toHaveBeenCalledWith({
      args: [
        expect.stringMatching(/runner-claude\.ts$/),
        '--claude-runner-wrapper',
        'final-message.txt',
        '-p',
        '--permission-mode', 'bypassPermissions',
        '--model', model,
      ],
      cwd: 'worktree',
      inputFile: 'task.md',
      outputFile: 'task.log',
      program: process.execPath,
    })
    expect(mocks.launchAgent.mock.calls[0]?.[0].args).not.toContain('--effort')
    await expect(started).resolves.toBe(4321)
  })

  it('prefers a task-specific model over the configured effort model', async () => {
    await createClaudeRunner({
      env: { RUNNER_CLAUDE_MODEL_HIGH: 'claude-high' },
    }).start({ ...options, model: 'task-model' })

    expect(mocks.launchAgent.mock.calls[0]?.[0].args).toContain('task-model')
    expect(mocks.launchAgent.mock.calls[0]?.[0].args).not.toContain('claude-high')
  })

  it('uses the configured base model for missing and empty effort variants', async () => {
    await createClaudeRunner({
      env: {
        RUNNER_CLAUDE_MODEL: 'claude-base',
        RUNNER_CLAUDE_MODEL_HIGH: '',
      },
    }).start(options)

    expect(mocks.launchAgent.mock.calls[0]?.[0].args).toContain('claude-base')
  })

  it('falls back to the default Opus model', async () => {
    // An empty environment pins the default: the suite also runs as a loop's merge gate,
    // where RUNNER_CLAUDE_MODEL is set and would otherwise leak into this assertion.
    await createClaudeRunner({ env: {} }).start(options)

    expect(mocks.launchAgent.mock.calls[0]?.[0].args).toContain('claude-opus-5')
  })

  it('rejects when the operating-system adapter cannot start the wrapper', async () => {
    const error = new Error('prompt open failed')
    mocks.launchAgent.mockRejectedValue(error)

    await expect(createClaudeRunner().start(options)).rejects.toBe(error)
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
      env: expect.objectContaining({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }),
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

  it('spawns claude the way the operating-system adapter commands', async () => {
    mocks.agentCommand.mockReturnValue({
      command: 'cmd.exe', args: ['/d /v:off /s /c "claude ^"-p^""'], verbatimArguments: true,
    })
    const child = mockChild()
    mocks.spawn.mockReturnValue(child)

    const completed = runClaudeProcess('final-message.txt', ['-p'])
    child.emit('close', 7)

    await expect(completed).resolves.toBe(7)
    expect(mocks.agentCommand).toHaveBeenCalledWith('claude', ['-p'])
    expect(mocks.spawn).toHaveBeenCalledWith('cmd.exe', [
      '/d /v:off /s /c "claude ^"-p^""',
    ], expect.objectContaining({ windowsVerbatimArguments: true }))
  })

  it('rejects an argument the operating-system adapter cannot pass', async () => {
    mocks.agentCommand.mockImplementation(() => {
      throw new Error('cmd.exe cannot pass an argument containing a quote or line break')
    })

    await expect(runClaudeProcess('final-message.txt', ['--model', 'two\nlines']))
      .rejects.toThrow('quote or line break')
    expect(mocks.spawn).not.toHaveBeenCalled()
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
