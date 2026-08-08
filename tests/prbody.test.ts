import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPrBody, GENERATED_BODY_MARKER, prRisks, prTitle } from '../src/prbody.ts'

let repoRoot: string

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
  git(['branch', '-M', 'main'])
  // No real remote: the origin/main ref is planted directly, as the bash test did.
  git(['update-ref', 'refs/remotes/origin/main', 'main'])
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
    const body = buildPrBody(repoRoot, [])
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
    git(['switch', '-q', 'main'])
    commitFile('docs/mainline.txt', 'fix: mainline preparation')
    git(['merge', '--no-ff', '-q', 'merge-source', '-m', 'Merge fixture branch'])

    const body = buildPrBody(repoRoot, [])
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
    expect(prTitle(repoRoot, 'cycle', { cycle: 3, maxCycles: 12 }))
      .toBe('feat: autonomous scan loop — cycle 3/12')
  })

  it('summarises the diff by category once finished, without the tooling count', () => {
    // 1 feature, 2 fixes (the docs: commit counts as one), 1 security change and one
    // tooling change that is deliberately absent from the title.
    expect(prTitle(repoRoot, 'final', { cycle: 3, maxCycles: 12 }))
      .toBe('feat: autonomous scan loop — 1 feature, 2 fixes, 1 security fix')
  })

  it('says so when a run changed nothing in the product', () => {
    git(['switch', '-q', '-c', 'tooling-only'])
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    commitFile('orchestration/only.txt', 'chore: adjust the loop')
    expect(prTitle(repoRoot, 'final', { cycle: 3, maxCycles: 12 }))
      .toBe('feat: autonomous scan loop — tooling and documentation only')
  })
})

describe('prRisks', () => {
  it('reports None identified for a branch with no risk signals', () => {
    commitFile('docs/safe.txt', 'docs: harmless change')
    expect(prRisks(repoRoot, [])).toBe('- None identified\n')
  })

  it('fences issue-number-like references in decisions', () => {
    const risks = prRisks(repoRoot, ['Dependabot alert #1 stays open pending a major bump'])
    expect(risks).toContain('`#1`')
    expect(risks).toContain('- Awaiting a decision before this branch is relied on:')
  })

  it('detects a migration and deleted tests', () => {
    // The deleted file must exist at origin/main — a file added and deleted within the
    // branch does not appear in an endpoint diff at all.
    commitFile('src/frontend/src/pages/OldPage.test.tsx', 'test: exists on main')
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    commitFile('src/backend/src/main/resources/db/migration/V99__add_col.sql', 'feat: add column')
    git(['rm', '-q', 'src/frontend/src/pages/OldPage.test.tsx'])
    git(['commit', '-qm', 'chore: drop the old test'])
    const risks = prRisks(repoRoot, [])
    expect(risks).toContain('Flyway migration')
    expect(risks).toContain('- Deletes test files, removing the verification they provided:')
    expect(risks).toContain('  - src/frontend/src/pages/OldPage.test.tsx')
  })
})
