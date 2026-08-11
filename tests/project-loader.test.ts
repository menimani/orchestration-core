import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadProject } from '../src/adapters/project.ts'

const fixture = resolve(import.meta.dirname, 'fixtures', 'project-loader-fixture.ts')

describe('project adapter loading', () => {
  it('loads an explicit absolute PROJECT_ADAPTER path', async () => {
    const project = await loadProject({
      PROJECT: 'shiora',
      PROJECT_ADAPTER: fixture,
    })

    expect(project.deployment?.workflow).toBe('fixture.yml')
  })

  it('names the resolved path when the adapter is absent', async () => {
    const missingPath = resolve(import.meta.dirname, 'fixtures', 'project-missing.ts')

    await expect(loadProject({ PROJECT: 'missing', PROJECT_ADAPTER: missingPath })).rejects.toThrow(
      `Project adapter not found: ${missingPath}`,
    )
  })
})
