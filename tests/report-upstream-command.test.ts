import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { orchPaths, type OrchPaths } from '../src/paths.ts'
import {
  formatUpstreamReport, REPORT_UPSTREAM_USAGE, runReportUpstreamCommand,
  type ReportUpstreamCommandRuntime,
} from '../src/reportUpstreamCommand.ts'
import type { UpstreamReport } from '../src/reportUpstream.ts'
import { makeFakeForge } from './fakeForge.ts'

let repoRoot: string
let paths: OrchPaths

const report: UpstreamReport = {
  repository: 'configured/core',
  title: 'Core defect reported by consumer/repository',
  body: [
    '## Requirement',
    '',
    'The queue loses a finding.',
    '',
    '## Reporter',
    '',
    '- Repository: `consumer/repository`',
  ].join('\n'),
  optionalLabels: ['upstream:report'],
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'report-upstream-command-'))
  paths = orchPaths(repoRoot)
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function runtime(
  overrides: Partial<ReportUpstreamCommandRuntime> = {},
): ReportUpstreamCommandRuntime {
  return {
    stdinIsTerminal: false,
    output: vi.fn(),
    error: vi.fn(),
    confirm: vi.fn(async () => true),
    loadForge: vi.fn(async () => makeFakeForge()),
    prepareReport: vi.fn(() => report),
    ...overrides,
  }
}

describe('report-upstream command', () => {
  it('prints usage for --help and does not prepare or file a report', async () => {
    const commandRuntime = runtime()

    await expect(runReportUpstreamCommand(paths, ['--help'], commandRuntime)).resolves.toBe(0)

    expect(commandRuntime.output).toHaveBeenCalledWith(REPORT_UPSTREAM_USAGE)
    expect(commandRuntime.prepareReport).not.toHaveBeenCalled()
    expect(commandRuntime.loadForge).not.toHaveBeenCalled()
  })

  it('rejects an unrecognised flag and does not prepare or file a report', async () => {
    const commandRuntime = runtime()

    await expect(runReportUpstreamCommand(
      paths, ['--anything', 'This must not become issue text.'], commandRuntime,
    )).resolves.toBe(1)

    expect(commandRuntime.error).toHaveBeenCalledWith('ERROR: unknown option: --anything')
    expect(commandRuntime.prepareReport).not.toHaveBeenCalled()
    expect(commandRuntime.loadForge).not.toHaveBeenCalled()
  })

  it('prints on dry-run exactly the title and body that the real path sends', async () => {
    const forge = makeFakeForge()
    const dryRunRuntime = runtime()
    const liveRuntime = runtime({ loadForge: vi.fn(async () => forge) })

    await expect(runReportUpstreamCommand(
      paths, ['--dry-run', 'The queue loses a finding.'], dryRunRuntime,
    )).resolves.toBe(0)
    await expect(runReportUpstreamCommand(
      paths, ['The queue loses a finding.'], liveRuntime,
    )).resolves.toBe(0)

    expect(dryRunRuntime.output).toHaveBeenCalledOnce()
    expect(dryRunRuntime.output).toHaveBeenCalledWith(formatUpstreamReport(report))
    expect(dryRunRuntime.loadForge).not.toHaveBeenCalled()
    expect(forge.repositoryIssues).toHaveLength(1)
    expect(forge.repositoryIssues[0]).toMatchObject({
      title: report.title,
      body: report.body,
    })
  })

  it('shows the exact report at a terminal and does not load the forge when declined', async () => {
    const commandRuntime = runtime({
      stdinIsTerminal: true,
      confirm: vi.fn(async () => false),
    })

    await expect(runReportUpstreamCommand(
      paths, ['The queue loses a finding.'], commandRuntime,
    )).resolves.toBe(0)

    expect(commandRuntime.output).toHaveBeenNthCalledWith(1, formatUpstreamReport(report))
    expect(commandRuntime.output).toHaveBeenNthCalledWith(2, 'Aborted.')
    expect(commandRuntime.confirm).toHaveBeenCalledOnce()
    expect(commandRuntime.loadForge).not.toHaveBeenCalled()
  })

  it('refuses a whitespace-only description without loading the forge', async () => {
    const commandRuntime = runtime()

    await expect(runReportUpstreamCommand(paths, ['  \t  '], commandRuntime)).resolves.toBe(1)

    expect(commandRuntime.error).toHaveBeenCalledWith(
      'ERROR: the report description must not be empty or whitespace only',
    )
    expect(commandRuntime.prepareReport).not.toHaveBeenCalled()
    expect(commandRuntime.loadForge).not.toHaveBeenCalled()
  })
})
