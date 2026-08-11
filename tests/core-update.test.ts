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
import { createLoop } from '../src/loop.ts'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import { makeFakeForge } from './fakeForge.ts'
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
) {
  mkdirSync(join(paths.root, 'templates'), { recursive: true })
  writeFileSync(join(paths.root, 'templates', 'scan-template.md'), '{{SCAN_SCOPE}}\n')
  const runner: Runner = {
    start: async (options) => {
      runnerStarts.push(options.specFile)
      return process.pid
    },
  }
  const loop = createLoop({
    paths,
    config: coreConfig,
    forge: makeFakeForge() as Forge,
    runner,
    project: stubProject,
    log: (line) => events.push(line),
    now: () => new Date(2026, 7, 12, 0, 0, 0),
    updateCoreBeforeCycle: (cycle) =>
      updateCoreBeforeCycle(paths, coreConfig, cycle, event as CoreUpdateEvent, runtime),
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
  paths = orchPaths(repoRoot)
  events = []
  runnerStarts = []
})

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true })
})

describe('pre-cycle core update', () => {
  it('pulls a behind subtree and requests re-exec before starting the cycle', async () => {
    const oldCore = git(upstreamRoot, ['rev-parse', 'HEAD'])
    const newCore = advanceUpstream('version two\n')
    const loop = makeLoop(config())

    expect(await loop.poll(), events.join('\n')).toBe('restart')
    expect(readFileSync(join(packageRoot, 'core.txt'), 'utf8').replaceAll('\r', ''))
      .toBe('version two\n')
    expect(existsSync(join(paths.queueDir, 'scan-count.txt'))).toBe(false)
    expect(runnerStarts).toHaveLength(0)
    expect(events).toContain(`Updated core ${oldCore.slice(0, 8)}..${newCore.slice(0, 8)}`)
    expect(events).toContain('Restarting core for cycle 1')
  })

  it('starts the cycle without pulling or restarting when the subtree is current', async () => {
    const loop = makeLoop(config())

    expect(await loop.poll()).toBe('continue')
    expect(runnerStarts).toHaveLength(1)
    expect(readFileSync(join(paths.queueDir, 'scan-count.txt'), 'utf8')).toBe('1\n')
    expect(events.some((line) => /^(Updated|Restarting) core/.test(line))).toBe(false)
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
