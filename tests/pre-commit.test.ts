import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  it('fails the hook when a selected check fails and still runs the checks after it', () => {
    const { root } = repository()
    const project: ProjectAdapter = {
      ...stubProject,
      preCommitChecks: [
        { label: 'Failing', cwd: '', command: 'node -e "process.exit(1)"' },
        { label: 'Passing', cwd: '', command: 'node -e "process.exit(0)"' },
      ],
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(runPreCommitChecks(root, project)).toBe(false)
    expect(log.mock.calls).toEqual([['FAIL: Failing'], ['PASS: Passing']])
  })

  it('skips a check whose required path is missing', () => {
    const { root } = repository()
    const project: ProjectAdapter = {
      ...stubProject,
      preCommitChecks: [
        { label: 'Frontend', cwd: '', command: 'node -e "process.exit(1)"', requires: 'frontend' },
      ],
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(runPreCommitChecks(root, project)).toBe(true)
    expect(log.mock.calls).toEqual([['SKIP: Frontend; missing frontend']])
  })

  it('skips a check whose unless path exists', () => {
    const { root } = repository()
    const project: ProjectAdapter = {
      ...stubProject,
      preCommitChecks: [
        { label: 'Docs', cwd: '', command: 'node -e "process.exit(1)"', unless: 'README.md' },
      ],
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(runPreCommitChecks(root, project)).toBe(true)
    expect(log.mock.calls).toEqual([['SKIP: Docs; README.md exists']])
  })

  it('fails the hook and never runs the check when its install fails', () => {
    const { root } = repository()
    const project: ProjectAdapter = {
      ...stubProject,
      preCommitChecks: [{
        label: 'Lint',
        cwd: '',
        command: `node -e "require('fs').writeFileSync('check-ran', '')"`,
        installWhenMissing: { path: 'node_modules', command: 'node -e "process.exit(1)"' },
      }],
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(runPreCommitChecks(root, project)).toBe(false)
    expect(log.mock.calls).toEqual([['FAIL: Lint install']])
    expect(existsSync(join(root, 'check-ran'))).toBe(false)
  })

  it('runs the check after its install succeeds', () => {
    const { root } = repository()
    const project: ProjectAdapter = {
      ...stubProject,
      preCommitChecks: [{
        label: 'Lint',
        cwd: '',
        command: `node -e "require('fs').writeFileSync('check-ran', '')"`,
        installWhenMissing: { path: 'node_modules', command: 'node -e "process.exit(0)"' },
      }],
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    expect(runPreCommitChecks(root, project)).toBe(true)
    expect(log.mock.calls).toEqual([['PASS: Lint install'], ['PASS: Lint']])
    expect(existsSync(join(root, 'check-ran'))).toBe(true)
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

describe('pre-commit without a project adapter', () => {
  const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')

  function preCommit(root: string) {
    mkdirSync(join(root, 'orchestration'), { recursive: true })
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => name !== 'PROJECT' && name !== 'PROJECT_ADAPTER'
        && !name.startsWith('ORCHESTRATION_')))
    return spawnSync(process.execPath, [CLI, 'pre-commit', '--repo', root], {
      cwd: root, env, encoding: 'utf8', windowsHide: true,
    })
  }

  it('keeps the branch guard and says the staged-path checks were skipped', () => {
    const { root } = repository()

    const result = preCommit(root)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('SKIP: staged-path checks; this repository has no project adapter')
  })

  it('still refuses a commit to the default branch', () => {
    const { root } = repository()
    git(root, ['switch', '--quiet', '-c', 'trunk'])

    const result = preCommit(root)

    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('SKIP: staged-path checks')
  })
})
