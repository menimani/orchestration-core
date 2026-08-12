import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProject } from '../src/adapters/project.ts'
import { initializeRepository } from '../src/initialize.ts'
import { QUEUE_LABELS } from '../src/issueQueue.ts'
import { orchPaths } from '../src/paths.ts'
import { makeFakeForge } from './fakeForge.ts'

const packageRoot = resolve(import.meta.dirname, '..')
const repositories: string[] = []

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function fixture(): { repository: string; installedPackage: string } {
  const repository = mkdtempSync(join(tmpdir(), 'orchestration-init-'))
  repositories.push(repository)
  git(repository, ['init', '--initial-branch=main'])
  const installedPackage = join(repository, 'orchestration', 'ts')
  cpSync(join(packageRoot, 'scaffold'), join(installedPackage, 'scaffold'), { recursive: true })
  cpSync(join(packageRoot, '.githooks'), join(installedPackage, '.githooks'), { recursive: true })
  return { repository, installedPackage }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true })
  }
})

describe('repository initialization', () => {
  it('generates a loadable adapter from the runtime contract and installs missing setup', async () => {
    const { repository, installedPackage } = fixture()
    const forge = makeFakeForge()
    forge.labels.add('loop:finding')
    const reports: string[] = []

    const result = await initializeRepository(orchPaths(repository), forge, 'Example App', {
      packageRoot: installedPackage,
      report: (line) => reports.push(line),
    })

    expect(result.ok).toBe(true)
    expect(result.projectName).toBe('example-app')
    await expect(loadProject(join(repository, 'orchestration'), {})).resolves.toMatchObject({
      name: 'example-app',
      preCommitChecks: [],
    })
    expect(git(repository, ['config', '--local', '--get', 'core.hooksPath']))
      .toBe('orchestration/ts/.githooks')
    expect(existsSync(join(repository, 'orchestration', 'templates', 'scan-template.md'))).toBe(true)
    expect(forge.labels).toEqual(new Set(QUEUE_LABELS.map((label) => label.name)))
    expect(reports).toContain('EXISTS: label loop:finding')
    expect(reports).toContain('CREATED: label loop:ready')
    expect(reports).toContain('PASS: core.hooksPath is orchestration/ts/.githooks')
  })

  it('leaves project-owned files unchanged when repaired', async () => {
    const { repository, installedPackage } = fixture()
    const forge = makeFakeForge()
    const paths = orchPaths(repository)
    await initializeRepository(paths, forge, 'consumer', { packageRoot: installedPackage })
    const adapter = join(repository, 'orchestration', 'project', 'project-consumer.ts')
    const scan = join(repository, 'orchestration', 'templates', 'scan-template.md')
    writeFileSync(adapter, '// custom adapter\n')
    writeFileSync(scan, 'custom scan\n')
    const reports: string[] = []

    const result = await initializeRepository(paths, forge, 'consumer', {
      packageRoot: installedPackage,
      report: (line) => reports.push(line),
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(adapter, 'utf8')).toBe('// custom adapter\n')
    expect(readFileSync(scan, 'utf8')).toBe('custom scan\n')
    expect(reports).toContain(`EXISTS: ${adapter} (left unchanged)`)
    expect(reports).toContain(`EXISTS: ${scan} (left unchanged)`)
  })

  it('reports a deliberately different hooks path without overwriting it', async () => {
    const { repository, installedPackage } = fixture()
    git(repository, ['config', '--local', 'core.hooksPath', '.custom-hooks'])
    const reports: string[] = []

    const result = await initializeRepository(
      orchPaths(repository), makeFakeForge(), 'consumer',
      { packageRoot: installedPackage, report: (line) => reports.push(line) },
    )

    expect(result.ok).toBe(false)
    expect(git(repository, ['config', '--local', '--get', 'core.hooksPath']))
      .toBe('.custom-hooks')
    expect(reports).toContain(
      'DIVERGED: core.hooksPath=.custom-hooks (expected orchestration/ts/.githooks; left unchanged)',
    )
    expect(reports).toContain(
      'FAIL: core.hooksPath is .custom-hooks; expected orchestration/ts/.githooks',
    )
  })
})
