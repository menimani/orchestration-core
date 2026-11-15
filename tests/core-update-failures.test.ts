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

/** One pre-cycle update outside the loop, so its outcome and events are all it reports. */
function updateDirectly(
  coreConfig: ReturnType<typeof config>,
  runtime: CoreUpdateRuntime = { packageRoot, git },
) {
  return updateCoreBeforeCycle(
    paths,
    coreConfig,
    makeFakeForge(),
    { sharedSkills: fakeRunnerSharedSkills, start: async () => process.pid },
    stubProject,
    1,
    event as CoreUpdateEvent,
    runtime,
  )
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
  it('aborts a conflicting pull, warns, and starts the cycle on the old code', async () => {
    writeFileSync(join(packageRoot, 'core.txt'), 'consumer version\n')
    commit(repoRoot, 'fix: local core divergence')
    advanceUpstream('upstream version\n')
    const oldHead = git(repoRoot, ['rev-parse', 'HEAD'])
    const loop = makeLoop(config())

    expect(await loop.poll()).toBe('continue')
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(oldHead)
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8'))
      .toBe('consumer version\n')
    expect(runnerStarts).toHaveLength(1)
    expect(events.some((line) => line.startsWith(
      'WARN core update pull conflicted; continuing on old code:',
    )), events.join('\n')).toBe(true)
    const imported = git(upstreamRoot, ['rev-parse', 'HEAD^'])
    const upstream = git(upstreamRoot, ['rev-parse', 'HEAD'])
    expect(events).toContain(
      `Status core behind imported ${imported.slice(0, 8)} upstream ${upstream.slice(0, 8)}; `
      + 'continuing on old code: pull conflicted',
    )
  })

  it('rolls back an import bridge when the pull fails before creating merge state', async () => {
    const runBranch = 'chore/import-core'
    git(repoRoot, ['switch', '-c', runBranch])
    advanceUpstream('version two\n')
    git(repoRoot, [
      'subtree', 'pull', '--prefix=orchestration/ts', upstreamRoot, 'main', '--squash',
    ])
    git(repoRoot, ['switch', 'main'])
    git(repoRoot, ['merge', '--squash', runBranch])
    commit(repoRoot, 'Merge pull request #1 from consumer/chore/import-core')
    git(repoRoot, ['branch', '-D', runBranch])
    advanceUpstream('version three\n')
    const oldHead = git(repoRoot, ['rev-parse', 'HEAD'])
    const failingGit = vi.fn((root: string, args: string[]) => {
      if (args[0] === 'subtree' && args[1] === 'pull') {
        throw new Error('simulated pre-merge pull failure')
      }
      return git(root, args)
    })
    const loop = makeLoop(config(), { packageRoot, git: failingGit })

    expect(await loop.poll()).toBe('continue')
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(oldHead)
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8'))
      .toBe('version two\n')
    expect(failingGit).not.toHaveBeenCalledWith(repoRoot, ['merge', '--abort'])
    expect(runnerStarts).toHaveLength(1)
    expect(events).toContain(
      'WARN core update pull conflicted; continuing on old code: simulated pre-merge pull failure',
    )
  })

  it('stops when a failed core pull cannot confirm a successful merge abort', async () => {
    writeFileSync(join(packageRoot, 'core.txt'), 'consumer version\n')
    commit(repoRoot, 'fix: local core divergence')
    advanceUpstream('upstream version\n')
    const abortFailureGit = (root: string, args: string[]): string => {
      if (args[0] === 'merge' && args[1] === '--abort') {
        git(root, args)
        throw new Error('simulated abort failure')
      }
      return git(root, args)
    }
    const loop = makeLoop(config(), { packageRoot, git: abortFailureGit })

    await expect(loop.poll()).rejects.toThrow(
      'core update pull failed and merge abort failed: simulated abort failure',
    )
    expect(git(repoRoot, ['status', '--porcelain'])).toBe('')
    expect(runnerStarts).toHaveLength(0)
    expect(existsSync(join(paths.queueDir, 'scan-count.txt'))).toBe(false)
  })

  it('warns and continues on the old core when UPSTREAM_REMOTE is not configured', async () => {
    advanceUpstream('version two\n')
    const runtime = { packageRoot, git: vi.fn(git) }

    expect(await updateDirectly({ ...config(), upstreamRemote: ' ' }, runtime)).toBe('continue')
    expect(runtime.git).not.toHaveBeenCalledWith(repoRoot, expect.arrayContaining(['fetch']))
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8')).toBe('version one\n')
    expect(events).toEqual(['WARN core update skipped: UPSTREAM_REMOTE is not configured'])
  })

  it('warns and continues on the old core when the upstream fetch fails', async () => {
    advanceUpstream('version two\n')
    const fetchFailureGit = (root: string, args: string[]): string => {
      if (args[0] === 'fetch') throw new Error('simulated fetch failure')
      return git(root, args)
    }

    expect(await updateDirectly(config(), { packageRoot, git: fetchFailureGit })).toBe('continue')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8')).toBe('version one\n')
    expect(events).toEqual(['WARN core update fetch failed: simulated fetch failure'])
  })

  it('warns and continues on the old core when the import check fails', async () => {
    advanceUpstream('version two\n')
    const checkFailureGit = (root: string, args: string[]): string => {
      if (args[0] === 'rev-parse' && args[1] === 'FETCH_HEAD') {
        throw new Error('simulated check failure')
      }
      return git(root, args)
    }

    expect(await updateDirectly(config(), { packageRoot, git: checkFailureGit })).toBe('continue')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8')).toBe('version one\n')
    expect(events).toEqual(['WARN core update check failed: simulated check failure'])
  })

  it('warns and continues on the old core when the prefix has no subtree import', async () => {
    advanceUpstream('version two\n')
    // No recorded import message and no upstream commit whose tree matches the subtree.
    const noImportGit = (root: string, args: string[]): string => {
      if (args[0] === 'log') return ''
      return git(root, args)
    }

    expect(await updateDirectly(config(), { packageRoot, git: noImportGit })).toBe('continue')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8')).toBe('version one\n')
    expect(events).toEqual(['WARN core update skipped: orchestration/ts has no git subtree import'])
  })

  it('warns and continues on the old core when the import is not behind upstream', async () => {
    const imported = git(upstreamRoot, ['rev-parse', 'HEAD'])
    // Upstream history rewritten onto an unrelated root: the import is not its ancestor.
    git(upstreamRoot, ['switch', '--orphan', 'rewritten'])
    writeFileSync(join(upstreamRoot, 'core.txt'), 'rewritten\n')
    commit(upstreamRoot, 'feat: rewritten core')
    git(upstreamRoot, ['branch', '-f', 'main', 'rewritten'])
    const oldHead = git(repoRoot, ['rev-parse', 'HEAD'])

    expect(await updateDirectly(config())).toBe('continue')
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(oldHead)
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8')).toBe('version one\n')
    expect(events).toEqual([
      `WARN core update skipped: imported ${imported.slice(0, 8)} is not behind main`,
    ])
  })

  it('warns and continues on the old core when the status check fails', async () => {
    const imported = git(upstreamRoot, ['rev-parse', 'HEAD'])
    const upstream = advanceUpstream('version two\n')
    const statusFailureGit = (root: string, args: string[]): string => {
      if (args[0] === 'status') throw new Error('simulated status failure')
      return git(root, args)
    }

    expect(await updateDirectly(config(), { packageRoot, git: statusFailureGit })).toBe('continue')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8')).toBe('version one\n')
    expect(events).toEqual([
      'WARN core update status check failed: simulated status failure',
      `Status core behind imported ${imported.slice(0, 8)} upstream ${upstream.slice(0, 8)}; `
        + 'continuing on old code',
    ])
  })

  it('reports a successful pull that left the subtree unchanged without restarting', async () => {
    const imported = git(upstreamRoot, ['rev-parse', 'HEAD'])
    const upstream = advanceUpstream('version two\n')
    const oldHead = git(repoRoot, ['rev-parse', 'HEAD'])
    const noOpPullGit = (root: string, args: string[]): string => {
      if (args[0] === 'subtree' && args[1] === 'pull') return ''
      return git(root, args)
    }

    expect(await updateDirectly(config(), { packageRoot, git: noOpPullGit })).toBe('continue')
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(oldHead)
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8')).toBe('version one\n')
    expect(events).toEqual([
      `Status core behind imported ${imported.slice(0, 8)} upstream ${upstream.slice(0, 8)}; `
        + 'continuing on old code: pull did not change the subtree',
    ])
  })

  it('stops when a failed pull leaves a commit that recovery does not undo', async () => {
    advanceUpstream('version two\n')
    const oldHead = git(repoRoot, ['rev-parse', 'HEAD'])
    let strayHead = ''
    const movedHeadGit = (root: string, args: string[]): string => {
      if (args[0] === 'subtree' && args[1] === 'pull') {
        git(root, ['commit', '--allow-empty', '-m', 'chore: stray commit'])
        strayHead = git(root, ['rev-parse', 'HEAD'])
        throw new Error('simulated pull failure')
      }
      return git(root, args)
    }

    const failure = await updateDirectly(config(), { packageRoot, git: movedHeadGit })
      .then(() => undefined, (error: unknown) => error)

    expect(strayHead).not.toBe('')
    expect(strayHead).not.toBe(oldHead)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe(
      'core update pull failed and recovery did not restore the repository: expected HEAD '
      + `${oldHead.slice(0, 8)}, found ${strayHead.slice(0, 8)}; working tree clean`,
    )
    expect(events).toEqual([])
  })

  it('stops when a failed pull leaves a dirty tree that recovery does not clean', async () => {
    advanceUpstream('version two\n')
    const oldHead = git(repoRoot, ['rev-parse', 'HEAD'])
    const dirtyTreeGit = (root: string, args: string[]): string => {
      if (args[0] === 'subtree' && args[1] === 'pull') {
        writeFileSync(join(root, 'stray.txt'), 'stray\n')
        throw new Error('simulated pull failure')
      }
      return git(root, args)
    }

    await expect(updateDirectly(config(), { packageRoot, git: dirtyTreeGit })).rejects.toThrow(
      'core update pull failed and recovery did not restore the repository: expected HEAD '
      + `${oldHead.slice(0, 8)}, found ${oldHead.slice(0, 8)}; working tree dirty (?? stray.txt)`,
    )
    expect(git(repoRoot, ['rev-parse', 'HEAD'])).toBe(oldHead)
    expect(events).toEqual([])
  })

  it.each([
    ['rev-parse', ['rev-parse', 'HEAD']],
    ['status', ['status', '--porcelain']],
  ])('stops when a failed pull cannot verify recovery because %s fails', async (_name, failing) => {
    advanceUpstream('version two\n')
    let pullFailed = false
    const verificationFailureGit = (root: string, args: string[]): string => {
      if (args[0] === 'subtree' && args[1] === 'pull') {
        pullFailed = true
        throw new Error('simulated pull failure')
      }
      if (pullFailed && args.join(' ') === failing.join(' ')) {
        throw new Error('simulated verification failure')
      }
      return git(root, args)
    }

    await expect(updateDirectly(config(), { packageRoot, git: verificationFailureGit }))
      .rejects.toThrow(
        'core update pull failed and recovery could not be verified: '
        + 'simulated verification failure; pull failure: simulated pull failure',
      )
    expect(pullFailed).toBe(true)
    expect(events).toEqual([])
  })

  it('skips the check and the skill sync entirely when CORE_AUTO_UPDATE=false', async () => {
    advanceUpstream('version two\n')
    // A manual subtree pull changes the vendored skill sources without re-rendering them.
    writeFileSync(join(packageRoot, 'skills', 'loop-start', 'SKILL.md'), 'version two\n')
    const runtime = {
      packageRoot,
      git: vi.fn(() => { throw new Error('git must not run') }),
    }
    const loop = makeLoop(config({ CORE_AUTO_UPDATE: 'false' }), runtime)

    expect(await loop.poll()).toBe('continue')
    expect(runtime.git).not.toHaveBeenCalled()
    expect(runnerStarts).toHaveLength(1)
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8'))
      .toBe('version one\n')
    expect(readFileSync(join(repoRoot, '.agents', 'skills', 'loop-start', 'SKILL.md'), 'utf8'))
      .toBe("version one: npm run -C 'orchestration/ts' loop\n")
  })
})
