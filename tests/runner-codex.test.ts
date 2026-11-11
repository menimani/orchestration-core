import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerStartOptions } from '../src/adapters/runner.ts'

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn((_path: string) => false),
  launchAgent: vi.fn(),
  readFileSync: vi.fn((_path: string, _encoding: string) => 'task specification'),
}))

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}))

vi.mock('../src/adapters/os.ts', () => ({
  operatingSystem: { launchAgent: mocks.launchAgent },
}))

import { createCodexRunner } from '../src/adapters/runner-codex.ts'

const options: RunnerStartOptions = {
  effort: 'high',
  finalMessageFile: 'final-message.txt',
  logFile: 'task.log',
  specFile: 'task.md',
  worktree: 'worktree',
}

beforeEach(() => {
  mocks.existsSync.mockReset().mockReturnValue(false)
  mocks.launchAgent.mockReset().mockResolvedValue(4321)
  mocks.readFileSync.mockReset().mockReturnValue('task specification')
})

interface SkillManifest {
  commandPrefixPlaceholder: string
  packagePathPrefixPlaceholder: string
  skills: string[]
}

async function readManifest(packageRoot: string): Promise<SkillManifest> {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
  return JSON.parse(actualFs.readFileSync(
    join(packageRoot, 'skills', 'manifest.json'), 'utf8',
  )) as SkillManifest
}

// Renders every file of every manifest skill against the real filesystem, keyed by its
// skill-relative path.
async function renderSkillTrees(
  repoRoot: string,
  packageRoot: string,
): Promise<Record<string, string>> {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
  const manifestPath = join(packageRoot, 'skills', 'manifest.json')
  mocks.existsSync.mockImplementation(actualFs.existsSync)
  mocks.readFileSync.mockImplementation((path) => path === manifestPath
    ? actualFs.readFileSync(path, 'utf8')
    : 'task specification')
  const manifest = await readManifest(packageRoot)
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
            repoRoot,
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
  return rendered
}

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
    ).toString('utf8')).toBe("npm run -C 'orchestration/ts' loop\n")
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
      "Run a direct review of the changes, then npm run -C 'orchestration/ts' loop-status.",
      '',
    ].join('\n'))
  })

  it('renders context commands and drops front matter in CRLF guidance', () => {
    const repoRoot = join('fixture', 'repository')
    const packageRoot = join(repoRoot, 'orchestration', 'ts')
    const source = [
      '---',
      'name: example-skill',
      'argument-hint: "<pr-number>"',
      '---',
      '',
      '  !`gh pr view $ARGUMENTS --json title`  ',
      '!`git status`',
      '',
    ].join('\r\n')

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
      '---',
      '',
      '  Run `gh pr view <pr-number> --json title` and use its output as context before continuing.',
      'Run `git status` and use its output as context before continuing.',
      '',
    ].join('\r\n'))
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

  it('renders a fixture skill tree from disk by the Codex transformation rules', async () => {
    const repoRoot = join(import.meta.dirname, 'fixtures', 'codex-skill')
    const rendered = await renderSkillTrees(repoRoot, join(repoRoot, 'orchestration'))

    expect(Object.keys(rendered)).toEqual([
      'fixture-review/references/checklist.md',
      'fixture-review/SKILL.md',
    ])
    expect(rendered['fixture-review/SKILL.md']).toBe([
      '---',
      'name: fixture-review',
      'description: Reviews a fixture change. Use when exercising the Codex rendering.',
      '---',
      '',
      '# Fixture review',
      '',
      'Pull request:',
      '',
      'Run `gh pr view <pr-number> --json title,body` and use its output as context before continuing.',
      '',
      '  Run `git diff --stat` and use its output as context before continuing.',
      '',
      'Read `AGENTS.md`, then `.agents/skills/fixture-review/references/checklist.md`.',
      'Leave `.claude/skills/fixture-missing/SKILL.md` as it is.',
      '',
      'Run `$fixture-review` again after fixes, verification directly with the applicable repository commands before committing,',
      'a direct review of the changes for a second opinion, and the fixture-other workflow directly otherwise. Paths such as',
      'src/fixture-file stay untouched.',
      '',
      "Check progress with npm run -C 'orchestration' loop-status and read",
      '`orchestration/skills/manifest.json`.',
      '',
    ].join('\n'))
    // A file without its own argument hint still names what the placeholder stood for.
    expect(rendered['fixture-review/references/checklist.md']).toBe([
      '# Checklist',
      '',
      "Queue follow-ups with npm run -C 'orchestration' queue for <arguments from the request>.",
      '',
    ].join('\n'))
  })

  it('renders every shipped skill file without leaving Claude-only syntax behind', async () => {
    const packageRoot = join(import.meta.dirname, '..')
    const rendered = await renderSkillTrees(packageRoot, packageRoot)
    const manifest = await readManifest(packageRoot)

    for (const skill of manifest.skills) {
      expect(rendered[`${skill}/SKILL.md`]).toMatch(new RegExp(`^---\\nname: ${skill}\\n`))
    }
    for (const [file, text] of Object.entries(rendered)) {
      expect.soft(text, file).not.toContain(manifest.commandPrefixPlaceholder)
      expect.soft(text, file).not.toContain(manifest.packagePathPrefixPlaceholder)
      expect.soft(text, file).not.toContain('$ARGUMENTS')
      expect.soft(text, file).not.toMatch(/^[ \t]*!`/m)
      expect.soft(text, file)
        .not.toMatch(/^(?:argument-hint|allowed-tools|disable-model-invocation):/m)
    }
  })

  it('launches codex through the operating-system adapter with the spec as standard input', async () => {
    const started = createCodexRunner().start({
      ...options,
      effort: 'low',
      model: 'gpt-5-codex',
    })

    expect(mocks.launchAgent).toHaveBeenCalledWith({
      args: [
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--disable', 'multi_agent',
        '--output-last-message', 'final-message.txt',
        '--model', 'gpt-5-codex',
        '--config', 'model_reasoning_effort=low',
        '-',
      ],
      cwd: 'worktree',
      inputFile: 'task.md',
      outputFile: 'task.log',
      program: 'codex',
    })
    await expect(started).resolves.toBe(4321)
  })

  it('omits an empty model argument', async () => {
    await createCodexRunner().start({ ...options, model: '' })

    expect(mocks.launchAgent.mock.calls[0]?.[0].args).not.toContain('--model')
  })

  it('rejects when the operating-system adapter cannot start codex', async () => {
    const error = new Error('spawn failed')
    mocks.launchAgent.mockRejectedValue(error)

    await expect(createCodexRunner().start(options)).rejects.toBe(error)
  })

  it('never passes the specification as an argument regardless of its size', async () => {
    const specification = 'non-ASCII specification \u65e5\u672c\u8a9e\n'.repeat(1_000)
    mocks.readFileSync.mockReturnValue(specification)

    await createCodexRunner().start(options)

    const commandArgs = mocks.launchAgent.mock.calls[0]?.[0].args as string[]
    expect(commandArgs).not.toContain(specification)
    expect(commandArgs.at(-1)).toBe('-')
    expect(mocks.readFileSync).not.toHaveBeenCalledWith('task.md', 'utf8')
  })
})
