import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Forge } from '../src/adapters/forge.ts'
import type { Runner } from '../src/adapters/runner.ts'
import { loadMonitoredProject } from '../src/adapters/project.ts'
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
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8'))
      .toBe('version two\n')
    expect(existsSync(join(paths.queueDir, 'scan-count.txt'))).toBe(false)
    expect(runnerStarts).toHaveLength(0)
    expect(events).toContain(`Updated core ${oldCore.slice(0, 8)}..${newCore.slice(0, 8)}`)
    expect(events).toContain('Restarting core for cycle 1')
  })

  it('finds the newest squash-import after its run branch is squash-merged', async () => {
    const runBranch = 'chore/import-core'
    git(repoRoot, ['switch', '-c', runBranch])
    const importedCore = advanceUpstream('version two\n')
    git(repoRoot, [
      'subtree', 'pull', '--prefix=orchestration/ts', upstreamRoot, 'main', '--squash',
    ])
    git(repoRoot, ['switch', 'main'])
    git(repoRoot, ['merge', '--squash', runBranch])
    commit(repoRoot, 'Merge pull request #1 from consumer/chore/import-core')
    git(repoRoot, ['branch', '-D', runBranch])
    const newCore = advanceUpstream('version three\n')
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('restart')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8'))
      .toBe('version three\n')
    expect(events).toContain(
      `Updated core ${importedCore.slice(0, 8)}..${newCore.slice(0, 8)}`,
    )
  })

  it('finds the last exact import behind a newer commit for a longer prefix', async () => {
    const oldCore = git(upstreamRoot, ['rev-parse', 'HEAD'])
    writeFileSync(join(packageRoot, 'local.txt'), 'local change\n')
    commit(repoRoot, 'chore: modify the core locally')
    git(repoRoot, [
      'commit', '--allow-empty', '-m', 'chore: record another import',
      '-m', `git-subtree-dir: orchestration/ts-extra\ngit-subtree-split: ${oldCore}`,
    ])
    const newCore = advanceUpstream('version two\n')
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('restart')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8'))
      .toBe('version two\n')
    expect(readFileSync(join(packageRoot, 'local.txt'), 'utf8'))
      .toBe('local change\n')
    expect(events).toContain(`Updated core ${oldCore.slice(0, 8)}..${newCore.slice(0, 8)}`)
  })

  it('finds the last exact import behind a commit with a long import line', async () => {
    const oldCore = git(upstreamRoot, ['rev-parse', 'HEAD'])
    writeFileSync(join(packageRoot, 'local.txt'), 'local change\n')
    commit(repoRoot, 'chore: modify the core locally')
    const message = join(repoRoot, '..', 'long-import-message.txt')
    writeFileSync(message, 'chore: quote an import line\n\n'
      + `git-subtree-dir: orchestration/ts ${' '.repeat(1_000_000)}x\ngit-subtree-split: ${oldCore}\n`)
    git(repoRoot, ['commit', '--allow-empty', '-F', message])
    const newCore = advanceUpstream('version two\n')
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('restart')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8'))
      .toBe('version two\n')
    expect(events).toContain(`Updated core ${oldCore.slice(0, 8)}..${newCore.slice(0, 8)}`)
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
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8'))
      .toBe('version two\n')
    expect(events).toContain(`Updated core ${oldCore.slice(0, 8)}..${newCore.slice(0, 8)}`)
    expect(events.some((line) => line.startsWith('Restarting core'))).toBe(false)
  })

  it('continues an integration poll when a core update changes an adapter type import', async () => {
    const adapterDirectory = join(paths.root, 'project')
    mkdirSync(adapterDirectory, { recursive: true })
    writeFileSync(join(adapterDirectory, 'project-consumer.ts'), `
import type { ProjectAdapter } from '../ts/src/adapters/project.ts'

export const consumerProject: ProjectAdapter & Record<string, unknown> = {
  name: 'consumer',
  pullRequest: {
    categories: [{ label: 'Changes' }],
    titleFallback: 'no changes',
    classifyCommit: () => ({ category: 'Changes' }),
    detectRisks: () => [],
  },
  preCommitChecks: [],
  mergeChecks: () => [],
  cycleSuite: () => [],
}
`)
    commit(repoRoot, 'test: add consumer adapter fixture')
    const monitored = await loadMonitoredProject(paths.root, { PROJECT: 'consumer' })
    const oldCore = git(upstreamRoot, ['rev-parse', 'HEAD'])
    writeFileSync(
      join(upstreamRoot, 'src', 'adapters', 'project.ts'),
      'export interface ProjectAdapter { name: string; updated?: true }\n',
    )
    const newCore = commit(upstreamRoot, 'feat: update project adapter types')
    const loop = makeLoop(
      config({ INTEGRATION_BRANCH: 'integration/run' }),
      { packageRoot, git },
      makeFakeForge(),
      undefined,
      monitored.sourceChanged,
    )

    expect(await loop.poll(), events.join('\n')).toBe('continue')

    expect(monitored.sourceChanged()).toBe(false)
    expect(runnerStarts).toHaveLength(1)
    expect(events).toContain(`Updated core ${oldCore.slice(0, 8)}..${newCore.slice(0, 8)}`)
    expect(events.some((line) => line.startsWith('Restarting adapter'))).toBe(false)
  })
})
