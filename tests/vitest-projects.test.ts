import { existsSync, readdirSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { relative, resolve } from 'node:path'
import { createVitest, type Vitest } from 'vitest/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uncollectedSuites } from './platformCoverage.ts'
import {
  SEQUENTIAL_MIN_PROCESSORS, SEQUENTIAL_SUITES, SEQUENTIAL_WORKERS, SHARED_RESOURCES, sequentialProjects,
} from './sequentialSuites.ts'

const packageRoot = resolve(import.meta.dirname, '..')
let vitest: Vitest

function repositoryPath(file: string): string {
  return relative(packageRoot, file).split('\\').join('/')
}

beforeAll(async () => {
  // Resolves the repository's own configuration the way a run does, without running it.
  vitest = await createVitest('test', { root: packageRoot, watch: false })
})

afterAll(async () => {
  await vitest?.close()
})

describe('vitest projects', () => {
  it('lists only sequential suites that exist on disk', () => {
    expect(SEQUENTIAL_SUITES.length).toBeGreaterThan(0)
    for (const suite of SEQUENTIAL_SUITES) expect(existsSync(resolve(packageRoot, suite)), suite).toBe(true)
  })

  it('selects every test file in exactly one project', async () => {
    const selections = new Map<string, string[]>()
    for (const project of vitest.projects) {
      const { testFiles } = await project.globTestFiles()
      for (const file of testFiles) {
        const path = repositoryPath(file)
        selections.set(path, [...(selections.get(path) ?? []), project.name])
      }
    }
    const uncollected = new Set(uncollectedSuites())
    const testFiles = readdirSync(resolve(packageRoot, 'tests'))
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => `tests/${name}`)
    expect(testFiles.length).toBeGreaterThan(SEQUENTIAL_SUITES.length)
    for (const file of testFiles) {
      // A suite this platform cannot attempt is left out of both projects on purpose.
      if (uncollected.has(file)) {
        expect(selections.get(file), file).toBeUndefined()
        continue
      }
      const expected = SEQUENTIAL_SUITES.includes(file) ? 'sequential' : 'parallel'
      expect(selections.get(file), file).toEqual([expected])
    }
  })

  it('runs the sequential project one file at a time, after the parallel one', () => {
    const projects = new Map(vitest.projects.map((project) => [project.name, project.config]))
    expect([...projects.keys()].sort()).toEqual(['parallel', 'sequential'])
    const sequential = projects.get('sequential')!
    const parallel = projects.get('parallel')!
    // A host with SEQUENTIAL_MIN_PROCESSORS or more runs SEQUENTIAL_WORKERS files at once.
    const large = availableParallelism() >= SEQUENTIAL_MIN_PROCESSORS
    expect((sequential as { fileParallelism?: boolean }).fileParallelism).toBe(large)
    expect(sequential.maxWorkers).toBe(large ? SEQUENTIAL_WORKERS : 1)
    expect(parallel.maxWorkers).toBeGreaterThan(1)
    expect(sequential.sequence.groupOrder).toBeGreaterThan(parallel.sequence.groupOrder)
  })

  it('keeps the shared options on both projects and the global setup at the root alone', () => {
    for (const project of vitest.projects) {
      expect(project.config.setupFiles.map(repositoryPath), project.name).toEqual(['tests/gitIsolation.ts'])
      expect(project.config.testTimeout, project.name).toBe(60_000)
      expect(project.config.hookTimeout, project.name).toBe(60_000)
      expect(project.config.pool, project.name).toBe(process.platform === 'win32' ? 'threads' : 'forks')
      // A project that inherited globalSetup would print the platform report again.
      expect(project.config.globalSetup, project.name).toEqual([])
    }
    expect([vitest.config.globalSetup].flat().map(repositoryPath)).toEqual(['tests/globalSetup.ts'])
  })

  it('names only listed files under each shared resource and runs them in a later single-file group', () => {
    const projects = new Map(vitest.projects.map((project) => [project.name, project.config]))
    const shared = Object.values(SHARED_RESOURCES).flat()
    for (const file of shared) expect(SEQUENTIAL_SUITES, file).toContain(file)
    expect(projects.has('sequential-shared')).toBe(shared.length > 0)
    if (shared.length === 0) return
    const sharedProject = projects.get('sequential-shared')!
    expect(sharedProject.maxWorkers).toBe(1)
    expect(sharedProject.sequence.groupOrder).toBeGreaterThan(projects.get('sequential')!.sequence.groupOrder)
  })
})

describe('sequential projects', () => {
  const suites = ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts', 'tests/d.test.ts', 'tests/e.test.ts']
  const sharedResources = { 'named lock': ['tests/b.test.ts', 'tests/d.test.ts'], port: ['tests/d.test.ts', 'tests/e.test.ts'] }

  function includes(processors: number): Map<string, string[]> {
    return new Map(sequentialProjects(suites, sharedResources, processors)
      .map(({ test }) => [test!.name as string, test!.include!]))
  }

  it.each([4, 11, 12, 20])('puts every listed file in exactly one project at %i processors', (processors) => {
    const selected = [...includes(processors).values()].flat()
    expect([...selected].sort()).toEqual(suites)
    expect(includes(processors)).toEqual(new Map([
      ['sequential', ['tests/a.test.ts', 'tests/c.test.ts']],
      ['sequential-shared', ['tests/b.test.ts', 'tests/d.test.ts', 'tests/e.test.ts']],
    ]))
  })

  it.each([12, 20])('runs files sharing nothing on three workers at %i processors', (processors) => {
    const [sequential] = sequentialProjects(suites, sharedResources, processors)
    expect(sequential!.extends).toBe(true)
    expect(sequential!.test).toEqual({
      name: 'sequential',
      include: ['tests/a.test.ts', 'tests/c.test.ts'],
      fileParallelism: true,
      maxWorkers: 3,
      sequence: { groupOrder: 1 },
    })
  })

  it.each([4, 11, 12, 20])('never schedules files sharing a resource together at %i processors', (processors) => {
    const projects = sequentialProjects(suites, sharedResources, processors)
    expect(projects[1]).toEqual({
      extends: true,
      test: {
        name: 'sequential-shared',
        include: ['tests/b.test.ts', 'tests/d.test.ts', 'tests/e.test.ts'],
        fileParallelism: false,
        sequence: { groupOrder: 2 },
      },
    })
    // A later group starts only once the earlier one has finished, after the parallel
    // group at order 0.
    expect(projects.map(({ test }) => test!.sequence!.groupOrder)).toEqual([1, 2])
  })

  it.each([1, 4, 11])('runs every file alone below twelve processors, at %i', (processors) => {
    const projects = sequentialProjects(suites, sharedResources, processors)
    expect(projects).toHaveLength(2)
    for (const { test } of projects) {
      expect(test!.fileParallelism, test!.name as string).toBe(false)
      expect(test!.maxWorkers, test!.name as string).toBeUndefined()
    }
  })

  it('adds no shared group when no resource is shared', () => {
    expect(sequentialProjects(suites, {}, 20)).toEqual([{
      extends: true,
      test: { name: 'sequential', include: suites, fileParallelism: true, maxWorkers: 3, sequence: { groupOrder: 1 } },
    }])
    expect(sequentialProjects(suites, {}, 4)).toEqual([{
      extends: true,
      test: { name: 'sequential', include: suites, fileParallelism: false, sequence: { groupOrder: 1 } },
    }])
  })
})
