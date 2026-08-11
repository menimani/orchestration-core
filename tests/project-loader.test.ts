import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadProject } from '../src/adapters/project.ts'

const orchestrationRoot = fileURLToPath(new URL('../../', import.meta.url))

describe('project adapter loading', () => {
  it('resolves the default adapter path from PROJECT', async () => {
    const project = await loadProject({ PROJECT: 'shiora' })

    expect(project.name).toBe('shiora')
  })

  it('prefers an explicit PROJECT_ADAPTER path', async () => {
    const project = await loadProject({
      PROJECT: 'shiora',
      PROJECT_ADAPTER: 'ts/tests/fixtures/project-loader-fixture.ts',
    })

    expect(project.deployment?.workflow).toBe('fixture.yml')
  })

  it('names the resolved path when the adapter is absent', async () => {
    const missingPath = resolve(orchestrationRoot, 'project', 'project-missing.ts')

    await expect(loadProject({ PROJECT: 'missing' })).rejects.toThrow(
      `Project adapter not found: ${missingPath}`,
    )
  })
})
