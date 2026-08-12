import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { buildPrBody, GENERATED_BODY_MARKER, prRisks, prTitle } from '../src/prbody.ts'

let repoRoot: string
const baseRef = 'origin/trunk'

const project: ProjectAdapter = {
  preCommitChecks: [],
  name: 'fixture',
  mergeChecks: () => [],
  cycleSuite: () => [],
  pullRequest: {
    categories: [
      { label: 'Features', title: { singular: 'feature', plural: 'features' } },
      { label: 'Bug Fixes', title: { singular: 'fix', plural: 'fixes' } },
      { label: 'Security', title: { singular: 'security fix', plural: 'security fixes' } },
      { label: 'Project Operations' },
    ],
    titleFallback: 'tooling and documentation only',
    classifyCommit({ subject, files }) {
      const security = files.some((file) =>
        /\/(auth|twofactor)\/|SecurityConfig\.java|\/value\/Url\.java/.test(file))
        || /escape|token|lockout|authenticat|authoriz|ownership|xss|injection|csrf|password|2fa|two-factor|permission/i.test(subject)
      let category = subject.startsWith('feat:') ? 'Features' : 'Bug Fixes'
      if (security) category = 'Security'
      else if (files.length > 0
        && files.every((file) => /^(orchestration\/|\.github\/)/.test(file))) {
        category = 'Project Operations'
      }

      for (const file of files) {
        const page = /src\/frontend\/src\/pages\/([A-Za-z]+)Page\.tsx/.exec(file)
        if (page !== null) {
          return { category, area: page[1]!.replace(/([a-z])([A-Z])/g, '$1 $2') }
        }
      }
      if (category === 'Project Operations') return { category }
      if (files.some((file) => file.startsWith('src/backend/'))) return { category, area: 'Backend' }
      if (files.some((file) => file.startsWith('src/frontend/'))) return { category, area: 'Frontend' }
      return { category }
    },
    detectRisks({ files, deletedFiles, diff }) {
      const risks: string[] = []
      if (files.some((file) => file.startsWith('src/backend/src/main/resources/db/migration/'))) {
        risks.push('Adds a Flyway migration; the schema change applies on deploy and is not automatically reversible')
      }
      if (files.some((file) => /^src\/backend\/.*\/(auth|twofactor)\/|SecurityConfig\.java|\/value\/Url\.java/.test(file))) {
        risks.push('Touches authentication, 2FA, or URL validation; re-check login, password reset, and any stored URLs that were valid before')
      }
      if (/^[+-].*\.findBy[A-Za-z]+\(/m.test(diff([
        'src/backend/src/main/java/**/service/**',
        'src/backend/src/main/java/**/repository/**',
      ]))) {
        risks.push('Changes data-scoping queries; result sets may widen or narrow for existing users')
      }
      if (files.some((file) => /^src\/backend\/.*\/presentation\/(controller|dto)\//.test(file))) {
        risks.push('Changes API request or response shapes; clients relying on the old contract may break')
      }
      const deletedTests = deletedFiles.filter((file) => /test/i.test(file))
      if (deletedTests.length > 0) {
        risks.push(`Deletes test files, removing the verification they provided:\n${deletedTests.map((file) => `  - ${file}`).join('\n')}`)
      }
      if (files.some((file) => file === 'src/backend/pom.xml' || file === 'src/frontend/vite.config.ts')) {
        risks.push('Adjusts coverage or build configuration; the strictness of the CI gate may have changed')
      }
      return risks
    },
  },
}

function git(args: string[]): void {
  execFileSync('git', args, { cwd: repoRoot })
}

function commitFile(path: string, subject: string): void {
  const full = join(repoRoot, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, `${subject}\n`)
  git(['add', path])
  git(['commit', '-q', '-m', subject])
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'orch-prbody-'))
  git(['init', '-q'])
  git(['config', 'user.name', 'PR Body Test'])
  git(['config', 'user.email', 'pr-body-test@example.com'])
  git(['config', 'core.autocrlf', 'false'])
  commitFile('README.md', 'Initial commit')
  git(['branch', '-M', 'trunk'])
  // No real remote: the remote-tracking ref is planted directly, as the bash test did.
  git(['update-ref', `refs/remotes/${baseRef}`, 'trunk'])
})

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
})

function sectionOf(body: string, heading: string): string {
  const lines = body.split('\n')
  const start = lines.indexOf(`## ${heading}`)
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return rest.slice(0, end === -1 ? undefined : end).join('\n')
}

describe('buildPrBody', () => {
  it('marks an empty branch with the marker, all sections and - None', () => {
    const body = buildPrBody(project, repoRoot, baseRef, [])
    expect(body.split('\n')[0]).toBe(GENERATED_BODY_MARKER)
    for (const section of ['Features', 'Bug Fixes', 'Security', 'Project Operations']) {
      expect(sectionOf(body, section)).toContain('- None')
    }
    expect(body.split('\n').filter((line) => line.startsWith('## ')))
      .toEqual(['## Features', '## Bug Fixes', '## Security', '## Project Operations', '## Risks'])
  })

  it('classifies commits into sections with area labels and drops merge commits', () => {
    commitFile('src/frontend/src/pages/SettingsPage.tsx', 'feat: add preferences')
    commitFile('src/backend/src/main/java/jp/menimani/shiora/application/service/auth/Foo.java', 'fix: validate session')
    commitFile('orchestration/fixture.txt', 'chore: update automation')
    git(['switch', '-q', '-c', 'merge-source'])
    commitFile('docs/merge-source.txt', 'docs: merge payload')
    git(['switch', '-q', 'trunk'])
    commitFile('docs/mainline.txt', 'fix: mainline preparation')
    git(['merge', '--no-ff', '-q', 'merge-source', '-m', 'Merge fixture branch'])

    const body = buildPrBody(project, repoRoot, baseRef, [])
    expect(body).toContain('- [Settings] add preferences')
    expect(sectionOf(body, 'Security')).toContain('validate session')
    expect(sectionOf(body, 'Project Operations')).toContain('update automation')
    expect(body).not.toContain('Merge fixture branch')
  })
})

describe('prTitle', () => {
  beforeEach(() => {
    commitFile('src/frontend/src/pages/SettingsPage.tsx', 'feat: add preferences')
    commitFile('src/backend/src/main/java/jp/menimani/shiora/application/service/auth/Foo.java', 'fix: validate session')
    commitFile('orchestration/fixture.txt', 'chore: update automation')
    commitFile('docs/merge-source.txt', 'docs: merge payload')
    commitFile('docs/mainline.txt', 'fix: mainline preparation')
  })

  it('reports cycle progress while cycles run', () => {
    expect(prTitle(project, repoRoot, baseRef, 'cycle', { cycle: 3, maxCycles: 12 }))
      .toBe('feat: autonomous scan loop — cycle 3/12')
  })

  it('summarises the diff by category once finished, without the tooling count', () => {
    // 1 feature, 2 fixes (the docs: commit counts as one), 1 security change and one
    // tooling change that is deliberately absent from the title.
    expect(prTitle(project, repoRoot, baseRef, 'final', { cycle: 3, maxCycles: 12 }))
      .toBe('feat: autonomous scan loop — 1 feature, 2 fixes, 1 security fix')
  })

  it('says so when a run changed nothing in the product', () => {
    git(['switch', '-q', '-c', 'tooling-only'])
    git(['update-ref', `refs/remotes/${baseRef}`, 'HEAD'])
    commitFile('orchestration/only.txt', 'chore: adjust the loop')
    expect(prTitle(project, repoRoot, baseRef, 'final', { cycle: 3, maxCycles: 12 }))
      .toBe('feat: autonomous scan loop — tooling and documentation only')
  })
})

describe('prRisks', () => {
  it('reports None identified for a branch with no risk signals', () => {
    commitFile('docs/safe.txt', 'docs: harmless change')
    expect(prRisks(project, repoRoot, baseRef, [])).toBe('- None identified\n')
  })

  it('preserves issue-number-like references in decisions', () => {
    const risks = prRisks(project, repoRoot, baseRef, ['Dependabot alert #1 stays open pending a major bump'])
    expect(risks).toContain('Dependabot alert #1 stays open pending a major bump')
    expect(risks).not.toContain('`#1`')
    expect(risks).toContain('- Awaiting a decision before this branch is relied on:')
  })

  it('detects a migration and deleted tests', () => {
    // The deleted file must exist at the base — a file added and deleted within the
    // branch does not appear in an endpoint diff at all.
    commitFile('src/frontend/src/pages/OldPage.test.tsx', 'test: exists on main')
    git(['update-ref', `refs/remotes/${baseRef}`, 'HEAD'])
    commitFile('src/backend/src/main/resources/db/migration/V99__add_col.sql', 'feat: add column')
    git(['rm', '-q', 'src/frontend/src/pages/OldPage.test.tsx'])
    git(['commit', '-qm', 'chore: drop the old test'])
    const risks = prRisks(project, repoRoot, baseRef, [])
    expect(risks).toContain('Flyway migration')
    expect(risks).toContain('- Deletes test files, removing the verification they provided:')
    expect(risks).toContain('  - src/frontend/src/pages/OldPage.test.tsx')
  })
})
