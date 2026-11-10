import { existsSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { createVitest, type Vitest } from 'vitest/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uncollectedSuites } from './platformCoverage.ts'
import { SEQUENTIAL_SUITES } from './sequentialSuites.ts'

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
    expect((sequential as { fileParallelism?: boolean }).fileParallelism).toBe(false)
    expect(sequential.maxWorkers).toBe(1)
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
})
