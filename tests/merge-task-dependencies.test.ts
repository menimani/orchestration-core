// Part of the mergeTask tests, kept apart from the other parts (tests/merge.test.ts,
// tests/merge-task-cleanup.test.ts, tests/merge-task-no-change.test.ts,
// tests/merge-task-gates.test.ts and tests/merge-task-checkout.test.ts) so the parts run on
// separate workers. The describe name is the same, so reported test names do not change.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectAdapter } from '../src/adapters/project.ts'
import { MergeError, mergeTask, VerificationFailedError } from '../src/merge.ts'
import { readStatus } from '../src/status.ts'
import {
  git, installProject, makeCompletedTask, noCheckProject, paths, repoRoot,
} from './mergeHarness.ts'
import { stubProject } from './stubProject.ts'
import { nonCanonicalSpelling } from './pathComparison.ts'

describe('mergeTask', () => {
  it('installs before a merge check when its dependency path is absent', async () => {
    const taskId = '20260808_000000_008_user-needs-install'
    await makeCompletedTask(taskId, { commit: true })
    const outputFile = join(repoRoot, 'merge-check.log')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
    })

    const output = readFileSync(outputFile, 'utf8')
    const outputLines = output.split(/\r?\n/)
    expect(outputLines.filter((line) => line === 'install ran')).toHaveLength(1)
    expect(outputLines.indexOf('install ran')).toBeLessThan(outputLines.indexOf('check ran'))
    expect(outputLines).toContain('check warning')
  })

  it('rejects a check that passed on dependencies it does not have', async () => {
    const taskId = '20260808_000000_013_user-declares-uninstalled-dependency'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'fixture-dependency': '^1.0.0' },
    }, null, 2)}\n`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare a dependency nobody installed'])
    const outputFile = join(repoRoot, 'merge-check.log')

    const failure = await mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
    }).catch((error: unknown) => error)

    // The same refusal as the explicit test command's, and never a hand-back candidate.
    expect(failure).toBeInstanceOf(MergeError)
    expect(failure).not.toBeInstanceOf(VerificationFailedError)
    expect((failure as Error).message)
      .toBe('Tests passed against borrowed dependencies. Aborting merge.')
    const output = readFileSync(outputFile, 'utf8')
    expect(output).toContain('passed on dependencies it does not have')
    expect(output).toContain('fixture-dependency')
  })

  it('reports a genuine check failure ahead of another check that borrowed dependencies', async () => {
    const taskId = '20260808_000000_098_user-fails-and-borrows'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'fixture-dependency': '^1.0.0' },
    }, null, 2)}
`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare a dependency nobody installed'])
    const project: ProjectAdapter = {
      ...installProject,
      name: 'fails-and-borrows',
      mergeChecks: () => [
        { label: 'Borrowing check', cwd: '', command: 'node -e ""' },
        { label: 'Failing check', cwd: '', command: 'node -e "process.exit(1)"' },
      ],
    }

    const failure = await mergeTask(paths, taskId, { taskGate: 'light', project })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(VerificationFailedError)
    expect((failure as Error).message).toBe('Tests failed. Aborting merge.')
  })

  it('does not apply Node dependency isolation to adapters that did not opt in', async () => {
    const taskId = '20260808_000000_018_user-uses-another-package-manager'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'virtual-dependency': '^1.0.0' },
    }, null, 2)}\n`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare a virtual dependency'])
    const project: ProjectAdapter = {
      ...stubProject,
      name: 'virtual-dependencies',
      mergeChecks: () => [{ label: 'Non-Node gate', cwd: '', command: 'node -e ""' }],
    }

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light', project,
    })).resolves.toEqual({
      outcome: 'merged', mergeCommit: git(repoRoot, ['rev-parse', 'HEAD']).trim(),
    })
  })

  it('accepts a check that installs its own dependencies as its first step', async () => {
    const taskId = '20260808_000000_014_user-installs-inside-the-check'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'package.json'), `${JSON.stringify({
      name: 'fixture', devDependencies: { 'fixture-dependency': '^1.0.0' },
    }, null, 2)}\n`)
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'test: declare a dependency the check installs'])
    // The core's own gate is `npm ci && tsc && npm test` in one command: nothing is
    // installed when the check starts, and everything is by the time it ends.
    const installingProject: ProjectAdapter = {
      ...stubProject,
      name: 'installs-inside-check',
      mergeChecks: () => [{
        label: 'Fixture gate',
        cwd: '',
        command: 'node -e "const {mkdirSync,writeFileSync}=require(\'fs\');'
          + "mkdirSync('node_modules/fixture-dependency',{recursive:true});"
          + "writeFileSync('node_modules/.package-lock.json','{}')\"",
      }],
    }

    await mergeTask(paths, taskId, { taskGate: 'light', project: installingProject })

    expect(git(repoRoot, ['log', '-1', '--pretty=%s'])).toContain(taskId)
  })

  it('skips installation when the merge check dependency path is present', async () => {
    const taskId = '20260808_000000_009_user-has-dependency'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    writeFileSync(join(worktree, 'dependency-ready'), 'ready\n')
    git(worktree, ['add', 'dependency-ready'])
    git(worktree, ['commit', '-qm', 'test: add dependency fixture'])
    const outputFile = join(repoRoot, 'merge-check.log')

    await mergeTask(paths, taskId, {
      taskGate: 'light', project: installProject, outputFile,
    })

    const output = readFileSync(outputFile, 'utf8')
    expect(output).not.toContain('install ran')
    expect(output.split(/\r?\n/).filter((line) => line === 'check ran')).toHaveLength(1)
  })

  it('installs orchestration dependencies once when the merge changes package.json', async () => {
    const taskId = '20260808_000000_010_user-adds-orchestration-dependency'
    const worktree = await makeCompletedTask(taskId)
    mkdirSync(join(worktree, 'orchestration', 'ts'), { recursive: true })
    writeFileSync(join(worktree, 'orchestration', 'ts', 'package.json'), '{"dependencies":{}}\n')
    git(worktree, ['add', 'orchestration/ts/package.json'])
    git(worktree, ['commit', '-qm', 'feat: add orchestration dependency'])
    const statusDuringInstall: Array<string | undefined> = []
    const install = vi.fn(() => {
      statusDuringInstall.push(readStatus(paths, taskId)?.status)
    })
    const event = vi.fn()

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: { install, packageRoot: join(repoRoot, 'orchestration', 'ts') },
      onOrchestrationDepsEvent: event,
    })

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(join(repoRoot, 'orchestration', 'ts'))
    expect(statusDuringInstall).toEqual(['merged'])
    expect(event).toHaveBeenCalledWith(
      'Installed', 'after 010_user',
    )
  })

  it('installs orchestration dependencies when the package is at the repository root', async () => {
    const taskId = '20260808_000000_013_user-updates-root-dependency'
    const worktree = await makeCompletedTask(taskId)
    writeFileSync(join(worktree, 'package.json'), '{"dependencies":{}}\n')
    git(worktree, ['add', 'package.json'])
    git(worktree, ['commit', '-qm', 'fix: update root dependency'])
    const install = vi.fn()

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: { install, packageRoot: repoRoot },
    })

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(repoRoot)
  })

  it('installs orchestration dependencies when the package root is spelled differently from the repository', async () => {
    const taskId = '20260808_000000_014_user-updates-mis-cased-dependency'
    const worktree = await makeCompletedTask(taskId)
    mkdirSync(join(worktree, 'orchestration', 'ts'), { recursive: true })
    writeFileSync(join(worktree, 'orchestration', 'ts', 'package-lock.json'), '{}\n')
    git(worktree, ['add', 'orchestration/ts/package-lock.json'])
    git(worktree, ['commit', '-qm', 'feat: update orchestration lockfile'])
    const linkDir = mkdtempSync(join(tmpdir(), 'orch-merge-alias-'))
    const install = vi.fn()

    try {
      const packageRoot = join(nonCanonicalSpelling(repoRoot, linkDir), 'orchestration', 'ts')
      await mergeTask(paths, taskId, {
        taskGate: 'light',
        project: noCheckProject,
        orchestrationDepsRuntime: { install, packageRoot },
      })

      expect(install).toHaveBeenCalledOnce()
      expect(install).toHaveBeenCalledWith(packageRoot)
    } finally {
      rmSync(linkDir, { recursive: true, force: true })
    }
  })

  it('does not install orchestration dependencies when the merge leaves manifests unchanged', async () => {
    const taskId = '20260808_000000_011_user-changes-source'
    await makeCompletedTask(taskId, { commit: true })
    const install = vi.fn()

    await mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: { install, packageRoot: join(repoRoot, 'orchestration', 'ts') },
    })

    expect(install).not.toHaveBeenCalled()
  })

  it('persists the merge and stops when orchestration dependency installation fails', async () => {
    const taskId = '20260808_000000_012_user-adds-broken-dependency'
    const worktree = await makeCompletedTask(taskId)
    mkdirSync(join(worktree, 'orchestration', 'ts'), { recursive: true })
    writeFileSync(join(worktree, 'orchestration', 'ts', 'package-lock.json'), '{}\n')
    git(worktree, ['add', 'orchestration/ts/package-lock.json'])
    git(worktree, ['commit', '-qm', 'feat: update orchestration lockfile'])
    const event = vi.fn()

    await expect(mergeTask(paths, taskId, {
      taskGate: 'light',
      project: noCheckProject,
      orchestrationDepsRuntime: {
        install: () => { throw new Error('registry unavailable') },
        packageRoot: join(repoRoot, 'orchestration', 'ts'),
      },
      onOrchestrationDepsEvent: event,
    })).rejects.toThrow(
      `Orchestration dependency installation after 012_user failed in ${join(repoRoot, 'orchestration', 'ts')}: registry unavailable. The checkout may now be missing dependencies. Run "npm ci --no-audit --no-fund" in ${join(repoRoot, 'orchestration', 'ts')}, then restart the loop.`,
    )

    expect(event).not.toHaveBeenCalled()
    expect(readStatus(paths, taskId)?.status).toBe('merged')
  })

  it('keeps a recorded merge and cleans up when the dependency check cannot read it', async () => {
    const taskId = '20260808_000000_015_user-unreadable-merge'
    const worktree = await makeCompletedTask(taskId, { commit: true })
    const install = vi.fn()
    const events: Array<[string, string]> = []
    const previousGitDir = process.env.GIT_DIR
    const restoreGitDir = (): void => {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
    }

    try {
      const result = await mergeTask(paths, taskId, {
        taskGate: 'light',
        project: noCheckProject,
        orchestrationDepsRuntime: { install, packageRoot: join(repoRoot, 'orchestration', 'ts') },
        // Every git call the dependency check makes now fails; the warning restores git
        // so the cleanup that follows runs against the real repository.
        onMerged: () => { process.env.GIT_DIR = join(repoRoot, 'missing-git-dir') },
        onOrchestrationDepsEvent: (name, subject) => {
          restoreGitDir()
          events.push([name, subject])
        },
      })

      expect(result).toMatchObject({ outcome: 'merged' })
    } finally {
      restoreGitDir()
    }

    expect(install).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0]?.[0]).toBe('WARN')
    expect(events[0]?.[1]).toContain('could not check 015_user for orchestration dependency changes')
    expect(readStatus(paths, taskId)?.status).toBe('merged')
    expect(existsSync(worktree)).toBe(false)
    expect(git(repoRoot, ['branch', '--list', `task/${taskId}`]).trim()).toBe('')
  })
})
