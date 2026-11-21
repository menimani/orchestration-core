import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * The environment for a child that must find a program in `directory` before anything else
 * on the path. A worker thread's process.env is a case-sensitive copy on Windows, and Vitest
 * hands its threads one holding both `Path` and `PATH` when the parent inherited `Path`;
 * a child given both keeps only one of them. Every spelling is dropped and one is set.
 */
function environmentWithPathFirst(
  env: NodeJS.ProcessEnv, directory: string,
): NodeJS.ProcessEnv {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH')
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() !== 'PATH') result[key] = value
  }
  const inherited = pathKey === undefined ? '' : env[pathKey] ?? ''
  result.PATH = inherited === '' ? directory : `${directory}${delimiter}${inherited}`
  return result
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

  it('rejects without publishing a final message when claude cannot be spawned', async () => {
    const child = mockChild()
    mocks.spawn.mockReturnValue(child)
    const error = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })

    const completed = runClaudeProcess('final-message.txt', ['-p'])
    child.emit('error', error)

    await expect(completed).rejects.toBe(error)
    expect(mocks.writeFileSync).not.toHaveBeenCalled()
    expect(mocks.renameSync).not.toHaveBeenCalled()
  })

  it('resolves 1 when claude is killed by a signal and closes without an exit code', async () => {
    const child = mockChild()
    mocks.spawn.mockReturnValue(child)

    const completed = runClaudeProcess('final-message.txt', ['-p'])
    child.emit('close', null)

    await expect(completed).resolves.toBe(1)
    expect(mocks.renameSync).toHaveBeenCalledWith(
      `final-message.txt.${process.pid}.tmp`, 'final-message.txt',
    )
  })

  it('rejects and removes the temporary file when the final message cannot be published', async () => {
    const child = mockChild()
    mocks.spawn.mockReturnValue(child)
    const error = Object.assign(new Error('EPERM: operation not permitted, rename'), {
      code: 'EPERM',
    })
    mocks.renameSync.mockImplementation(() => {
      throw error
    })

    const completed = runClaudeProcess('final-message.txt', ['-p'])
    child.emit('close', 0)

    await expect(completed).rejects.toBe(error)
    expect(mocks.writeFileSync).toHaveBeenCalledWith(
      `final-message.txt.${process.pid}.tmp`, Buffer.alloc(0),
    )
    expect(mocks.rmSync).toHaveBeenCalledWith(
      `final-message.txt.${process.pid}.tmp`, { force: true },
    )
  })

  it('exits 1 when the wrapper cannot publish the final message', async () => {
    // child_process and fs are mocked for this file, so the wrapper runs as a real process
    // against a fake claude found first on PATH.
    const { spawnSync } = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    )
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const wrapper = fileURLToPath(new URL('../src/adapters/runner-claude.ts', import.meta.url))
    const directory = fs.mkdtempSync(join(tmpdir(), 'runner-claude-'))
    try {
      const bin = join(directory, 'bin')
      fs.mkdirSync(bin)
      if (process.platform === 'win32') {
        fs.writeFileSync(join(bin, 'claude.cmd'), '@echo partial\r\n@exit /b 0\r\n')
      } else {
        fs.writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho partial\nexit 0\n', { mode: 0o755 })
      }
      // A directory in the final message's place makes the rename fail on every platform.
      const finalMessageFile = join(directory, 'final-message.txt')
      fs.mkdirSync(finalMessageFile)

      // The fake must win wherever the host's own claude sits. One path variable with the
      // fake's directory first serves every platform; on Windows the wrapper starts claude
      // through cmd.exe, which searches the working directory before the path, so starting
      // the wrapper in that directory finds the fake even if the path were to lose it.
      const result = spawnSync(process.execPath, [
        wrapper, '--claude-runner-wrapper', finalMessageFile, '-p',
      ], {
        cwd: bin,
        encoding: 'utf8',
        env: environmentWithPathFirst(process.env, bin),
        windowsHide: true,
      })

      // One comparison, with the child's stderr as its message, so a failure shows what
      // the child actually did.
      expect({
        status: result.status,
        stdout: result.stdout.trim(),
        stderrStartsWithFailure: result.stderr.startsWith('Claude runner failed: '),
      }, result.stderr).toEqual({
        status: 1,
        stdout: 'partial',
        stderrStartsWithFailure: true,
      })
      expect(fs.readdirSync(directory).sort()).toEqual(['bin', 'final-message.txt'])
      expect(fs.readdirSync(finalMessageFile)).toEqual([])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('exits 1 when the wrapper is started without a final-message file', async () => {
    // child_process is mocked for this file, so the wrapper runs as a real process
    // through the actual implementation.
    const { spawnSync } = await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    )
    const wrapper = fileURLToPath(new URL('../src/adapters/runner-claude.ts', import.meta.url))

    const result = spawnSync(process.execPath, [wrapper, '--claude-runner-wrapper'], {
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toBe('Claude runner wrapper requires a final-message file.\n')
    expect(result.stdout).toBe('')
  })
})

describe('environmentWithPathFirst', () => {
  it('returns exactly one path variable, the directory first, when given both spellings', () => {
    const env = environmentWithPathFirst(
      { Path: `a${delimiter}b`, PATH: 'c', HOME: 'home' }, 'fake',
    )

    expect(env).toEqual({ HOME: 'home', PATH: `fake${delimiter}a${delimiter}b` })
  })

  it('sets the path to the directory alone when no path variable is inherited', () => {
    expect(environmentWithPathFirst({ HOME: 'home' }, 'fake')).toEqual({ HOME: 'home', PATH: 'fake' })
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
