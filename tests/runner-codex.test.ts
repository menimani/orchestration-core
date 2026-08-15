import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerStartOptions } from '../src/adapters/runner.ts'

const mocks = vi.hoisted(() => ({
  closeSync: vi.fn(),
  existsSync: vi.fn((_path: string) => false),
  openSync: vi.fn((path: string) => path === 'task.log' ? 42 : 43),
  readFileSync: vi.fn((_path: string, _encoding: string) => 'task specification'),
  spawn: vi.fn(),
  startWindowsProcess: vi.fn(),
}))

vi.mock('node:fs', () => ({
  closeSync: mocks.closeSync,
  existsSync: mocks.existsSync,
  openSync: mocks.openSync,
  readFileSync: mocks.readFileSync,
}))

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/adapters/windows-process.ts', () => ({
  startWindowsProcess: mocks.startWindowsProcess,
}))

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
  mocks.existsSync.mockReset().mockReturnValue(false)
  mocks.openSync.mockReset().mockImplementation((path: string) =>
    path === 'task.log' ? 42 : 43)
  mocks.readFileSync.mockReset().mockReturnValue('task specification')
  mocks.spawn.mockReset()
  mocks.startWindowsProcess.mockReset().mockResolvedValue(5678)
  setPlatform('linux')
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('createCodexRunner', () => {
  it('provides the Codex repository skill destination and command rendering', () => {
    const repoRoot = join('fixture', 'repository')
    const packageRoot = join(repoRoot, 'orchestration', 'ts')
    const sharedSkills = createCodexRunner().sharedSkills

    expect(sharedSkills.destinationRoot(repoRoot))
      .toBe(join(repoRoot, '.agents', 'skills'))
    // `.claude/skills` may be selected independently by the consumer; claiming it as a
    // legacy root here emptied it whenever Codex was selected.
    expect(sharedSkills.legacyRoots).toBeUndefined()
    expect(sharedSkills.renderFile(
      Buffer.from('{{COMMAND_PREFIX}} loop\n'),
      {
        repoRoot,
        packageRoot,
        commandPrefixPlaceholder: '{{COMMAND_PREFIX}}',
        packagePathPrefixPlaceholder: '{{PACKAGE_PATH_PREFIX}}',
      },
    ).toString('utf8')).toBe('npm run -C orchestration/ts loop\n')
  })

  it('renders Claude-oriented skill syntax into complete Codex instructions', () => {
    const repoRoot = join('fixture', 'repository')
    const packageRoot = join(repoRoot, 'orchestration', 'ts')
    const source = [
      '---',
      'name: example-skill',
      'description: Example.',
      'argument-hint: "<pr-number>"',
      'disable-model-invocation: true',
      'allowed-tools: Bash, Read',
      '---',
      '',
      'Skills live in `.claude/skills/<name>/SKILL.md`.',
      'Read `CLAUDE.md` before continuing.',
      '',
      '!`gh pr view $ARGUMENTS --json title`',
      '',
      'Run `/git-review`, then {{COMMAND_PREFIX}} loop-status.',
      '',
    ].join('\n')

    const rendered = createCodexRunner().sharedSkills.renderFile(
      Buffer.from(source),
      {
        repoRoot,
        packageRoot,
        commandPrefixPlaceholder: '{{COMMAND_PREFIX}}',
        packagePathPrefixPlaceholder: '{{PACKAGE_PATH_PREFIX}}',
      },
    ).toString('utf8')

    expect(rendered).toBe([
      '---',
      'name: example-skill',
      'description: Example.',
      '---',
      '',
      'Skills live in `.claude/skills/<name>/SKILL.md`.',
      'Read `CLAUDE.md` before continuing.',
      '',
      'Run `gh pr view <pr-number> --json title` and use its output as context before continuing.',
      '',
      'Run a direct review of the changes, then npm run -C orchestration/ts loop-status.',
      '',
    ].join('\n'))
  })

  it('uses Codex guidance and skill references only when their files are available', () => {
    const repoRoot = join('fixture', 'repository')
    const packageRoot = join(repoRoot, 'orchestration', 'ts')
    mocks.existsSync.mockImplementation((path) => path === join(repoRoot, 'AGENTS.md')
      || path === join(packageRoot, 'skills', 'git-review', 'SKILL.md'))
    mocks.readFileSync.mockImplementation((path) => path === join(
      packageRoot, 'skills', 'manifest.json',
    ) ? JSON.stringify({ skills: ['git-review'] }) : 'task specification')

    const rendered = createCodexRunner().sharedSkills.renderFile(
      Buffer.from(
        'Read `CLAUDE.md` and `.claude/skills/git-review/SKILL.md`, then run `/git-review` and `/verify-changes`.\n',
      ),
      {
        repoRoot,
        packageRoot,
        commandPrefixPlaceholder: '{{COMMAND_PREFIX}}',
        packagePathPrefixPlaceholder: '{{PACKAGE_PATH_PREFIX}}',
      },
    ).toString('utf8')

    expect(rendered).toBe(
      'Read `AGENTS.md` and `.agents/skills/git-review/SKILL.md`, then run `$git-review` and verification directly with the applicable repository commands.\n',
    )
  })

  it('preserves explicit repository guidance and skill paths that already exist', () => {
    const repoRoot = join('fixture', 'repository')
    const packageRoot = join(repoRoot, 'orchestration', 'ts')
    const localSkill = join(repoRoot, '.claude', 'skills', 'verify-changes', 'SKILL.md')
    mocks.existsSync.mockImplementation((path) => path === join(repoRoot, 'CLAUDE.md')
      || path === localSkill)

    const rendered = createCodexRunner().sharedSkills.renderFile(
      Buffer.from('Read `CLAUDE.md` and `.claude/skills/verify-changes/SKILL.md`.\n'),
      {
        repoRoot,
        packageRoot,
        commandPrefixPlaceholder: '{{COMMAND_PREFIX}}',
        packagePathPrefixPlaceholder: '{{PACKAGE_PATH_PREFIX}}',
      },
    ).toString('utf8')

    expect(rendered)
      .toBe('Read `CLAUDE.md` and `.claude/skills/verify-changes/SKILL.md`.\n')
  })

  it('renders every complete shipped skill file for Codex', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    mocks.existsSync.mockImplementation(actualFs.existsSync)
    const packageRoot = join(import.meta.dirname, '..')
    mocks.readFileSync.mockImplementation((path) => path === join(
      packageRoot, 'skills', 'manifest.json',
    ) ? actualFs.readFileSync(path, 'utf8') : 'task specification')
    const manifest = JSON.parse(actualFs.readFileSync(
      join(packageRoot, 'skills', 'manifest.json'), 'utf8',
    )) as {
      commandPrefixPlaceholder: string
      packagePathPrefixPlaceholder: string
      skills: string[]
    }
    const rendered: Record<string, string> = {}
    const visit = (skill: string, root: string, current = root): void => {
      for (const entry of actualFs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        const path = join(current, entry.name)
        if (entry.isDirectory()) visit(skill, root, path)
        else if (entry.isFile()) {
          const relativePath = path.slice(root.length + 1).replaceAll('\\', '/')
          rendered[`${skill}/${relativePath}`] = createCodexRunner().sharedSkills.renderFile(
            actualFs.readFileSync(path),
            {
              repoRoot: packageRoot,
              packageRoot,
              commandPrefixPlaceholder: manifest.commandPrefixPlaceholder,
              packagePathPrefixPlaceholder: manifest.packagePathPrefixPlaceholder,
            },
          ).toString('utf8')
        }
      }
    }
    for (const skill of manifest.skills) {
      visit(skill, join(packageRoot, 'skills', skill))
    }

    expect(rendered).toMatchSnapshot()
  })

  it('spawns codex directly on POSIX with the spec as standard input', async () => {
    setPlatform('linux')
    const child = mockChild(4321)
    mocks.spawn.mockReturnValue(child)

    const started = createCodexRunner().start({
      ...options,
      effort: 'low',
      model: 'gpt-5-codex',
    })

    expect(mocks.openSync).toHaveBeenNthCalledWith(1, 'task.log', 'a')
    expect(mocks.openSync).toHaveBeenNthCalledWith(2, 'task.md', 'r')
    expect(mocks.spawn).toHaveBeenCalledWith('codex', [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--output-last-message', 'final-message.txt',
      '--model', 'gpt-5-codex',
      '--config', 'model_reasoning_effort=low',
      '-',
    ], {
      cwd: 'worktree',
      detached: true,
      stdio: [43, 42, 42],
      windowsHide: true,
    })

    child.emit('spawn')
    await expect(started).resolves.toBe(4321)
  })

  it('routes through Bash on Windows without adding an empty model argument', async () => {
    setPlatform('win32')
    const started = createCodexRunner().start({ ...options, model: '' })

    expect(mocks.startWindowsProcess).toHaveBeenCalledWith({
      args: [
        '-c', 'exec codex "$@"', 'codex',
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--output-last-message', 'final-message.txt',
        '--config', 'model_reasoning_effort=high',
        '-',
      ],
      command: 'bash',
      cwd: 'worktree',
      inputFile: 'task.md',
      outputFile: 'task.log',
    })

    await expect(started).resolves.toBe(5678)
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.openSync).not.toHaveBeenCalled()
  })

  it('never passes the specification as an argument regardless of its size', async () => {
    const specification = 'non-ASCII specification \u65e5\u672c\u8a9e\n'.repeat(1_000)
    mocks.readFileSync.mockReturnValue(specification)
    const child = mockChild()
    mocks.spawn.mockReturnValue(child)

    const started = createCodexRunner().start(options)

    const commandArgs = mocks.spawn.mock.calls[0]?.[1] as string[]
    expect(commandArgs).not.toContain(specification)
    expect(commandArgs.at(-1)).toBe('-')
    expect(mocks.readFileSync).not.toHaveBeenCalledWith('task.md', 'utf8')

    child.emit('spawn')
    await expect(started).resolves.toBe(1234)
  })

  it('closes the parent spec and log descriptors after the child inherits them', async () => {
    const child = mockChild()
    mocks.spawn.mockReturnValue(child)

    const started = createCodexRunner().start(options)
    child.emit('spawn')

    await expect(started).resolves.toBe(1234)
    expect(mocks.closeSync).toHaveBeenCalledTimes(2)
    expect(mocks.closeSync).toHaveBeenNthCalledWith(1, 43)
    expect(mocks.closeSync).toHaveBeenNthCalledWith(2, 42)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('closes the parent spec and log descriptors when spawning fails', async () => {
    const child = mockChild()
    const error = new Error('spawn failed')
    mocks.spawn.mockReturnValue(child)

    const started = createCodexRunner().start(options)
    child.emit('error', error)

    await expect(started).rejects.toBe(error)
    expect(mocks.closeSync).toHaveBeenCalledTimes(2)
    expect(mocks.closeSync).toHaveBeenNthCalledWith(1, 43)
    expect(mocks.closeSync).toHaveBeenNthCalledWith(2, 42)
  })

  it('closes the parent spec and log descriptors when spawn throws synchronously', async () => {
    const error = new Error('spawn threw')
    mocks.spawn.mockImplementation(() => {
      throw error
    })

    await expect(createCodexRunner().start(options)).rejects.toBe(error)
    expect(mocks.closeSync).toHaveBeenCalledTimes(2)
    expect(mocks.closeSync).toHaveBeenNthCalledWith(1, 43)
    expect(mocks.closeSync).toHaveBeenNthCalledWith(2, 42)
  })

  it('closes the log descriptor and rejects when the spec cannot be opened', async () => {
    const error = new Error('spec open failed')
    mocks.openSync.mockImplementation((path: string) => {
      if (path === 'task.log') return 42
      throw error
    })

    await expect(createCodexRunner().start(options)).rejects.toBe(error)
    expect(mocks.closeSync).toHaveBeenCalledOnce()
    expect(mocks.closeSync).toHaveBeenCalledWith(42)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('rejects and detaches a spawned child that has no PID', async () => {
    const child = mockChild()
    child.pid = undefined
    mocks.spawn.mockReturnValue(child)

    const started = createCodexRunner().start(options)
    child.emit('spawn')

    await expect(started).rejects.toThrow('codex spawned without a PID')
    expect(child.unref).toHaveBeenCalledOnce()
    expect(mocks.closeSync).toHaveBeenCalledTimes(2)
  })
})
