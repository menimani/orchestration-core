import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>()
  return {
    ...actual,
    isAbsolute: (path: string) => /^[A-Za-z]:[\\/]/.test(path) || actual.isAbsolute(path),
    relative: (from: string, to: string) => to.includes('cross-drive-package')
      ? 'D:\\cross-drive-package\\src\\adapters\\project.ts'
      : actual.relative(from, to),
  }
})

const repositories: string[] = []

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true })
  }
})

it('rejects a cross-drive package before writing scaffold files', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'orchestration-cross-drive-'))
  repositories.push(repository)
  const { initializeRepository } = await import('../src/initialize.ts')
  const { orchPaths } = await import('../src/paths.ts')
  const { makeFakeForge } = await import('./fakeForge.ts')
  const paths = orchPaths(repository, false)

  await expect(initializeRepository(paths, makeFakeForge(), 'consumer', {
    packageRoot: join(repository, 'cross-drive-package'),
  })).rejects.toThrow('must be on the same filesystem volume')

  expect(existsSync(paths.root)).toBe(false)
})
