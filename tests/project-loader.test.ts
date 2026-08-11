import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProject } from '../src/adapters/project.ts'

const fixture = resolve(import.meta.dirname, 'fixtures', 'project-loader-fixture.ts')
const loaderSource = resolve(import.meta.dirname, '..', 'src', 'adapters', 'project.ts')

const fixtureRepositories: string[] = []

afterEach(() => {
  for (const repository of fixtureRepositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true })
  }
})

function createFixtureRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'project-loader-'))
  fixtureRepositories.push(repository)
  return repository
}

function writeFixtureAdapter(adapterPath: string, workflow: string, name = 'fixture'): void {
  mkdirSync(dirname(adapterPath), { recursive: true })
  writeFileSync(adapterPath, `
export const fixtureProject = {
  name: '${name}',
  pullRequest: {
    categories: [{ label: 'Changes' }],
    titleFallback: 'no changes',
    classifyCommit: () => ({ category: 'Changes' }),
    detectRisks: () => [],
  },
  deployment: {
    workflow: '${workflow}',
    revisionUrl: 'https://example.com/fixture-revision',
  },
  mergeChecks: () => [],
  cycleSuite: () => [],
}
`)
}

async function loadFromFixtureRepository(packagePath: string): Promise<string | undefined> {
  const repository = createFixtureRepository()
  const packageRoot = resolve(repository, packagePath)
  const loaderPath = join(packageRoot, 'src', 'adapters', 'project.ts')
  mkdirSync(dirname(loaderPath), { recursive: true })
  copyFileSync(loaderSource, loaderPath)

  const orchestrationRoot = join(repository, 'orchestration')
  const adapterPath = join(orchestrationRoot, 'project', 'project-fixture.ts')
  writeFixtureAdapter(
    adapterPath,
    relative(repository, packageRoot).replaceAll('\\', '/') || 'repository-root',
  )

  const fixtureLoader = await import(pathToFileURL(loaderPath).href) as typeof import(
    '../src/adapters/project.ts'
  )
  const project = await fixtureLoader.loadProject(orchestrationRoot, { PROJECT: 'fixture' })
  return project.deployment?.workflow
}

describe('project adapter loading', () => {
  it('discovers the only adapter when PROJECT is unset', async () => {
    const repository = createFixtureRepository()
    const orchestrationRoot = join(repository, 'orchestration')
    writeFixtureAdapter(
      join(orchestrationRoot, 'project', 'project-fixture.ts'),
      'discovered.yml',
    )

    const project = await loadProject(orchestrationRoot, {})

    expect(project.deployment?.workflow).toBe('discovered.yml')
  })

  it('fails discovery with the names of both adapters', async () => {
    const repository = createFixtureRepository()
    const orchestrationRoot = join(repository, 'orchestration')
    const projectDirectory = join(orchestrationRoot, 'project')
    writeFixtureAdapter(join(projectDirectory, 'project-alpha.ts'), 'alpha.yml', 'alpha')
    writeFixtureAdapter(join(projectDirectory, 'project-beta.ts'), 'beta.yml', 'beta')

    await expect(loadProject(orchestrationRoot, {})).rejects.toThrow(
      `Could not discover project adapter in ${projectDirectory}: found project-alpha.ts, project-beta.ts. `
      + 'Expected exactly one project-*.ts file; PROJECT selects between them.',
    )
  })

  it('fails discovery with the empty project directory path', async () => {
    const repository = createFixtureRepository()
    const orchestrationRoot = join(repository, 'orchestration')
    const projectDirectory = join(orchestrationRoot, 'project')
    mkdirSync(projectDirectory, { recursive: true })

    await expect(loadProject(orchestrationRoot, {})).rejects.toThrow(
      `Could not discover project adapter in ${projectDirectory}: found (none). `
      + 'Expected exactly one project-*.ts file; PROJECT selects between them.',
    )
  })

  it('uses PROJECT when multiple adapters are present', async () => {
    const repository = createFixtureRepository()
    const orchestrationRoot = join(repository, 'orchestration')
    const projectDirectory = join(orchestrationRoot, 'project')
    writeFixtureAdapter(join(projectDirectory, 'project-alpha.ts'), 'alpha.yml', 'alpha')
    writeFixtureAdapter(join(projectDirectory, 'project-beta.ts'), 'beta.yml', 'beta')

    const project = await loadProject(orchestrationRoot, { PROJECT: 'beta' })

    expect(project.deployment?.workflow).toBe('beta.yml')
  })

  it('resolves the adapter when the package is under orchestration/ts', async () => {
    await expect(loadFromFixtureRepository('orchestration/ts')).resolves.toBe('orchestration/ts')
  })

  it('resolves the adapter when the package is at the repository root', async () => {
    await expect(loadFromFixtureRepository('')).resolves.toBe('repository-root')
  })

  it('loads an explicit absolute PROJECT_ADAPTER path', async () => {
    const project = await loadProject(import.meta.dirname, {
      PROJECT_ADAPTER: fixture,
    })

    expect(project.deployment?.workflow).toBe('fixture.yml')
  })

  it('resolves a relative PROJECT_ADAPTER from the orchestration root', async () => {
    const repository = createFixtureRepository()
    const orchestrationRoot = join(repository, 'orchestration')
    writeFixtureAdapter(join(orchestrationRoot, 'custom', 'project-fixture.ts'), 'relative.yml')

    const project = await loadProject(orchestrationRoot, {
      PROJECT: 'fixture',
      PROJECT_ADAPTER: 'custom/project-fixture.ts',
    })

    expect(project.deployment?.workflow).toBe('relative.yml')
  })

  it('names the resolved path when the adapter is absent', async () => {
    const missingPath = resolve(import.meta.dirname, 'fixtures', 'project-missing.ts')

    await expect(loadProject(import.meta.dirname, {
      PROJECT: 'missing',
      PROJECT_ADAPTER: missingPath,
    })).rejects.toThrow(
      `Project adapter not found: ${missingPath}`,
    )
  })
})
