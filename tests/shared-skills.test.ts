import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClaudeRunner } from '../src/adapters/runner-claude.ts'
import type { Runner } from '../src/adapters/runner.ts'
import { syncSharedSkills } from '../src/sharedSkills.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'

let fixtureRoot: string
let repoRoot: string
let packageRoot: string
let runner: Runner

function writeSkill(name: string, contents: string): void {
  const directory = join(packageRoot, 'skills', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'SKILL.md'), contents)
}

function writeManifest(skills: string[]): void {
  mkdirSync(join(packageRoot, 'skills'), { recursive: true })
  writeFileSync(join(packageRoot, 'skills', 'manifest.json'), `${JSON.stringify({
    commandPrefixPlaceholder: '{{ORCHESTRATION_COMMAND_PREFIX}}',
    skills,
  }, null, 2)}\n`)
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'orch-shared-skills-'))
  repoRoot = join(fixtureRoot, 'consumer')
  packageRoot = join(repoRoot, 'orchestration', 'ts')
  mkdirSync(packageRoot, { recursive: true })
  writeManifest(['git-commit', 'loop-start'])
  writeSkill('git-commit', 'Commit without a command.\n')
  writeSkill('loop-start', '{{ORCHESTRATION_COMMAND_PREFIX}} loop -- --daemon\n')
  runner = { sharedSkills: fakeRunnerSharedSkills, start: async () => process.pid }
})

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('shared skill sync', () => {
  it('installs only manifest skills at the consumer root with its package command prefix', () => {
    writeSkill('verify-changes', 'consumer-specific gates\n')

    const result = syncSharedSkills(repoRoot, packageRoot, runner)

    expect(result.installed).toEqual([
      '.agents/skills/git-commit', '.agents/skills/loop-start',
      '.claude/skills/git-commit', '.claude/skills/loop-start',
    ])
    expect(readFileSync(join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe('npm run -C orchestration/ts loop -- --daemon\n')
    expect(existsSync(join(repoRoot, '.agents', 'skills', 'verify-changes'))).toBe(false)
    expect(existsSync(join(packageRoot, '.agents', 'skills'))).toBe(false)
  })

  it('uses the direct npm prefix when the package owns the repository root', () => {
    const ownerRoot = join(fixtureRoot, 'owner')
    packageRoot = ownerRoot
    repoRoot = ownerRoot
    writeManifest(['loop-start'])
    writeSkill('loop-start', '{{ORCHESTRATION_COMMAND_PREFIX}} loop-status\n')

    syncSharedSkills(repoRoot, packageRoot, runner)

    expect(readFileSync(join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe('npm run loop-status\n')
  })

  it('refreshes exact generated copies and retains unlisted repository skills', () => {
    const localSkill = join(repoRoot, '.agents', 'skills', 'verify-changes', 'SKILL.md')
    mkdirSync(join(repoRoot, '.agents', 'skills', 'verify-changes'), { recursive: true })
    writeFileSync(localSkill, 'repository gates\n')
    syncSharedSkills(repoRoot, packageRoot, runner)
    writeSkill('loop-start', 'version two: {{ORCHESTRATION_COMMAND_PREFIX}} loop\n')

    const result = syncSharedSkills(repoRoot, packageRoot, runner)

    expect(result.updated).toEqual(['.agents/skills/loop-start', '.claude/skills/loop-start'])
    expect(readFileSync(join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe('version two: npm run -C orchestration/ts loop\n')
    expect(readFileSync(localSkill, 'utf8')).toBe('repository gates\n')
  })

  it('reports and preserves a generated skill that the consumer changed', () => {
    syncSharedSkills(repoRoot, packageRoot, runner)
    const installed = join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md')
    writeFileSync(installed, 'consumer version\n')
    writeSkill('loop-start', 'upstream version\n')

    const result = syncSharedSkills(repoRoot, packageRoot, runner)

    expect(result.conflicts).toEqual(['.agents/skills/loop-start'])
    expect(result.updated).toEqual(['.claude/skills/loop-start'])
    expect(readFileSync(installed, 'utf8')).toBe('consumer version\n')
  })

  it('treats deletion of a managed skill as deliberate divergence', () => {
    syncSharedSkills(repoRoot, packageRoot, runner)
    rmSync(join(repoRoot, '.agents', 'skills', 'loop-start'), { recursive: true })

    const result = syncSharedSkills(repoRoot, packageRoot, runner)

    expect(result.conflicts).toEqual(['.agents/skills/loop-start'])
    expect(existsSync(join(repoRoot, '.agents', 'skills', 'loop-start'))).toBe(false)
  })

  it('removes hash-matching legacy copies and their one-time migration state', () => {
    const legacyRoot = join(repoRoot, '.former-runner', 'skills')
    const legacyRunner: Runner = {
      ...runner,
      sharedSkills: {
        ...runner.sharedSkills,
        destinationRoot: () => legacyRoot,
      },
    }
    syncSharedSkills(repoRoot, packageRoot, legacyRunner)
    runner = {
      ...runner,
      sharedSkills: { ...runner.sharedSkills, legacyRoots: () => [legacyRoot] },
    }
    const localSkill = join(legacyRoot, 'verify-changes', 'SKILL.md')
    mkdirSync(dirname(localSkill), { recursive: true })
    writeFileSync(localSkill, 'repository gates\n')

    const result = syncSharedSkills(repoRoot, packageRoot, runner)

    expect(result.migrationConflicts).toEqual([])
    expect(existsSync(join(legacyRoot, 'git-commit'))).toBe(false)
    expect(existsSync(join(legacyRoot, 'loop-start'))).toBe(false)
    expect(existsSync(join(legacyRoot, '.orchestration-core-sync.json'))).toBe(false)
    expect(readFileSync(localSkill, 'utf8')).toBe('repository gates\n')
  })

  it('preserves and reports a divergent legacy copy only once', () => {
    const legacyRoot = join(repoRoot, '.former-runner', 'skills')
    const legacyRunner: Runner = {
      ...runner,
      sharedSkills: {
        ...runner.sharedSkills,
        destinationRoot: () => legacyRoot,
      },
    }
    syncSharedSkills(repoRoot, packageRoot, legacyRunner)
    runner = {
      ...runner,
      sharedSkills: { ...runner.sharedSkills, legacyRoots: () => [legacyRoot] },
    }
    const divergent = join(legacyRoot, 'loop-start', 'SKILL.md')
    writeFileSync(divergent, 'consumer version\n')

    const first = syncSharedSkills(repoRoot, packageRoot, runner)
    const second = syncSharedSkills(repoRoot, packageRoot, runner)

    expect(first.migrationConflicts).toEqual([join(legacyRoot, 'loop-start')])
    expect(second.migrationConflicts).toEqual([])
    expect(readFileSync(divergent, 'utf8')).toBe('consumer version\n')
  })

  it('uses the selected runner destination and renderer', () => {
    runner = {
      sharedSkills: {
        destinationRoot: (root) => join(root, '.alternate-runner', 'skills'),
        renderFile: (contents, options) => Buffer.from(contents.toString('utf8').replaceAll(
          options.commandPrefixPlaceholder,
          'alternate command',
        )),
      },
      start: async () => process.pid,
    }

    syncSharedSkills(repoRoot, packageRoot, runner)

    expect(readFileSync(
      join(repoRoot, '.alternate-runner', 'skills', 'loop-start', 'SKILL.md'),
      'utf8',
    )).toBe('alternate command loop -- --daemon\n')
    expect(existsSync(join(repoRoot, '.agents', 'skills'))).toBe(false)
  })

  it('rejects a runner destination outside the repository before writing', () => {
    const escaped = join(fixtureRoot, 'escaped', 'skills')
    runner = {
      sharedSkills: {
        destinationRoot: () => escaped,
        renderFile: (contents) => contents,
      },
      start: async () => process.pid,
    }

    const result = syncSharedSkills(repoRoot, packageRoot, runner)

    expect(result.failures).toEqual([
      `shared skill destination escaped the repository: ${escaped}`,
    ])
    expect(existsSync(escaped)).toBe(false)
    // The unusable runner destination must not cost the interactive agent its workflows.
    expect(result.installed).toEqual(['.claude/skills/git-commit', '.claude/skills/loop-start'])
  })

  it('serves the interactive agent in its own format alongside the runner', () => {
    writeSkill('git-commit', [
      '---',
      'name: git-commit',
      'allowed-tools: Bash',
      '---',
      '',
      'Follow /git-review before committing.',
      '',
    ].join('\n'))

    syncSharedSkills(repoRoot, packageRoot, runner)

    const interactive = readFileSync(
      join(repoRoot, '.claude', 'skills', 'git-commit', 'SKILL.md'), 'utf8',
    )
    const forRunner = readFileSync(
      join(repoRoot, '.agents', 'skills', 'git-commit', 'SKILL.md'), 'utf8',
    )
    expect(interactive).toContain('allowed-tools: Bash')
    expect(interactive).toContain('/git-review')
    // The runner's rendering rewrites both; serving one directory with the other's form
    // is what made the shared workflows unusable to whichever agent read them second.
    expect(forRunner).not.toContain('allowed-tools: Bash')
    expect(forRunner).not.toContain('/git-review')
  })

  it('serves a runner that reads the interactive directory exactly once', () => {
    runner = {
      sharedSkills: {
        ...runner.sharedSkills,
        destinationRoot: (root) => join(root, '.claude', 'skills'),
      },
      start: async () => process.pid,
    }

    const result = syncSharedSkills(repoRoot, packageRoot, runner)

    expect(result.installed).toEqual(['.claude/skills/git-commit', '.claude/skills/loop-start'])
    expect(readFileSync(join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe('npm run -C orchestration/ts loop -- --daemon\n')
  })

  it('serves the Claude runner without touching an unlisted repository skill', () => {
    const localSkill = join(repoRoot, '.claude', 'skills', 'verify-changes', 'SKILL.md')
    mkdirSync(dirname(localSkill), { recursive: true })
    writeFileSync(localSkill, 'repository gates\n')
    runner = createClaudeRunner()

    const result = syncSharedSkills(repoRoot, packageRoot, runner)

    expect(result.installed).toEqual([
      '.claude/skills/git-commit', '.claude/skills/loop-start',
    ])
    expect(readFileSync(localSkill, 'utf8')).toBe('repository gates\n')
  })
})
