import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { syncSharedSkills } from '../src/sharedSkills.ts'

let fixtureRoot: string
let repoRoot: string
let packageRoot: string

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
})

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('shared skill sync', () => {
  it('installs only manifest skills at the consumer root with its package command prefix', () => {
    writeSkill('verify-changes', 'consumer-specific gates\n')

    const result = syncSharedSkills(repoRoot, packageRoot)

    expect(result.installed).toEqual(['git-commit', 'loop-start'])
    expect(readFileSync(join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe('npm run -C orchestration/ts loop -- --daemon\n')
    expect(existsSync(join(repoRoot, '.claude', 'skills', 'verify-changes'))).toBe(false)
    expect(existsSync(join(packageRoot, '.claude', 'skills'))).toBe(false)
  })

  it('uses the direct npm prefix when the package owns the repository root', () => {
    const ownerRoot = join(fixtureRoot, 'owner')
    packageRoot = ownerRoot
    repoRoot = ownerRoot
    writeManifest(['loop-start'])
    writeSkill('loop-start', '{{ORCHESTRATION_COMMAND_PREFIX}} loop-status\n')

    syncSharedSkills(repoRoot, packageRoot)

    expect(readFileSync(join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe('npm run loop-status\n')
  })

  it('refreshes exact generated copies and retains unlisted repository skills', () => {
    const localSkill = join(repoRoot, '.claude', 'skills', 'verify-changes', 'SKILL.md')
    mkdirSync(join(repoRoot, '.claude', 'skills', 'verify-changes'), { recursive: true })
    writeFileSync(localSkill, 'repository gates\n')
    syncSharedSkills(repoRoot, packageRoot)
    writeSkill('loop-start', 'version two: {{ORCHESTRATION_COMMAND_PREFIX}} loop\n')

    const result = syncSharedSkills(repoRoot, packageRoot)

    expect(result.updated).toEqual(['loop-start'])
    expect(readFileSync(join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe('version two: npm run -C orchestration/ts loop\n')
    expect(readFileSync(localSkill, 'utf8')).toBe('repository gates\n')
  })

  it('reports and preserves a generated skill that the consumer changed', () => {
    syncSharedSkills(repoRoot, packageRoot)
    const installed = join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md')
    writeFileSync(installed, 'consumer version\n')
    writeSkill('loop-start', 'upstream version\n')

    const result = syncSharedSkills(repoRoot, packageRoot)

    expect(result.conflicts).toEqual(['loop-start'])
    expect(result.updated).toEqual([])
    expect(readFileSync(installed, 'utf8')).toBe('consumer version\n')
  })

  it('treats deletion of a managed skill as deliberate divergence', () => {
    syncSharedSkills(repoRoot, packageRoot)
    rmSync(join(repoRoot, '.claude', 'skills', 'loop-start'), { recursive: true })

    const result = syncSharedSkills(repoRoot, packageRoot)

    expect(result.conflicts).toEqual(['loop-start'])
    expect(existsSync(join(repoRoot, '.claude', 'skills', 'loop-start'))).toBe(false)
  })
})
