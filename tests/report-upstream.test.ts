import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseIssueBody } from '../src/issueQueue.ts'
import { orchPaths } from '../src/paths.ts'
import {
  prepareUpstreamReport, submitUpstreamReport, type ReportUpstreamRuntime,
} from '../src/reportUpstream.ts'
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
    packageRoot: join(repoRoot, 'orchestration', 'ts'),
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

    const report = prepareUpstreamReport(
      orchPaths(repoRoot), 'The queue loses a finding.', runtime({
        git: (_root, args) => args[0] === 'remote'
          ? 'git@github.com:consumer/reporting-repo.git\n'
          : `git-subtree-dir: orchestration/ts\ngit-subtree-split: ${commit}\n`,
      }),
    )
    const url = await submitUpstreamReport(report, forge)

    expect(url).toBe('https://example.test/configured/core/issues/1')
    expect(forge.repositoryIssues).toHaveLength(1)
    expect(forge.repositoryIssues[0]).toMatchObject({
      repository: 'configured/core',
      title: 'Core defect reported by consumer/reporting-repo',
      labels: ['upstream:report'],
    })
    expect(forge.repositoryIssues[0]?.body).toBe([
      '## Requirement',
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

  it('generates a body that the issue queue can materialize', () => {
    writePackage({ upstreamRepo: 'configured/core', version: '2.4.1' })

    const report = prepareUpstreamReport(
      orchPaths(repoRoot), 'The queue loses a finding.', runtime(),
    )

    expect(parseIssueBody(report.body, 41)).toMatchObject({
      fingerprint: 'issue:41',
      requirement: 'The queue loses a finding.',
    })
  })

  it('honours UPSTREAM_REPO over package configuration and falls back to package version', async () => {
    writePackage({ upstreamRepo: 'configured/core', version: '2.4.1' })
    const forge = makeFakeForge()

    const report = prepareUpstreamReport(
      orchPaths(repoRoot), 'A core defect.',
      runtime({ env: { UPSTREAM_REPO: 'environment/core' } }),
    )
    await submitUpstreamReport(report, forge)

    expect(forge.repositoryIssues[0]?.repository).toBe('environment/core')
    expect(forge.repositoryIssues[0]?.body).toContain('- Core version: `2.4.1`')
  })

  it("uses the current branch's configured remote for the reporting repository", async () => {
    writePackage({ upstreamRepo: 'configured/core', version: '2.4.1' })
    const forge = makeFakeForge()
    const gitCalls: string[][] = []

    const report = prepareUpstreamReport(
      orchPaths(repoRoot), 'A core defect.', runtime({
        git: (_root, args) => {
          gitCalls.push(args)
          if (args[0] === 'branch') return 'task/report-upstream\n'
          if (args[0] === 'config') return 'shared\n'
          if (args[0] === 'remote') return 'https://github.com/consumer/current-repo.git\n'
          return ''
        },
      }),
    )
    await submitUpstreamReport(report, forge)

    expect(gitCalls).toContainEqual(['remote', 'get-url', 'shared'])
    expect(gitCalls).not.toContainEqual(['remote', 'get-url', 'origin'])
    expect(forge.repositoryIssues[0]?.title)
      .toBe('Core defect reported by consumer/current-repo')
    expect(forge.repositoryIssues[0]?.body)
      .toContain('- Repository: `consumer/current-repo`')
  })

  it('falls back to origin when the configured branch remote has no usable URL', async () => {
    writePackage({ upstreamRepo: 'configured/core', version: '2.4.1' })
    const forge = makeFakeForge()
    const remoteCalls: string[][] = []

    const report = prepareUpstreamReport(
      orchPaths(repoRoot), 'A core defect.', runtime({
        git: (_root, args) => {
          if (args[0] === 'branch') return 'main\n'
          if (args[0] === 'config') return 'shared\n'
          if (args[0] === 'remote') {
            remoteCalls.push(args)
            if (args[2] === 'shared') throw new Error('missing remote')
            return 'git@github.com:consumer/origin-repo.git\n'
          }
          return ''
        },
      }),
    )
    await submitUpstreamReport(report, forge)

    expect(remoteCalls).toEqual([
      ['remote', 'get-url', 'shared'],
      ['remote', 'get-url', 'origin'],
    ])
    expect(forge.repositoryIssues[0]?.title)
      .toBe('Core defect reported by consumer/origin-repo')
  })

  it('reads metadata from a package that owns the repository root', async () => {
    writeFileSync(
      join(repoRoot, 'package.json'),
      `${JSON.stringify({ upstreamRepo: 'configured/core', version: '3.1.4' })}\n`,
    )
    const forge = makeFakeForge()
    const gitCalls: string[][] = []

    const report = prepareUpstreamReport(
      orchPaths(repoRoot), 'A root-package defect.', runtime({
        packageRoot: repoRoot,
        git: (_root, args) => {
          gitCalls.push(args)
          return args[0] === 'remote' ? 'git@github.com:consumer/reporting-repo.git\n' : ''
        },
      }),
    )
    await submitUpstreamReport(report, forge)

    expect(forge.repositoryIssues[0]?.repository).toBe('configured/core')
    expect(forge.repositoryIssues[0]?.body).toContain('- Core version: `3.1.4`')
    expect(gitCalls.some((args) => args[0] === 'log')).toBe(false)
  })

  it('derives the subtree history path from the package root', async () => {
    const packageRoot = join(repoRoot, 'vendor', 'core')
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({ upstreamRepo: 'configured/core', version: '2.4.1' })}\n`,
    )
    const forge = makeFakeForge()
    const commit = 'abcdef0123456789abcdef0123456789abcdef01'
    let logArgs: string[] | undefined

    const report = prepareUpstreamReport(
      orchPaths(repoRoot), 'A nested-package defect.', runtime({
        packageRoot,
        git: (_root, args) => {
          if (args[0] === 'remote') return 'git@github.com:consumer/reporting-repo.git\n'
          if (args[0] === 'log') {
            logArgs = args
            return `git-subtree-split: ${commit}\n`
          }
          return ''
        },
      }),
    )
    await submitUpstreamReport(report, forge)

    expect(logArgs?.slice(-2)).toEqual(['--', 'vendor/core'])
    expect(forge.repositoryIssues[0]?.body).toContain(`- Core version: \`${commit}\``)
  })

  it('fails clearly when no upstream repository is configured', () => {
    writePackage({ version: '2.4.1' })

    expect(() => prepareUpstreamReport(
      orchPaths(repoRoot), 'A core defect.', runtime(),
    )).toThrow(
      'No upstream repository is configured. Set UPSTREAM_REPO or upstreamRepo in package.json.',
    )
  })

  it('refuses an empty description before preparing a report', () => {
    writePackage({ upstreamRepo: 'configured/core', version: '2.4.1' })

    expect(() => prepareUpstreamReport(
      orchPaths(repoRoot), '  \n\t ', runtime(),
    )).toThrow('The report description must not be empty or whitespace only.')
  })

  it('files the report without a missing optional label', async () => {
    writePackage({ upstreamRepo: 'configured/core', version: '2.4.1' })
    const forge = makeFakeForge()

    const report = prepareUpstreamReport(orchPaths(repoRoot), 'A core defect.', runtime())

    await expect(submitUpstreamReport(report, forge))
      .resolves.toBe('https://example.test/configured/core/issues/1')
    expect(forge.repositoryIssues[0]?.labels).toEqual([])
  })
})
