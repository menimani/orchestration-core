import { execFileSync } from 'node:child_process'
import {
  appendFileSync, copyFileSync, cpSync, existsSync, mkdtempSync, realpathSync, rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Forge } from '../src/adapters/forge.ts'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { makeFakeForge } from './fakeForge.ts'
import { fakeRunnerSharedSkills } from './fakeRunner.ts'

const packageRoot = resolve(import.meta.dirname, '..')
const fixtureRoot = resolve(import.meta.dirname, 'fixtures', 'consumer')
const repositories: string[] = []

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true })
  }
})

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

function createConsumerRepository(): string {
  // Canonical, because the runner's temp path carries an 8.3 short name when the
  // account name is long and the paths the package reports do not.
  const repository = realpathSync.native(mkdtempSync(join(tmpdir(), 'orchestration-consumer-')))
  repositories.push(repository)

  cpSync(fixtureRoot, repository, { recursive: true })
  rmSync(
    join(repository, 'orchestration', 'project', 'project-consumer.ts'),
    { force: true },
  )
  const installedPackage = join(repository, 'orchestration', 'ts')
  cpSync(join(packageRoot, 'src'), join(installedPackage, 'src'), { recursive: true })
  cpSync(join(packageRoot, 'scaffold'), join(installedPackage, 'scaffold'), { recursive: true })
  cpSync(join(packageRoot, '.githooks'), join(installedPackage, '.githooks'), { recursive: true })
  copyFileSync(join(packageRoot, 'package.json'), join(installedPackage, 'package.json'))
  copyFileSync(join(packageRoot, 'package-lock.json'), join(installedPackage, 'package-lock.json'))

  git(repository, ['init', '--initial-branch=main'])
  git(repository, ['config', 'user.email', 'consumer-smoke@example.test'])
  git(repository, ['config', 'user.name', 'Consumer Smoke'])
  git(repository, ['add', '-A'])
  git(repository, ['commit', '-m', 'chore: create consumer fixture'])
  git(repository, ['checkout', '-b', 'consumer-smoke'])
  return repository
}

function referencedPaths(project: ProjectAdapter): string[] {
  const paths: string[] = []
  const record = (step: {
    cwd: string
    requires?: string
    installWhenMissing?: { path: string }
    repairWhenMissing?: { path: string }
  }): void => {
    if (step.cwd !== '') paths.push(step.cwd)
    if (step.requires !== undefined) paths.push(step.requires)
    if (step.installWhenMissing !== undefined) paths.push(step.installWhenMissing.path)
    if (step.repairWhenMissing !== undefined) paths.push(step.repairWhenMissing.path)
  }
  for (const step of project.preCommitChecks) record(step)
  for (const step of project.scanWorktreeSetup ?? []) record(step)
  for (const step of project.mergeChecks('full')) record(step)
  for (const step of project.cycleSuite()) record(step)
  return [...new Set(paths)]
}

describe('consumer startup', () => {
  it('resolves a restart from the installed package while operating on its parent repository', async () => {
    const repository = createConsumerRepository()
    const installedPackage = join(repository, 'orchestration', 'ts')
    const restartModule = await import(pathToFileURL(
      join(installedPackage, 'src', 'restart.ts'),
    ).href) as typeof import('../src/restart.ts')
    const markerLog = join(repository, 'orchestration', 'logs', 'loop-markers.log')
    const invocation = [
      process.execPath,
      join('orchestration', 'ts', 'src', 'cli.ts'),
      'loop',
      '--marker-output',
      markerLog,
    ]

    const command = restartModule.loopRestartCommand(invocation)

    expect(command.cwd).toBe(installedPackage)
    expect(command.args).toEqual([
      join(installedPackage, 'src', 'cli.ts'),
      ...invocation.slice(2),
    ])
    expect(isAbsolute(command.args[0]!)).toBe(true)
  })

  it('discovers a consumer adapter and reaches the first poll', async () => {
    const repository = createConsumerRepository()
    expect(git(repository, ['branch', '--show-current'])).toBe('consumer-smoke')
    expect(git(repository, ['rev-list', '--count', 'HEAD'])).toBe('1')

    const installedPackage = join(repository, 'orchestration', 'ts')
    const projectModule = await import(pathToFileURL(
      join(installedPackage, 'src', 'adapters', 'project.ts'),
    ).href) as typeof import('../src/adapters/project.ts')
    const pathsModule = await import(pathToFileURL(
      join(installedPackage, 'src', 'paths.ts'),
    ).href) as typeof import('../src/paths.ts')
    const configModule = await import(pathToFileURL(
      join(installedPackage, 'src', 'config.ts'),
    ).href) as typeof import('../src/config.ts')
    const loopModule = await import(pathToFileURL(
      join(installedPackage, 'src', 'loop.ts'),
    ).href) as typeof import('../src/loop.ts')

    const initializeModule = await import(pathToFileURL(
      join(installedPackage, 'src', 'initialize.ts'),
    ).href) as typeof import('../src/initialize.ts')
    const initialized = await initializeModule.initializeRepository(
      pathsModule.orchPaths(repository),
      makeFakeForge(),
      'consumer',
      { packageRoot: installedPackage, report: () => {} },
    )
    expect(initialized.ok).toBe(true)
    appendFileSync(initialized.adapterPath, `
import { consumerFixture } from './consumer-fixture.ts'
project.scanWorktreeSetup = consumerFixture.scanWorktreeSetup
project.mergeChecks = () => consumerFixture.mergeChecks
project.cycleSuite = () => consumerFixture.cycleSuite
`)

    const project = await projectModule.loadProject(join(repository, 'orchestration'), {})
    expect(project.name).toBe('consumer')
    const fixturePaths = referencedPaths(project)
    expect(fixturePaths).toEqual([
      'orchestration/project/scripts/ensure-environment.ts',
      'orchestration/ts',
      'orchestration/ts/package.json',
    ])
    for (const fixturePath of fixturePaths) {
      expect(existsSync(join(repository, fixturePath)), fixturePath).toBe(true)
    }

    const forgeCalls: string[] = []
    const forge = new Proxy(makeFakeForge(), {
      get(target, property, receiver) {
        const member = Reflect.get(target, property, receiver) as unknown
        if (typeof member !== 'function') return member
        return (...args: unknown[]) => {
          forgeCalls.push(String(property))
          return Reflect.apply(member, target, args)
        }
      },
    }) as Forge
    const runnerStart = vi.fn(async () => process.pid)
    const logs: string[] = []
    const paths = pathsModule.orchPaths(repository)
    const config = configModule.loadConfig({
      AUTO_MERGE: 'false',
      AUTO_PR: 'false',
      CORE_AUTO_UPDATE: 'false',
      ISSUE_QUEUE_ENABLED: 'false',
      REVIEW_ENABLED: 'false',
      SCAN_ENABLED: 'false',
    })
    const loop = loopModule.createLoop({
      paths,
      config,
      forge,
      runner: { sharedSkills: fakeRunnerSharedSkills, start: runnerStart },
      project,
      log: (line) => logs.push(line),
      now: () => new Date('2026-08-12T00:00:00Z'),
    })

    loop.initializeSessionStateForBranch()
    await expect(loop.poll()).resolves.toBe('done')
    expect(logs).not.toContain('Status Running=0  Queue=0')
    expect(runnerStart).not.toHaveBeenCalled()
    expect(forgeCalls).toEqual([])
  })
})
