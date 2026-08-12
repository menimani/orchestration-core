import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { runPreCommitChecks } from '../src/preCommit.ts'
import { stubProject } from './stubProject.ts'

const repositories: string[] = []

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim()
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-pre-commit-'))
  repositories.push(root)
  git(root, ['init', '--initial-branch=topic'])
  writeFileSync(join(root, 'change.ts'), 'export {}\n')
  git(root, ['add', 'change.ts'])
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('project pre-commit checks', () => {
  it('selects checks from staged paths and reports skipped checks explicitly', () => {
    const root = repository()
    const appliesTo = vi.fn((files: string[]) => files.includes('change.ts'))
    const project: ProjectAdapter = {
      ...stubProject,
      preCommitChecks: [
        { label: 'Selected', cwd: '', command: 'node -e "process.exit(0)"', appliesTo },
        { label: 'Skipped', cwd: '', command: 'node -e "process.exit(1)"', appliesTo: () => false },
      ],
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(runPreCommitChecks(root, project)).toBe(true)
    expect(appliesTo).toHaveBeenCalledWith(['change.ts'])
    expect(log).toHaveBeenCalledWith('PASS: Selected')
    expect(log).toHaveBeenCalledWith('SKIP: Skipped; staged paths do not apply')
  })
})
