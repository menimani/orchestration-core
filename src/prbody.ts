import { execFileSync } from 'node:child_process'
import type { ProjectAdapter, PullRequestChanges } from './adapters/project.ts'

// The generated pull request. The title reports different things depending on when it
// is read — mid-run, how many cycles are left; promoted, what landed — and both the
// title counts and the body sections come from the same commit classification, so they
// cannot disagree. The marker on the first body line is what tells a later cycle the
// text is still generated; a hand-edited body loses it and is never overwritten again.

export const GENERATED_BODY_MARKER = '<!-- marker: autonomous scan loop -->'

function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    })
  } catch {
    return ''
  }
}

function filesOfCommit(repoRoot: string, sha: string): string[] {
  return git(repoRoot, ['show', '--name-only', '--pretty=format:', sha])
    .split(/\r?\n/).filter((line) => line !== '')
}

export function prRisks(
  project: ProjectAdapter,
  repoRoot: string,
  baseRef: string,
  decisions: string[],
): string {
  const comparison = `${baseRef}..HEAD`
  const changed = git(repoRoot, ['diff', '--name-only', comparison])
    .split(/\r?\n/).filter((line) => line !== '')
  const lines: string[] = []

  // Findings the loop deliberately did not act on belong here: an advisory still open
  // is a property of the branch as it stands, and this is the page whoever merges it
  // actually reads.
  const realDecisions = decisions.filter((decision) => decision.trim() !== '')
  if (realDecisions.length > 0) {
    lines.push('- Awaiting a decision before this branch is relied on:')
    for (const decision of realDecisions) {
      lines.push(`  - ${decision}`)
    }
  }

  const changes: PullRequestChanges = {
    files: changed,
    deletedFiles: git(repoRoot, ['diff', '--name-only', '--diff-filter=D', comparison])
      .split(/\r?\n/).filter((line) => line !== ''),
    diff: (pathspecs = []) => git(repoRoot, ['diff', comparison, '--', ...pathspecs]),
  }
  for (const risk of project.pullRequest.detectRisks(changes)) lines.push(`- ${risk}`)

  if (lines.length === 0) return '- None identified\n'
  return `${lines.join('\n')}\n`
}

function branchCommits(repoRoot: string, baseRef: string): Array<{ sha: string; subject: string }> {
  // Merge commits are excluded — "Merge xxx via orchestration" gives no information.
  return git(repoRoot, ['log', `${baseRef}..HEAD`, '--no-merges', '--pretty=%H|%s'])
    .split(/\r?\n/).filter((line) => line !== '')
    .map((line) => {
      const sep = line.indexOf('|')
      return { sha: line.slice(0, sep), subject: line.slice(sep + 1) }
    })
}

interface TitleContext {
  cycle: number
  maxCycles: number
}

export function prTitle(
  project: ProjectAdapter,
  repoRoot: string,
  baseRef: string,
  mode: 'cycle' | 'final',
  context: TitleContext,
): string {
  const prefix = 'feat: autonomous scan loop'
  if (mode !== 'final') {
    return `${prefix} — cycle ${context.cycle}/${context.maxCycles}`
  }

  const counts = new Map<string, number>()
  for (const { sha, subject } of branchCommits(repoRoot, baseRef)) {
    const category = project.pullRequest.classifyCommit({
      subject,
      files: filesOfCommit(repoRoot, sha),
    }).category
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }

  const parts: string[] = []
  for (const { label, title } of project.pullRequest.categories) {
    if (title === undefined) continue
    const n = counts.get(label) ?? 0
    if (n > 0) parts.push(n === 1 ? `1 ${title.singular}` : `${n} ${title.plural}`)
  }
  if (parts.length === 0) {
    return `${prefix} — ${project.pullRequest.titleFallback}`
  }
  return `${prefix} — ${parts.join(', ')}`
}

export function buildPrBody(
  project: ProjectAdapter,
  repoRoot: string,
  baseRef: string,
  decisions: string[],
): string {
  const sections = new Map<string, string[]>()
  for (const { sha, subject } of branchCommits(repoRoot, baseRef)) {
    const { category, area } = project.pullRequest.classifyCommit({
      subject,
      files: filesOfCommit(repoRoot, sha),
    })
    // The type prefix is dropped: the section heading already says it. A screen name on
    // a tooling change would be meaningless, so those go without the area label.
    const bullet = subject.replace(/^[a-z]+: /, '')
    const entry = area === undefined ? `- ${bullet}` : `- [${area}] ${bullet}`
    sections.set(category, [...(sections.get(category) ?? []), entry])
  }

  // No summary section: the headings and their bullets are the summary. Headings are
  // published even when empty, because "none" is information for the reader too.
  let body = `${GENERATED_BODY_MARKER}\n`
  for (const { label } of project.pullRequest.categories) {
    const entries = sections.get(label)
    body += `\n## ${label}\n\n${entries === undefined ? '- None\n' : `${entries.join('\n')}\n`}`
  }
  body += `\n## Risks\n\n${prRisks(project, repoRoot, baseRef, decisions)}`
  return body
}
