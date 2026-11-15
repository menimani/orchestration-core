import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Forge } from '../src/adapters/forge.ts'
import type { Runner } from '../src/adapters/runner.ts'
import { loadConfig } from '../src/config.ts'
import {
  updateCoreBeforeCycle, type CoreUpdateEvent, type CoreUpdateRuntime,
} from '../src/coreUpdate.ts'
import { syncSharedSkills } from '../src/sharedSkills.ts'
import { createLoop } from '../src/loop.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { commit, configureRepository, git } from './coreUpdateHarness.ts'
import { makeFakeForge } from './fakeForge.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import { buildRepositoryTemplate, type RepositoryTemplate } from './repositoryTemplate.ts'
import { stubProject } from './stubProject.ts'

let fixtureRoot: string
let repoRoot: string
let upstreamRoot: string
let packageRoot: string
let paths: OrchPaths
let events: string[]
let runnerStarts: string[]

function advanceUpstream(content: string): string {
  writeFileSync(join(upstreamRoot, 'core.txt'), content)
  return commit(upstreamRoot, `feat: upstream ${content.trim()}`)
}

function writeUpstreamSkill(content: string): void {
  const skillRoot = join(upstreamRoot, 'skills', 'loop-start')
  mkdirSync(skillRoot, { recursive: true })
  writeFileSync(join(skillRoot, 'SKILL.md'), content)
}

function event(name: string, subject: string, detail = ''): void {
  events.push([name, subject, detail].filter((part) => part !== '').join(' '))
}

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    AUTO_PR: 'false',
    REVIEW_ENABLED: 'false',
    SCAN_PARALLEL: '1',
    UPSTREAM_REMOTE: upstreamRoot,
    ...overrides,
  })
}

function makeLoop(
  coreConfig: ReturnType<typeof config>,
  runtime: CoreUpdateRuntime = { packageRoot, git },
  forge: Forge = makeFakeForge(),
  runnerOverride?: Runner,
  projectAdapterChanged?: () => boolean,
) {
  mkdirSync(join(paths.root, 'templates'), { recursive: true })
  writeFileSync(join(paths.root, 'templates', 'scan-template.md'), '{{SCAN_SCOPE}}\n')
  const runner: Runner = runnerOverride ?? {
    sharedSkills: fakeRunnerSharedSkills,
    start: async (options) => {
      runnerStarts.push(options.specFile)
      return process.pid
    },
  }
  const loop = createLoop({
    paths,
    config: coreConfig,
    forge,
    runner,
    project: stubProject,
    projectAdapterChanged,
    log: (line) => events.push(line),
    now: () => new Date(2026, 7, 12, 0, 0, 0),
    updateCoreBeforeCycle: (cycle) =>
      updateCoreBeforeCycle(
        paths, coreConfig, forge, runner, stubProject, cycle, event as CoreUpdateEvent, runtime,
      ),
  })
  loop.initializeSessionStateForBranch()
  return loop
}

function useFixtureRoot(root: string): void {
  fixtureRoot = root
  repoRoot = join(root, 'consumer')
  upstreamRoot = join(root, 'upstream')
  packageRoot = join(repoRoot, 'orchestration', 'ts')
}

/** The consumer with the core imported as a squashed subtree and its skills installed. */
function buildFixture(root: string): void {
  useFixtureRoot(root)
  mkdirSync(repoRoot)
  mkdirSync(upstreamRoot)
  configureRepository(upstreamRoot)
  writeFileSync(join(upstreamRoot, 'core.txt'), 'version one\n')
  mkdirSync(join(upstreamRoot, 'src', 'adapters'), { recursive: true })
  writeFileSync(
    join(upstreamRoot, 'src', 'adapters', 'project.ts'),
    'export interface ProjectAdapter { name: string }\n',
  )
  mkdirSync(join(upstreamRoot, 'skills'), { recursive: true })
  writeFileSync(join(upstreamRoot, 'skills', 'manifest.json'), JSON.stringify({
    commandPrefixPlaceholder: '{{ORCHESTRATION_COMMAND_PREFIX}}',
    packagePathPrefixPlaceholder: '{{ORCHESTRATION_PACKAGE_PATH_PREFIX}}',
    projectGuidancePlaceholder: '{{ORCHESTRATION_PROJECT_GUIDANCE}}',
    skills: ['loop-start'],
  }))
  writeUpstreamSkill('version one: {{ORCHESTRATION_COMMAND_PREFIX}} loop\n')
  commit(upstreamRoot, 'feat: initial core')

  configureRepository(repoRoot)
  writeFileSync(join(repoRoot, '.gitignore'), [
    'orchestration/logs/',
    'orchestration/queue/',
    'orchestration/status/',
    'orchestration/tasks/',
    'orchestration/templates/',
    'orchestration/worktrees/',
    '',
  ].join('\n'))
  writeFileSync(join(repoRoot, 'host.txt'), 'host\n')
  commit(repoRoot, 'chore: initial consumer')
  git(repoRoot, [
    'subtree', 'add', '--prefix=orchestration/ts', upstreamRoot, 'main', '--squash',
  ])

  syncSharedSkills(repoRoot, packageRoot, [
    fakeRunnerSharedSkills, ...(stubProject.sharedSkills ?? []),
  ], join(repoRoot, 'orchestration'))
  commit(repoRoot, 'chore: install shared skills')
}


// The subtree import alone takes over a second on Windows, so the fixture is built once
// and every test receives its own copy.
let fixtureTemplate: RepositoryTemplate<void> | undefined

beforeAll(() => {
  fixtureTemplate = buildRepositoryTemplate(buildFixture, ['consumer', 'upstream'])
})

afterAll(() => {
  fixtureTemplate?.dispose()
})

beforeEach(() => {
  useFixtureRoot(mkdtempSync(join(tmpdir(), 'orch-core-update-')))
  fixtureTemplate!.copyTo(fixtureRoot)
  paths = orchPaths(repoRoot)
  events = []
  runnerStarts = []
})

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('pre-cycle core update', () => {
  it('lets the forge adapter resolve repository shorthand for Git', async () => {
    advanceUpstream('version two\n')
    const forge = makeFakeForge()
    forge.resolveGitRemote = vi.fn(() => upstreamRoot)
    const loop = makeLoop(config({ UPSTREAM_REMOTE: 'example/shared-core' }), undefined, forge)

    expect(await loop.poll(), events.join('\n')).toBe('restart')
    expect(forge.resolveGitRemote).toHaveBeenCalledWith('example/shared-core')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8'))
      .toBe('version two\n')
  })

  it('starts the cycle without pulling or restarting when the subtree is current', async () => {
    const loop = makeLoop(config())

    expect(await loop.poll()).toBe('continue')
    expect(runnerStarts).toHaveLength(1)
    expect(readFileSync(join(paths.queueDir, 'scan-count.txt'), 'utf8')).toBe('1\n')
    expect(events.some((line) => /^(Updated|Restarting) core/.test(line))).toBe(false)
  })

  it('installs missing shared skills and commits them when the subtree is current', async () => {
    rmSync(join(repoRoot, '.agents'), { recursive: true })
    rmSync(join(repoRoot, '.claude'), { recursive: true })
    commit(repoRoot, 'chore: remove initial skill fixture')
    const oldHead = git(repoRoot, ['rev-parse', 'HEAD'])
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('continue')
    expect(readFileSync(join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe("version one: npm run -C 'orchestration/ts' loop\n")
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).not.toBe(oldHead)
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
    expect(events).toContain('Updated skill installed .agents/skills/loop-start')
    // The interactive agent's directory is served in the same boundary, or a person
    // driving it loses every shared workflow the moment a runner is selected.
    expect(events).toContain('Updated skill installed .claude/skills/loop-start')
    expect(readFileSync(join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe("version one: npm run -C 'orchestration/ts' loop\n")
  })

  it('refreshes shared skills at the consumer root in the same clean update boundary', async () => {
    writeUpstreamSkill('version two: {{ORCHESTRATION_COMMAND_PREFIX}} loop-status\n')
    advanceUpstream('version two\n')
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('restart')
    expect(readFileSync(join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe("version two: npm run -C 'orchestration/ts' loop-status\n")
    expect(existsSync(join(packageRoot, '.agents', 'skills', 'loop-start'))).toBe(false)
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
    expect(events).toContain('Updated skill refreshed .agents/skills/loop-start')
  })

  it('keeps a repository adopted before the interactive target was served', async () => {
    // Between the sync's introduction and this behaviour, the bundled runner claimed
    // `.claude/skills` as a legacy root and emptied it. A repository carrying that
    // arrangement must come out of an update with both directories filled, not one.
    rmSync(join(repoRoot, '.agents'), { recursive: true })
    const formerRunner: Runner = {
      sharedSkills: {
        ...fakeRunnerSharedSkills,
        destinationRoot: (root) => join(root, '.claude', 'skills'),
      },
      start: async () => process.pid,
    }
    syncSharedSkills(repoRoot, packageRoot, [
      formerRunner.sharedSkills, ...(stubProject.sharedSkills ?? []),
    ], join(repoRoot, 'orchestration'))
    commit(repoRoot, 'chore: adopt the former arrangement')
    const oldHead = git(repoRoot, ['rev-parse', 'HEAD'])
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('continue')
    expect(readFileSync(join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe("version one: npm run -C 'orchestration/ts' loop\n")
    expect(readFileSync(join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe("version one: npm run -C 'orchestration/ts' loop\n")
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).not.toBe(oldHead)
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
  })

  it('overwrites and commits a changed managed interactive shared skill', async () => {
    const interactiveSkill = join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md')
    writeFileSync(interactiveSkill, 'consumer command\n')
    commit(repoRoot, 'chore: customize interactive skill fixture')
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('continue')
    expect(readFileSync(interactiveSkill, 'utf8'))
      .toBe("version one: npm run -C 'orchestration/ts' loop\n")
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
    expect(events).toContain('Updated skill refreshed .claude/skills/loop-start')
  })

  it('stops before starting a cycle when a shared skill target fails to synchronize', async () => {
    const start = vi.fn(async () => process.pid)
    const failingRunner: Runner = {
      sharedSkills: {
        ...fakeRunnerSharedSkills,
        renderFile: () => { throw new Error('simulated target failure') },
      },
      start,
    }
    const loop = makeLoop(config(), undefined, undefined, failingRunner)

    await expect(loop.poll()).rejects.toThrow(
      'shared skill sync failed: simulated target failure',
    )
    expect(start).not.toHaveBeenCalled()
    expect(existsSync(join(paths.queueDir, 'scan-count.txt'))).toBe(false)
    expect(events.some((line) => line.includes('simulated target failure'))).toBe(false)
  })

  it('pulls core changes and overwrites a committed managed skill edit', async () => {
    const installed = join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md')
    writeFileSync(installed, 'consumer command\n')
    commit(repoRoot, 'chore: customize loop skill')
    writeUpstreamSkill('upstream command\n')
    advanceUpstream('version two\n')
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('restart')
    expect(readFileSync(installed, 'utf8')).toBe('upstream command\n')
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
    expect(events).toContain('Updated skill refreshed .agents/skills/loop-start')
  })

  it('requires managed staged changes to be cleared before syncing any destination', async () => {
    const installed = join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md')
    const generated = readFileSync(installed)
    writeFileSync(join(packageRoot, 'skills', 'loop-start', 'SKILL.md'), 'version two\n')
    commit(repoRoot, 'test: update bundled skill fixture')
    writeFileSync(installed, 'staged consumer command\n')
    git(repoRoot, ['add', '--', '.agents/skills/loop-start/SKILL.md'])
    writeFileSync(installed, generated)
    const loop = makeLoop(config())

    await expect(loop.poll()).rejects.toThrow(
      'shared skill sync requires a clean managed index',
    )
    expect(readFileSync(installed, 'utf8'))
      .toBe("version one: npm run -C 'orchestration/ts' loop\n")
    expect(readFileSync(join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe("version one: npm run -C 'orchestration/ts' loop\n")
    expect(git(repoRoot, ['show', ':.agents/skills/loop-start/SKILL.md']))
      .toBe('staged consumer command')
    expect(git(repoRoot, ['status', '--short']))
      .toBe('MM .agents/skills/loop-start/SKILL.md')
    expect(runnerStarts).toHaveLength(0)
  })

  it('stops after a skill commit failure and refuses to resume with its staged output', async () => {
    const bundled = join(packageRoot, 'skills', 'loop-start', 'SKILL.md')
    writeFileSync(bundled, 'version two: {{ORCHESTRATION_COMMAND_PREFIX}} loop-status\n')
    commit(repoRoot, 'test: update bundled skill fixture')
    const failingGit = vi.fn((root: string, args: string[]) => {
      if (args[0] === 'commit') throw new Error('simulated commit failure')
      return git(root, args)
    })
    const loop = makeLoop(config(), { packageRoot, git: failingGit })

    await expect(loop.poll()).rejects.toThrow(
      'shared skill sync could not be committed: simulated commit failure',
    )
    expect(runnerStarts).toHaveLength(0)
    expect(git(repoRoot, ['diff', '--cached', '--name-only']))
      .toContain('.agents/skills/loop-start/SKILL.md')

    const resumedLoop = makeLoop(config())
    await expect(resumedLoop.poll()).rejects.toThrow(
      'shared skill sync requires a clean managed index',
    )
    expect(runnerStarts).toHaveLength(0)
  })

  it('syncs managed skills while preserving an unrelated staged repository skill', async () => {
    const bundled = join(packageRoot, 'skills', 'loop-start', 'SKILL.md')
    writeFileSync(bundled, 'version two: {{ORCHESTRATION_COMMAND_PREFIX}} loop-status\n')
    commit(repoRoot, 'test: update bundled skill fixture')
    const unrelated = join(repoRoot, '.claude', 'skills', 'verify-changes', 'SKILL.md')
    mkdirSync(join(unrelated, '..'), { recursive: true })
    writeFileSync(unrelated, 'repository-owned skill\n')
    git(repoRoot, ['add', '--', '.claude/skills/verify-changes/SKILL.md'])
    const oldHead = git(repoRoot, ['rev-parse', 'HEAD'])
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('continue')
    expect(readFileSync(join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe("version two: npm run -C 'orchestration/ts' loop-status\n")
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).not.toBe(oldHead)
    expect(git(repoRoot, ['show', ':.claude/skills/verify-changes/SKILL.md']))
      .toBe('repository-owned skill')
    expect(git(repoRoot, ['status', '--short']))
      .toBe('A  .claude/skills/verify-changes/SKILL.md')
    expect(events.some((line) => line.includes('staged changes exist at'))).toBe(false)
  })

  it('warns on a dirty tree and starts the cycle without changing the subtree', async () => {
    advanceUpstream('version two\n')
    writeFileSync(join(repoRoot, 'host.txt'), 'dirty host\n')
    const oldHead = git(repoRoot, ['rev-parse', 'HEAD'])
    const loop = makeLoop(config())

    expect(await loop.poll()).toBe('continue')
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(oldHead)
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8'))
      .toBe('version one\n')
    expect(runnerStarts).toHaveLength(1)
    expect(events, events.join('\n')).toContain('WARN core update skipped: working tree is dirty')
    const imported = git(upstreamRoot, ['rev-parse', 'HEAD^'])
    const upstream = git(upstreamRoot, ['rev-parse', 'HEAD'])
    expect(events).toContain(
      `Status core behind imported ${imported.slice(0, 8)} upstream ${upstream.slice(0, 8)}; `
      + 'continuing on old code: working tree is dirty',
    )
  })
})
