import { execFileSync } from 'node:child_process'

// The generated pull request. The title reports different things depending on when it
// is read — mid-run, how many cycles are left; promoted, what landed — and both the
// title counts and the body sections come from the same commit classification, so they
// cannot disagree. The marker on the first body line is what tells a later cycle the
// text is still generated; a hand-edited body loses it and is never overwritten again.

export const GENERATED_BODY_MARKER = '<!-- marker: autonomous scan loop -->'

export type Category = 'Features' | 'Bug Fixes' | 'Security' | 'Project Operations'

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

/**
 * Estimate which screen or domain a commit changed from the files it touched. With
 * many screens the reader cannot grasp the overall picture from type alone.
 */
export function areaOfCommit(repoRoot: string, sha: string): string {
  const files = filesOfCommit(repoRoot, sha)

  for (const file of files) {
    const page = /src\/frontend\/src\/pages\/([A-Za-z]+)Page\.tsx/.exec(file)
    if (page !== null) {
      return (page[1] as string).replace(/([a-z])([A-Z])/g, '$1 $2')
    }
  }
  for (const file of files) {
    const component = /src\/frontend\/src\/components\/([a-z]+)\//.exec(file)
    if (component !== null) {
      return `${component[1]} components`
    }
  }
  for (const file of files) {
    const domain = /src\/backend\/src\/(?:main|test)\/java\/.*\/(?:service|model|integration)\/([a-z]+)\//.exec(file)
    if (domain !== null) {
      const name = domain[1] as string
      return `${name.charAt(0).toUpperCase()}${name.slice(1)} (backend)`
    }
  }

  // Prefer product code over tools, because there are commits that include both.
  if (files.some((file) => file.startsWith('src/backend/'))) return 'Backend'
  if (files.some((file) => file.startsWith('src/frontend/'))) return 'Frontend'
  if (files.some((file) => file.startsWith('orchestration/'))) return 'Orchestration'
  if (files.some((file) => file.startsWith('.github/'))) return 'CI'
  return 'Other'
}

/**
 * Sort a commit into a review-oriented section. Security is picked up first from both
 * the touched files and the subject, because with type prefixes alone a change that
 * affects authentication is buried in bug fixes.
 */
export function categoryOfCommit(repoRoot: string, sha: string, subject: string): Category {
  const files = filesOfCommit(repoRoot, sha)

  if (files.some((file) => /\/(auth|twofactor)\/|SecurityConfig\.java|\/value\/Url\.java/.test(file))
    || /escape|token|lockout|authenticat|authoriz|ownership|xss|injection|csrf|password|2fa|two-factor|permission/i.test(subject)) {
    return 'Security'
  }

  const product = files.filter((file) => !/^(orchestration\/|\.github\/)/.test(file))
  if (files.length > 0 && product.length === 0) {
    return 'Project Operations'
  }

  return subject.startsWith('feat:') ? 'Features' : 'Bug Fixes'
}

/**
 * Actual risk factors detected from the changes, as bullet points — only facts that
 * can be detected, with "None identified" when nothing applies. Boilerplate caution
 * does not help the reader decide anything.
 */
export function prRisks(repoRoot: string, decisions: string[]): string {
  const changed = git(repoRoot, ['diff', '--name-only', 'origin/main..HEAD'])
    .split(/\r?\n/).filter((line) => line !== '')
  const lines: string[] = []

  // Findings the loop deliberately did not act on belong here: an advisory still open
  // is a property of the branch as it stands, and this is the page whoever merges it
  // actually reads.
  const realDecisions = decisions.filter((decision) => decision.trim() !== '')
  if (realDecisions.length > 0) {
    lines.push('- Awaiting a decision before this branch is relied on:')
    for (const decision of realDecisions) {
      // GitHub reads a bare #N in a PR body as an issue reference and links it to some
      // unrelated pull request from the repository's first week; fencing the number
      // leaves the sentence as written and stops the link.
      lines.push(`  - ${decision.replace(/#(\d+)/g, '`#$1`')}`)
    }
  }

  if (changed.length === 0) {
    if (lines.length === 0) return '- None identified\n'
    return `${lines.join('\n')}\n`
  }

  if (changed.some((file) => file.startsWith('src/backend/src/main/resources/db/migration/'))) {
    lines.push('- Adds a Flyway migration; the schema change applies on deploy and is not automatically reversible')
  }
  if (changed.some((file) => /^src\/backend\/.*\/(auth|twofactor)\/|SecurityConfig\.java|\/value\/Url\.java/.test(file))) {
    lines.push('- Touches authentication, 2FA, or URL validation; re-check login, password reset, and any stored URLs that were valid before')
  }
  const scopingDiff = git(repoRoot, ['diff', 'origin/main..HEAD', '--',
    'src/backend/src/main/java/**/service/**', 'src/backend/src/main/java/**/repository/**'])
  if (/^[+-].*\.findBy[A-Za-z]+\(/m.test(scopingDiff)) {
    lines.push('- Changes data-scoping queries; result sets may widen or narrow for existing users')
  }
  if (changed.some((file) => /^src\/backend\/.*\/presentation\/(controller|dto)\//.test(file))) {
    lines.push('- Changes API request or response shapes; clients relying on the old contract may break')
  }
  const deletedTests = git(repoRoot, ['diff', '--name-only', '--diff-filter=D', 'origin/main..HEAD'])
    .split(/\r?\n/).filter((line) => /test|Test/.test(line))
  if (deletedTests.length > 0) {
    lines.push('- Deletes test files, removing the verification they provided:')
    for (const file of deletedTests) {
      lines.push(`  - ${file}`)
    }
  }
  if (changed.some((file) => file === 'src/backend/pom.xml' || file === 'src/frontend/vite.config.ts')) {
    lines.push('- Adjusts coverage or build configuration; the strictness of the CI gate may have changed')
  }

  if (lines.length === 0) return '- None identified\n'
  return `${lines.join('\n')}\n`
}

function branchCommits(repoRoot: string): Array<{ sha: string; subject: string }> {
  // Merge commits are excluded — "Merge xxx via Codex" gives no information.
  return git(repoRoot, ['log', 'origin/main..HEAD', '--no-merges', '--pretty=%H|%s'])
    .split(/\r?\n/).filter((line) => line !== '')
    .map((line) => {
      const sep = line.indexOf('|')
      return { sha: line.slice(0, sep), subject: line.slice(sep + 1) }
    })
}

export interface TitleContext {
  cycle: number
  maxCycles: number
}

export function prTitle(repoRoot: string, mode: 'cycle' | 'final', context: TitleContext): string {
  const prefix = 'feat: autonomous scan loop'
  if (mode !== 'final') {
    return `${prefix} — cycle ${context.cycle}/${context.maxCycles}`
  }

  const counts = new Map<Category, number>()
  for (const { sha, subject } of branchCommits(repoRoot)) {
    const category = categoryOfCommit(repoRoot, sha, subject)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }

  // Project Operations is counted but never shown: the number of tooling commits does
  // not help anyone decide whether to review. Plurals are irregular, so both spellings
  // are carried — "fix" + "s" gives "fixs".
  const specs: Array<{ key: Category; singular: string; plural: string }> = [
    { key: 'Features', singular: 'feature', plural: 'features' },
    { key: 'Bug Fixes', singular: 'fix', plural: 'fixes' },
    { key: 'Security', singular: 'security fix', plural: 'security fixes' },
  ]
  const parts: string[] = []
  for (const { key, singular, plural } of specs) {
    const n = counts.get(key) ?? 0
    if (n === 0) continue
    parts.push(n === 1 ? `1 ${singular}` : `${n} ${plural}`)
  }
  if (parts.length === 0) {
    return `${prefix} — tooling and documentation only`
  }
  return `${prefix} — ${parts.join(', ')}`
}

export function buildPrBody(repoRoot: string, decisions: string[]): string {
  git(repoRoot, ['fetch', 'origin', 'main', '--quiet'])

  const sections = new Map<Category, string[]>()
  for (const { sha, subject } of branchCommits(repoRoot)) {
    const category = categoryOfCommit(repoRoot, sha, subject)
    const area = areaOfCommit(repoRoot, sha)
    // The type prefix is dropped: the section heading already says it. A screen name on
    // a tooling change would be meaningless, so those go without the area label.
    const bullet = subject.replace(/^[a-z]+: /, '')
    const entry = category === 'Project Operations' || area === 'Other'
      ? `- ${bullet}`
      : `- [${area}] ${bullet}`
    sections.set(category, [...(sections.get(category) ?? []), entry])
  }

  // No summary section: the headings and their bullets are the summary. Headings are
  // published even when empty, because "none" is information for the reader too.
  let body = `${GENERATED_BODY_MARKER}\n`
  for (const label of ['Features', 'Bug Fixes', 'Security', 'Project Operations'] as Category[]) {
    const entries = sections.get(label)
    body += `\n## ${label}\n\n${entries === undefined ? '- None\n' : `${entries.join('\n')}\n`}`
  }
  body += `\n## Risks\n\n${prRisks(repoRoot, decisions)}`
  return body
}
