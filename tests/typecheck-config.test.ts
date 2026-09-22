import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const packageRoot = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const repositories: string[] = []

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true })
  }
})

describe('TypeScript configuration', () => {
  it('typechecks the project adapter from an installed core', () => {
    const repository = mkdtempSync(join(tmpdir(), 'orchestration-typecheck-'))
    repositories.push(repository)
    const coreRoot = join(repository, 'orchestration', 'ts')
    const adapterRoot = join(repository, 'orchestration', 'project')
    mkdirSync(join(coreRoot, 'src', 'adapters'), { recursive: true })
    mkdirSync(adapterRoot, { recursive: true })
    cpSync(join(packageRoot, 'tsconfig.json'), join(coreRoot, 'tsconfig.json'))
    cpSync(join(packageRoot, 'tsconfig.project.json'), join(coreRoot, 'tsconfig.project.json'))
    const typescriptPackage = require.resolve('typescript/package.json')
    symlinkSync(dirname(dirname(typescriptPackage)), join(coreRoot, 'node_modules'), 'junction')
    writeFileSync(
      join(coreRoot, 'src', 'adapters', 'project.ts'),
      'export interface ProjectAdapter { name: string }\n',
    )
    const adapterPath = join(adapterRoot, 'project-consumer.ts')
    writeFileSync(adapterPath, [
      "import type { ProjectAdapter } from '../ts/src/adapters/project.ts'",
      "export const project: ProjectAdapter = { name: 'consumer' }",
      '',
    ].join('\n'))
    const tsc = require.resolve('typescript/bin/tsc')

    const projectConfig = join(coreRoot, 'tsconfig.project.json')
    expect(() => execFileSync(process.execPath, [tsc, '--project', projectConfig], {
      cwd: coreRoot,
      stdio: 'pipe',
    })).not.toThrow()

    writeFileSync(adapterPath, [
      "import type { ProjectAdapter } from '../ts/src/adapters/project.ts'",
      "export const project: ProjectAdapter = { name: 42 }",
      '',
    ].join('\n'))
    const result = spawnSync(process.execPath, [tsc, '--project', projectConfig], {
      cwd: coreRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    expect(result.status).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("Type 'number' is not assignable to type 'string'")
  })
})
