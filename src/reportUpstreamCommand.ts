import type { Forge } from './adapters/forge.ts'
import type { OrchPaths } from './paths.ts'
import {
  prepareUpstreamReport, submitUpstreamReport, type UpstreamReport,
} from './reportUpstream.ts'

export const REPORT_UPSTREAM_USAGE = 'Usage: report-upstream [--dry-run] "<description>"'

export interface ReportUpstreamCommandRuntime {
  stdinIsTerminal: boolean
  output(message: string): void
  error(message: string): void
  confirm(): Promise<boolean>
  loadForge(): Promise<Forge>
  prepareReport?(paths: OrchPaths, description: string): UpstreamReport
}

export function formatUpstreamReport(report: UpstreamReport): string {
  return [
    'Title:',
    report.title,
    '',
    'Body:',
    report.body,
  ].join('\n')
}

export async function runReportUpstreamCommand(
  paths: OrchPaths,
  args: string[],
  runtime: ReportUpstreamCommandRuntime,
): Promise<number> {
  let description: string | undefined
  let dryRun = false
  let help = false

  for (const arg of args) {
    if (arg === '--help') {
      help = true
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg.startsWith('-')) {
      runtime.error(`ERROR: unknown option: ${arg}`)
      runtime.error(REPORT_UPSTREAM_USAGE)
      return 1
    } else if (description !== undefined) {
      runtime.error('ERROR: only one description is accepted; quote it as a single argument')
      runtime.error(REPORT_UPSTREAM_USAGE)
      return 1
    } else {
      description = arg
    }
  }

  if (help) {
    runtime.output(REPORT_UPSTREAM_USAGE)
    return 0
  }
  if (description === undefined || description.trim() === '') {
    runtime.error('ERROR: the report description must not be empty or whitespace only')
    runtime.error(REPORT_UPSTREAM_USAGE)
    return 1
  }

  const report = (runtime.prepareReport ?? prepareUpstreamReport)(paths, description)
  const rendered = formatUpstreamReport(report)
  if (dryRun) {
    runtime.output(rendered)
    return 0
  }
  if (runtime.stdinIsTerminal) {
    runtime.output(rendered)
    if (!await runtime.confirm()) {
      runtime.output('Aborted.')
      return 0
    }
  }

  const forge = await runtime.loadForge()
  runtime.output(await submitUpstreamReport(report, forge))
  return 0
}
