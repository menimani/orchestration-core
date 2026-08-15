import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Forge } from '../src/adapters/forge.ts'
import type { Runner } from '../src/adapters/runner.ts'
import { loadConfig } from '../src/config.ts'
import {
  updateCoreBeforeCycle, type CoreUpdateEvent, type CoreUpdateRuntime,
} from '../src/coreUpdate.ts'
import { syncSharedSkills } from '../src/sharedSkills.ts'
import { createLoop } from '../src/loop.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { makeFakeForge } from './fakeForge.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'
import { stubProject } from './stubProject.ts'

let fixtureRoot: string
let repoRoot: string
let upstreamRoot: string
let packageRoot: string
let paths: OrchPaths
let events: string[]
let runnerStarts: string[]

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

function configureRepository(root: string): void {
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'core-update@example.test'])
  git(root, ['config', 'user.name', 'Core Update Test'])
}

function commit(root: string, message: string): string {
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}

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
) {
  mkdirSync(join(paths.root, 'templates'), { recursive: true })
  writeFileSync(join(paths.root, 'templates', 'scan-template.md'), '{{SCAN_SCOPE}}\n')
  const runner: Runner = {
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

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'orch-core-update-'))
  repoRoot = join(fixtureRoot, 'consumer')
  upstreamRoot = join(fixtureRoot, 'upstream')
  mkdirSync(repoRoot)
  mkdirSync(upstreamRoot)
  configureRepository(upstreamRoot)
  writeFileSync(join(upstreamRoot, 'core.txt'), 'version one\n')
  mkdirSync(join(upstreamRoot, 'skills'), { recursive: true })
  writeFileSync(join(upstreamRoot, 'skills', 'manifest.json'), JSON.stringify({
    commandPrefixPlaceholder: '{{ORCHESTRATION_COMMAND_PREFIX}}',
    packagePathPrefixPlaceholder: '{{ORCHESTRATION_PACKAGE_PATH_PREFIX}}',
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

  packageRoot = join(repoRoot, 'orchestration', 'ts')
  syncSharedSkills(repoRoot, packageRoot, [
    fakeRunnerSharedSkills, ...(stubProject.sharedSkills ?? []),
  ])
  commit(repoRoot, 'chore: install shared skills')
  paths = orchPaths(repoRoot)
  events = []
  runnerStarts = []
})

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('pre-cycle core update', () => {
  it('restarts for a changed project adapter before checking core or starting a cycle', async () => {
    const coreConfig = config({ CORE_AUTO_UPDATE: 'false' })
    const updateCore = vi.fn(async () => 'continue' as const)
    const adapterChanged = vi.fn(() => true)
    mkdirSync(join(paths.root, 'templates'), { recursive: true })
    writeFileSync(join(paths.root, 'templates', 'scan-template.md'), '{{SCAN_SCOPE}}\n')
    const loop = createLoop({
      paths,
      config: coreConfig,
      forge: makeFakeForge(),
      runner: {
        sharedSkills: fakeRunnerSharedSkills,
        start: async () => {
          throw new Error('a scan must not start before the adapter restart')
        },
      },
      project: stubProject,
      log: (line) => events.push(line),
      now: () => new Date(2026, 7, 12, 0, 0, 0),
      updateCoreBeforeCycle: updateCore,
      projectAdapterChanged: adapterChanged,
    })
    loop.initializeSessionStateForBranch()

    expect(await loop.poll()).toBe('restart')
    expect(loop.restartSubject()).toBe('adapter')
    expect(adapterChanged).toHaveBeenCalledOnce()
    expect(updateCore).not.toHaveBeenCalled()
    expect(existsSync(join(paths.queueDir, 'scan-count.txt'))).toBe(false)
    expect(events).toContain('Restarting adapter     for cycle 1')
  })

  it('pulls a behind subtree and requests re-exec before starting the cycle', async () => {
    const oldCore = git(upstreamRoot, ['rev-parse', 'HEAD'])
    const newCore = advanceUpstream('version two\n')
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('restart')
    expect(loop.restartSubject()).toBe('core')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8').replaceAll('\r', ''))
      .toBe('version two\n')
    expect(existsSync(join(paths.queueDir, 'scan-count.txt'))).toBe(false)
    expect(runnerStarts).toHaveLength(0)
    expect(events).toContain(`Updated core ${oldCore.slice(0, 8)}..${newCore.slice(0, 8)}`)
    expect(events).toContain('Restarting core for cycle 1')
  })

  it('updates integration source without restarting the fixed daemon', async () => {
    const oldCore = git(upstreamRoot, ['rev-parse', 'HEAD'])
    const newCore = advanceUpstream('version two\n')
    const coreConfig = config({ INTEGRATION_BRANCH: 'integration/run' })

    const outcome = await updateCoreBeforeCycle(
      paths,
      coreConfig,
      makeFakeForge(),
      { sharedSkills: fakeRunnerSharedSkills, start: async () => process.pid },
      stubProject,
      2,
      event as CoreUpdateEvent,
      { packageRoot, git },
    )

    expect(outcome).toBe('continue')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8').replaceAll('\r', ''))
      .toBe('version two\n')
    expect(events).toContain(`Updated core ${oldCore.slice(0, 8)}..${newCore.slice(0, 8)}`)
    expect(events.some((line) => line.startsWith('Restarting core'))).toBe(false)
  })

  it('lets the forge adapter resolve repository shorthand for Git', async () => {
    advanceUpstream('version two\n')
    const forge = makeFakeForge()
    forge.resolveGitRemote = vi.fn(() => upstreamRoot)
    const loop = makeLoop(config({ UPSTREAM_REMOTE: 'example/shared-core' }), undefined, forge)

    expect(await loop.poll(), events.join('\n')).toBe('restart')
    expect(forge.resolveGitRemote).toHaveBeenCalledWith('example/shared-core')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8').replaceAll('\r', ''))
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
    expect(readFileSync(join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md'), 'utf8')
      .replaceAll('\r', ''))
      .toBe('version one: npm run -C orchestration/ts loop\n')
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).not.toBe(oldHead)
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
    expect(events).toContain('Updated skill installed .agents/skills/loop-start')
    // The interactive agent's directory is served in the same boundary, or a person
    // driving it loses every shared workflow the moment a runner is selected.
    expect(events).toContain('Updated skill installed .claude/skills/loop-start')
    expect(readFileSync(join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8')
      .replaceAll('\r', ''))
      .toBe('version one: npm run -C orchestration/ts loop\n')
  })

  it('refreshes shared skills at the consumer root in the same clean update boundary', async () => {
    writeUpstreamSkill('version two: {{ORCHESTRATION_COMMAND_PREFIX}} loop-status\n')
    advanceUpstream('version two\n')
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('restart')
    expect(readFileSync(join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md'), 'utf8')
      .replaceAll('\r', ''))
      .toBe('version two: npm run -C orchestration/ts loop-status\n')
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
    ])
    commit(repoRoot, 'chore: adopt the former arrangement')
    const oldHead = git(repoRoot, ['rev-parse', 'HEAD'])
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('continue')
    expect(readFileSync(join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8')
      .replaceAll('\r', ''))
      .toBe('version one: npm run -C orchestration/ts loop\n')
    expect(readFileSync(join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md'), 'utf8')
      .replaceAll('\r', ''))
      .toBe('version one: npm run -C orchestration/ts loop\n')
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).not.toBe(oldHead)
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
  })

  it('preserves and reports a divergent interactive shared skill', async () => {
    const interactiveSkill = join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md')
    writeFileSync(interactiveSkill, 'consumer command\n')
    commit(repoRoot, 'chore: customize interactive skill fixture')
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('continue')
    expect(readFileSync(interactiveSkill, 'utf8').replaceAll('\r', '')).toBe('consumer command\n')
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
    expect(events).toContain(
      'WARN shared skill .claude/skills/loop-start differs from the last synced copy; left unchanged',
    )
  })

  it('pulls core changes but preserves and reports a committed consumer skill divergence', async () => {
    const installed = join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md')
    writeFileSync(installed, 'consumer command\n')
    commit(repoRoot, 'chore: customize loop skill')
    writeUpstreamSkill('upstream command\n')
    advanceUpstream('version two\n')
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('restart')
    expect(readFileSync(installed, 'utf8').replaceAll('\r', '')).toBe('consumer command\n')
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
    expect(events).toContain(
      'WARN shared skill .agents/skills/loop-start differs from the last synced copy; left unchanged',
    )
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
    expect(readFileSync(installed, 'utf8').replaceAll('\r', ''))
      .toBe('version one: npm run -C orchestration/ts loop\n')
    expect(readFileSync(join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8')
      .replaceAll('\r', ''))
      .toBe('version one: npm run -C orchestration/ts loop\n')
    expect(git(repoRoot, ['show', ':.agents/skills/loop-start/SKILL.md'])
      .replaceAll('\r', ''))
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
    expect(readFileSync(join(repoRoot, '.claude', 'skills', 'loop-start', 'SKILL.md'), 'utf8')
      .replaceAll('\r', ''))
      .toBe('version two: npm run -C orchestration/ts loop-status\n')
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).not.toBe(oldHead)
    expect(git(repoRoot, ['show', ':.claude/skills/verify-changes/SKILL.md'])
      .replaceAll('\r', ''))
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
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8').replaceAll('\r', ''))
      .toBe('version one\n')
    expect(runnerStarts).toHaveLength(1)
    expect(events, events.join('\n')).toContain('WARN core update skipped: working tree is dirty')
  })

  it('aborts a conflicting pull, warns, and starts the cycle on the old code', async () => {
    writeFileSync(join(packageRoot, 'core.txt'), 'consumer version\n')
    commit(repoRoot, 'fix: local core divergence')
    advanceUpstream('upstream version\n')
    const oldHead = git(repoRoot, ['rev-parse', 'HEAD'])
    const loop = makeLoop(config())

    expect(await loop.poll()).toBe('continue')
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(oldHead)
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8').replaceAll('\r', ''))
      .toBe('consumer version\n')
    expect(runnerStarts).toHaveLength(1)
    expect(events.some((line) => line.startsWith(
      'WARN core update pull conflicted; continuing on old code:',
    )), events.join('\n')).toBe(true)
  })

  it('skips the check entirely when CORE_AUTO_UPDATE=false', async () => {
    advanceUpstream('version two\n')
    const runtime = {
      packageRoot,
      git: vi.fn(() => { throw new Error('git must not run') }),
    }
    const loop = makeLoop(config({ CORE_AUTO_UPDATE: 'false' }), runtime)

    expect(await loop.poll()).toBe('continue')
    expect(runtime.git).not.toHaveBeenCalled()
    expect(runnerStarts).toHaveLength(1)
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8').replaceAll('\r', ''))
      .toBe('version one\n')
  })
})
