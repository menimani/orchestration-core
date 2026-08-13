import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { branchAcceptsCommits, runPreCommitChecks } from '../src/preCommit.ts'
import { stubProject } from './stubProject.ts'

const repositories: string[] = []

function git(repository: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    windowsHide: true,
  }).trim()
}

interface RepositoryFixture {
  root: string
  remote: string
}

function repository(): RepositoryFixture {
  const fixture = mkdtempSync(join(tmpdir(), 'orchestration-pre-commit-'))
  const root = join(fixture, 'repository')
  const remote = join(fixture, 'origin.git')
  repositories.push(fixture)
  git(fixture, ['init', '--bare', '--initial-branch=trunk', remote])
  git(fixture, ['init', '--initial-branch=topic', root])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  writeFileSync(join(root, 'README.md'), '# test\n')
  git(root, ['add', 'README.md'])
  git(root, ['commit', '-qm', 'chore: initial commit'])
  git(root, ['remote', 'add', 'origin', remote])
  git(root, ['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'])
  git(root, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'])
  writeFileSync(join(root, 'change.ts'), 'export {}\n')
  git(root, ['add', 'change.ts'])
  return { root, remote }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('project pre-commit checks', () => {
  it('selects checks from staged paths and reports skipped checks explicitly', () => {
    const { root } = repository()
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

  it('prohibits commits to the default branch advertised by the remote', () => {
    const { root } = repository()
    git(root, ['symbolic-ref', 'HEAD', 'refs/heads/trunk'])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(branchAcceptsCommits(root)).toBe(false)
    expect(log).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      "NG: commits to 'trunk' are prohibited; it is the default branch advertised by 'origin'.",
    )
  })

  it('prohibits the newly advertised default branch when the cached HEAD is stale', () => {
    const { root, remote } = repository()
    git(root, ['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: remote, windowsHide: true,
    })
    git(root, ['branch', '-m', 'main'])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(branchAcceptsCommits(root)).toBe(false)
    expect(error).toHaveBeenCalledWith(
      "NG: commits to 'main' are prohibited; it is the default branch advertised by 'origin'.",
    )
  })

  it('fails closed when the remote default branch cannot be resolved', () => {
    const { root, remote } = repository()
    git(root, ['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'])
    rmSync(remote, { recursive: true, force: true })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(branchAcceptsCommits(root)).toBe(false)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('NG: could not resolve the repository default branch:'),
    )
  })
})
