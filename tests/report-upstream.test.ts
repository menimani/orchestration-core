import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { orchPaths } from '../src/paths.ts'
import { reportUpstream, type ReportUpstreamRuntime } from '../src/reportUpstream.ts'
import { makeFakeForge } from './fakeForge.ts'

let repoRoot: string

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'report-upstream-'))
  mkdirSync(join(repoRoot, 'orchestration', 'ts'), { recursive: true })
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function writePackage(metadata: Record<string, unknown>): void {
  writeFileSync(
    join(repoRoot, 'orchestration', 'ts', 'package.json'),
    `${JSON.stringify({ name: 'consumer-orchestration', ...metadata })}\n`,
  )
}

function runtime(overrides: Partial<ReportUpstreamRuntime> = {}): ReportUpstreamRuntime {
  return {
    env: {},
    nodeVersion: 'v24.7.0',
    platform: 'linux',
    git: (_root, args) => args[0] === 'remote'
      ? 'git@github.com:consumer/reporting-repo.git\n'
      : '',
    ...overrides,
  }
}

describe('upstream defect reports', () => {
  it('composes the maintainer context and prefers a recorded subtree commit', async () => {
    writePackage({ upstreamRepo: 'configured/core', version: '1.2.3' })
    const forge = makeFakeForge()
    forge.repositoryLabels.set('configured/core', new Set(['upstream:report']))
    const commit = '0123456789abcdef0123456789abcdef01234567'

    const url = await reportUpstream(orchPaths(repoRoot), 'The queue loses a finding.', forge,
      runtime({
        git: (_root, args) => args[0] === 'remote'
          ? 'git@github.com:consumer/reporting-repo.git\n'
          : `git-subtree-dir: orchestration/ts\ngit-subtree-split: ${commit}\n`,
      }))

    expect(url).toBe('https://example.test/configured/core/issues/1')
    expect(forge.repositoryIssues).toHaveLength(1)
    expect(forge.repositoryIssues[0]).toMatchObject({
      repository: 'configured/core',
      title: 'Core defect reported by consumer/reporting-repo',
      labels: ['upstream:report'],
    })
    expect(forge.repositoryIssues[0]?.body).toBe([
      '## Description',
      '',
      'The queue loses a finding.',
      '',
      '## Reporter',
      '',
      '- Repository: `consumer/reporting-repo`',
      `- Core version: \`${commit}\``,
      '- Platform: `linux`',
      '- Node version: `v24.7.0`',
    ].join('\n'))
    expect(forge.repositoryIssues[0]?.body).not.toContain(repoRoot)
  })

  it('honours UPSTREAM_REPO over package configuration and falls back to package version', async () => {
    writePackage({ upstreamRepo: 'configured/core', version: '2.4.1' })
    const forge = makeFakeForge()

    await reportUpstream(orchPaths(repoRoot), 'A core defect.', forge,
      runtime({ env: { UPSTREAM_REPO: 'environment/core' } }))

    expect(forge.repositoryIssues[0]?.repository).toBe('environment/core')
    expect(forge.repositoryIssues[0]?.body).toContain('- Core version: `2.4.1`')
  })

  it('fails clearly when no upstream repository is configured', async () => {
    writePackage({ version: '2.4.1' })

    await expect(reportUpstream(
      orchPaths(repoRoot), 'A core defect.', makeFakeForge(), runtime(),
    )).rejects.toThrow(
      'No upstream repository is configured. Set UPSTREAM_REPO or upstreamRepo in orchestration/ts/package.json.',
    )
  })

  it('files the report without a missing optional label', async () => {
    writePackage({ upstreamRepo: 'configured/core', version: '2.4.1' })
    const forge = makeFakeForge()

    await expect(reportUpstream(
      orchPaths(repoRoot), 'A core defect.', forge, runtime(),
    )).resolves.toBe('https://example.test/configured/core/issues/1')
    expect(forge.repositoryIssues[0]?.labels).toEqual([])
  })
})
